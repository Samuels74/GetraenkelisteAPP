/**
 * The environment of a run for results.json / report.md: when, which code
 * (git commit + whether the working tree differs from it), which machine,
 * which Node / PocketBase, and how busy the machine was at the start and at
 * the end (load average) – numbers from a shared or busy machine are worth
 * less, and a later reader must be able to tell.
 */
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { REPO_ROOT } from '../paths.ts';

const run = promisify(execFile);

export interface Environment {
  date: string;
  timeZone: string;
  host: {
    cpuModel: string;
    logicalCpus: number;
    memoryGiB: number;
    os: string;
  };
  node: string;
  pocketbase: string;
  git: {
    commit: string;
    branch: string;
    /** Tracked files differ from the commit, or untracked files exist (besides .devcontainer). */
    dirty: boolean;
    changedFiles: number;
  };
  /** os.loadavg() (1, 5, 15 min) at the start and at the end of the run. */
  loadavg: { start: number[]; end?: number[] };
}

async function git(args: string[]): Promise<string> {
  try {
    return (await run('git', args, { cwd: REPO_ROOT, timeout: 10_000 })).stdout.trim();
  } catch {
    return '';
  }
}

export async function collectEnvironment(pbBin: string): Promise<Environment> {
  let pocketbase = 'unknown';
  try {
    pocketbase = (await run(pbBin, ['--version'], { timeout: 10_000 })).stdout.trim().replace(/^pocketbase version\s*/i, '');
  } catch {
    // reported as unknown
  }
  const status = (await git(['status', '--porcelain'])).split('\n').filter((line) => line && !line.endsWith(' .devcontainer'));
  const cpus = os.cpus();
  return {
    date: new Date().toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    host: {
      cpuModel: cpus[0]?.model.trim() ?? 'unknown',
      logicalCpus: os.availableParallelism(),
      memoryGiB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
      os: `${os.type()} ${os.release()} (${os.arch()})`,
    },
    node: process.version,
    pocketbase,
    git: {
      commit: (await git(['rev-parse', 'HEAD'])) || 'unknown',
      branch: (await git(['rev-parse', '--abbrev-ref', 'HEAD'])) || 'unknown',
      dirty: status.length > 0,
      changedFiles: status.length,
    },
    loadavg: { start: os.loadavg().map((value) => Math.round(value * 100) / 100) },
  };
}
