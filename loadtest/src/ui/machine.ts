/**
 * CPU use of the machine while the browser checks run – to tell whether a
 * timing was taken while other processes competed with the browser.
 *
 * Every ≈500 ms the monitor closes a window with the average number of busy
 * cores of
 *   machine  the CPUs the checks can run on (/proc/stat, restricted to the
 *            cgroup's cpuset when there is one; with a cgroup CPU quota the
 *            cgroup's own usage, i.e. what counts against the quota),
 *   own      this process and all its descendants – PocketBase and the
 *            browser with its renderers (/proc/<pid>/stat utime + stime +
 *            cutime + cstime, so exited children are counted too),
 *   foreign  machine − own: everything else.
 * The scenarios register every measured interval (cold load, keystroke, tap
 * …); a timing counts as contaminated when a window overlapping it had more
 * foreign load than `limit` cores. The limit scales with the machine – a
 * quarter of its capacity, at least one core: 4 of 16 cores, 1 of 4 – and an
 * idle machine stays far below it (the checks' own 0.2–2.2 cores are not
 * foreign). It is informational: it never changes a verdict.
 *
 * Without /proc (macOS) the own share is unknown; then 2 cores of the
 * machine's load are assumed to be the checks' own.
 */
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';

export interface CpuWindow {
  /** epoch ms */
  from: number;
  to: number;
  /** average busy cores */
  machine: number;
  own: number | null;
  /** machine − own (estimated when own is unknown) */
  foreign: number;
}

const TICK_MS = 10; // USER_HZ = 100 on Linux
const ASSUMED_OWN_CORES = 2;

const read = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/** "0-3,8-11" → [0, 1, 2, 3, 8, 9, 10, 11] */
function parseCpuList(list: string): number[] {
  const cpus: number[] = [];
  for (const part of list.trim().split(',')) {
    const [a, b] = part.split('-').map(Number);
    if (a === undefined || Number.isNaN(a)) continue;
    for (let cpu = a; cpu <= (b ?? a); cpu++) cpus.push(cpu);
  }
  return cpus;
}

interface Capacity {
  cores: number;
  /** cgroup v2 CPU quota in cores, if limited */
  quota: number | null;
  /** CPUs of the cgroup's cpuset, if restricted */
  cpuset: number[] | null;
}

/** The CPU capacity the checks can use: CPU affinity, cgroup cpuset and CPU quota (cgroup v2). */
export function cpuCapacity(): Capacity {
  let cores = os.availableParallelism();
  let quota: number | null = null;
  const max = read('/sys/fs/cgroup/cpu.max')?.trim().split(/\s+/);
  if (max && max[0] !== 'max' && max[0] !== undefined && max[1] !== undefined) {
    quota = Number(max[0]) / Number(max[1]);
    if (Number.isFinite(quota) && quota > 0) cores = Math.min(cores, quota);
    else quota = null;
  }
  const cpusetText = read('/sys/fs/cgroup/cpuset.cpus.effective');
  const cpuset = cpusetText ? parseCpuList(cpusetText) : null;
  if (cpuset && cpuset.length > 0) cores = Math.min(cores, cpuset.length);
  return { cores, quota, cpuset: cpuset && cpuset.length > 0 ? cpuset : null };
}

/** Busy CPU time (ms) of the CPUs in `cpus` (all when null) from /proc/stat, else os.cpus(). */
function machineBusyMs(cpus: number[] | null): number {
  const stat = read('/proc/stat');
  if (stat) {
    let busy = 0;
    for (const line of stat.split('\n')) {
      const match = /^cpu(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      if (cpus && !cpus.includes(Number(match[1]))) continue;
      // user nice system idle iowait irq softirq steal …
      const [user = 0, nice = 0, system = 0, , , irq = 0, softirq = 0, steal = 0] = (match[2] ?? '').split(/\s+/).map(Number);
      busy += user + nice + system + irq + softirq + steal;
    }
    return busy * TICK_MS;
  }
  let busy = 0;
  for (const { times } of os.cpus()) busy += times.user + times.nice + times.sys + times.irq;
  return busy;
}

/** CPU time (ms) used by the cgroup (v2) – everything that counts against its quota. */
function cgroupBusyMs(): number | null {
  const match = /usage_usec (\d+)/.exec(read('/sys/fs/cgroup/cpu.stat') ?? '');
  return match ? Number(match[1]) / 1000 : null;
}

/** CPU time (ms) of this process and all its descendants (Linux), or null. */
export function ownTreeBusyMs(): number | null {
  if (process.platform !== 'linux') return null;
  const procs = new Map<number, { ppid: number; ticks: number }>();
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = read(`/proc/${entry}/stat`);
    if (!stat) continue; // exited meanwhile
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // fields[1] = ppid, [11..14] = utime, stime, cutime, cstime
    const ticks = [11, 12, 13, 14].reduce((sum, i) => sum + Number(fields[i] ?? 0), 0);
    procs.set(Number(entry), { ppid: Number(fields[1]), ticks });
  }
  const tree = new Set([process.pid]);
  for (let grown = true; grown; ) {
    grown = false;
    for (const [pid, { ppid }] of procs) {
      if (!tree.has(pid) && tree.has(ppid)) {
        tree.add(pid);
        grown = true;
      }
    }
  }
  let ticks = 0;
  for (const pid of tree) ticks += procs.get(pid)?.ticks ?? 0;
  return ticks * TICK_MS;
}

export class CpuMonitor {
  readonly capacity: Capacity;
  /** Foreign busy cores above which a timing counts as taken on a busy machine. */
  readonly limit: number;
  private readonly windows: CpuWindow[] = [];
  private timer: NodeJS.Timeout | undefined;
  private last: { at: number; machine: number; own: number | null } | null = null;

  constructor() {
    this.capacity = cpuCapacity();
    this.limit = Math.max(1, Math.round(this.capacity.cores * 0.25 * 10) / 10);
  }

  private sample(): { at: number; machine: number; own: number | null } {
    const machine = this.capacity.quota !== null ? (cgroupBusyMs() ?? machineBusyMs(this.capacity.cpuset)) : machineBusyMs(this.capacity.cpuset);
    return { at: Date.now(), machine, own: ownTreeBusyMs() };
  }

  /** Closes the current window (also called at the end of a scenario variant). */
  tick(): void {
    const now = this.sample();
    const last = this.last;
    this.last = now;
    if (!last || now.at - last.at < 50) return;
    const wall = now.at - last.at;
    const machine = Math.max(0, (now.machine - last.machine) / wall);
    const own = now.own !== null && last.own !== null ? Math.max(0, (now.own - last.own) / wall) : null;
    const foreign = own !== null ? Math.max(0, machine - own) : Math.max(0, machine - ASSUMED_OWN_CORES);
    this.windows.push({ from: last.at, to: now.at, machine, own, foreign });
    if (this.windows.length > 20_000) this.windows.splice(0, 10_000);
  }

  start(intervalMs = 500): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The window with the most foreign load that overlaps [from, to] (epoch ms). */
  worst(from: number, to: number): CpuWindow | null {
    let worst: CpuWindow | null = null;
    for (const window of this.windows) {
      if (window.to <= from || window.from >= to) continue;
      if (!worst || window.foreign > worst.foreign) worst = window;
    }
    return worst;
  }

  /** Time-weighted average over [from, to]. */
  average(from: number, to: number): { machine: number; own: number | null; foreign: number } | null {
    let weight = 0;
    let machine = 0;
    let own = 0;
    let ownKnown = true;
    let foreign = 0;
    for (const window of this.windows) {
      const overlap = Math.min(window.to, to) - Math.max(window.from, from);
      if (overlap <= 0) continue;
      weight += overlap;
      machine += window.machine * overlap;
      foreign += window.foreign * overlap;
      if (window.own === null) ownKnown = false;
      else own += window.own * overlap;
    }
    if (weight === 0) return null;
    const round1 = (value: number) => Math.round(value * 10) / 10;
    return { machine: round1(machine / weight), own: ownKnown ? round1(own / weight) : null, foreign: round1(foreign / weight) };
  }
}
