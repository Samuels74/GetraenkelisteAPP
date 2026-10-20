/**
 * Samples the PocketBase process and the machine while a scenario runs.
 *
 * - PocketBase CPU (utime + stime from /proc/<pid>/stat) and RSS (VmRSS from
 *   /proc/<pid>/status), every 250 ms: mean CPU over the window, the peak of
 *   1-second windows, RSS at the start / end / maximum.
 * - The whole machine (/proc/stat): busy CPU of all processes minus
 *   PocketBase minus this Node process = CPU used by *other* processes. The
 *   load generator and the server share the machine with whatever else runs
 *   on it (another test, a browser, a build); when others use several cores
 *   the numbers are less trustworthy, and the report says so.
 * - Database file sizes (data.db, auxiliary.db with their WAL files) – the
 *   request log in auxiliary.db grows with every request.
 *
 * Linux only (procfs); elsewhere the sampler reports nothing instead of
 * failing.
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Clock ticks per second of /proc (USER_HZ; 100 on Linux on all common architectures). */
const TICKS_PER_SECOND = 100;
const MIB = 1024 * 1024;

interface ProcSample {
  t: number;
  /** PocketBase utime + stime in ticks. */
  pbTicks: number;
  /** This process (all threads) utime + stime in ticks. */
  selfTicks: number;
  /** All CPUs: busy and total ticks. */
  machineBusy: number;
  machineTotal: number;
  rssKiB: number;
}

function processTicks(pid: number | 'self'): number {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  // the command name may contain spaces and parentheses: split after the last ')'
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return Number(fields[11]) + Number(fields[12]);
}

function rssKiB(pid: number): number {
  const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
  return match ? Number(match[1]) : NaN;
}

function machineTicks(): { busy: number; total: number } {
  const line = readFileSync('/proc/stat', 'utf8').split('\n', 1)[0] ?? '';
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map(Number);
  const busy = user + nice + system + irq + softirq + steal;
  return { busy, total: busy + idle + iowait };
}

export interface ServerStats {
  durationMs: number;
  /** PocketBase CPU, mean over the window, % of one core (100 = one core busy). */
  cpuMeanPct: number;
  /** Highest PocketBase CPU of any 1-second window, % of one core. */
  cpuPeakPct: number;
  rssStartMiB: number;
  rssEndMiB: number;
  rssMaxMiB: number;
  /** Mean busy cores of the whole machine. */
  machineBusyCores: number;
  /** Mean busy cores of other processes (machine − PocketBase − the load generator). */
  otherBusyCores: number;
  /** Mean busy cores of the load-generator process (all its threads). */
  clientCores: number;
}

export class ProcessSampler {
  private readonly pid: number;
  private readonly intervalMs: number;
  private readonly samples: ProcSample[] = [];
  private timer: NodeJS.Timeout | undefined;
  private available = true;

  constructor(pid: number, intervalMs = 250) {
    this.pid = pid;
    this.intervalMs = intervalMs;
  }

  private sample(): void {
    if (!this.available) return;
    try {
      const machine = machineTicks();
      this.samples.push({
        t: performance.timeOrigin + performance.now(),
        pbTicks: processTicks(this.pid),
        selfTicks: processTicks('self'),
        machineBusy: machine.busy,
        machineTotal: machine.total,
        rssKiB: rssKiB(this.pid),
      });
    } catch {
      this.available = false; // no procfs, or the process is gone
    }
  }

  start(): this {
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    this.timer.unref();
    return this;
  }

  /** Stops sampling; statistics over the whole sampling period or over [from, to] (absolute ms). */
  stop(range?: { from: number; to: number }): ServerStats | null {
    clearInterval(this.timer);
    this.sample();
    return this.stats(range);
  }

  /** Statistics over [from, to] (absolute ms; default: everything sampled). */
  stats(range?: { from: number; to: number }): ServerStats | null {
    if (!this.available) return null;
    const samples = range
      ? this.samples.filter((s, i, all) => {
          // the samples enclosing the range: the last one before `from` up to the first one after `to`
          const next = all[i + 1];
          const prev = all[i - 1];
          return (s.t >= range.from || (next !== undefined && next.t > range.from)) && (s.t <= range.to || (prev !== undefined && prev.t < range.to));
        })
      : this.samples;
    const first = samples[0];
    const last = samples.at(-1);
    if (!first || !last || last === first) return null;
    const wallS = (last.t - first.t) / 1000;
    const cores = (ticks: number) => ticks / TICKS_PER_SECOND / wallS;
    const machineCpus = (last.machineTotal - first.machineTotal) / TICKS_PER_SECOND / wallS;
    // /proc/stat counts all CPUs: busy share × number of CPUs = busy cores
    const machineBusyCores =
      last.machineTotal > first.machineTotal
        ? ((last.machineBusy - first.machineBusy) / (last.machineTotal - first.machineTotal)) * machineCpus
        : 0;
    const pbCores = cores(last.pbTicks - first.pbTicks);
    const clientCores = cores(last.selfTicks - first.selfTicks);

    // peak: the busiest span of ≥ 1 s between two samples
    let peak = 0;
    for (let i = 1; i < samples.length; i++) {
      const end = samples[i] as ProcSample;
      let k = i - 1;
      while (k > 0 && end.t - (samples[k] as ProcSample).t < 1000) k--;
      const begin = samples[k] as ProcSample;
      const span = (end.t - begin.t) / 1000;
      if (span >= 0.9) peak = Math.max(peak, ((end.pbTicks - begin.pbTicks) / TICKS_PER_SECOND / span) * 100);
    }
    if (peak === 0) peak = pbCores * 100; // window shorter than a second
    const rss = samples.map((s) => s.rssKiB).filter(Number.isFinite);
    const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
    return {
      durationMs: Math.round(last.t - first.t),
      cpuMeanPct: round(pbCores * 100, 0),
      cpuPeakPct: round(peak, 0),
      rssStartMiB: round(first.rssKiB / 1024),
      rssEndMiB: round(last.rssKiB / 1024),
      rssMaxMiB: round(Math.max(...rss) / 1024),
      machineBusyCores: round(machineBusyCores, 2),
      otherBusyCores: round(Math.max(0, machineBusyCores - pbCores - clientCores), 2),
      clientCores: round(clientCores, 2),
    };
  }
}

export interface DbFileSizes {
  /** Sizes in MiB (0 when the file does not exist). */
  data: number;
  dataWal: number;
  auxiliary: number;
  auxiliaryWal: number;
}

export function dbFileSizes(dataDir: string): DbFileSizes {
  const size = (file: string) => {
    try {
      return Math.round((statSync(path.join(dataDir, file)).size / MIB) * 100) / 100;
    } catch {
      return 0;
    }
  };
  return {
    data: size('data.db'),
    dataWal: size('data.db-wal'),
    auxiliary: size('auxiliary.db'),
    auxiliaryWal: size('auxiliary.db-wal'),
  };
}
