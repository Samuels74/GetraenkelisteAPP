/**
 * A pid lock file (`make loadtest-dev`'s .pb/loadtest-dev.pid), released only
 * by its owner.
 *
 * - Created atomically with its content: the pid is written to a private
 *   temp file, which is then hard-linked into place – the link fails if a
 *   lock exists, and a lock is never seen empty.
 * - A stale lock (its process is gone) is removed only under a takeover
 *   mutex (`<lock>.takeover`, created the same way), after re-reading that it
 *   still holds the stale pid. While it exists nobody can create a lock, so
 *   the removal can never hit a fresh lock of another start; afterwards the
 *   starts race on the atomic create again and exactly one wins. A mutex left
 *   behind by a crashed start (its process gone, older than 3 s) is removed.
 */
import { existsSync, linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface PidLockOptions {
  /** Whether `pid` belongs to a living holder of this lock (another start of the same tool). */
  isHolder(pid: number): boolean;
  /** The error for "held by `pid`". */
  inUse(pid: number): Error;
}

const STALE_MUTEX_MS = 3_000;
const GIVE_UP_MS = 10_000;

/** The pid in a lock file (0: missing or unreadable). */
function lockPid(file: string): number {
  try {
    const pid = Number(readFileSync(file, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

function unlinkQuietly(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // already gone
  }
}

/** Synchronous pause (a lock is taken before anything else runs). */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Creates `file` with this process's pid, atomically; false if it exists. */
function create(file: string): boolean {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${process.pid}\n`);
  try {
    linkSync(temp, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    unlinkQuietly(temp);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Takes the lock or throws (`options.inUse`, or "could not take" when other starts keep racing for 10 s). */
export function acquirePidLock(file: string, options: PidLockOptions): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const mutex = `${file}.takeover`;
  const deadline = Date.now() + GIVE_UP_MS;
  while (Date.now() < deadline) {
    if (create(file)) return;
    const pid = lockPid(file);
    if (pid > 0 && pid !== process.pid && options.isHolder(pid)) throw options.inUse(pid);
    // stale (or gone meanwhile): remove it under the takeover mutex
    if (!create(mutex)) {
      const owner = lockPid(mutex);
      let age = 0;
      try {
        age = Date.now() - statSync(mutex).mtimeMs;
      } catch {
        // released meanwhile
      }
      if (owner > 0 && !alive(owner) && age > STALE_MUTEX_MS) unlinkQuietly(mutex); // left by a crashed start
      pause(20);
      continue;
    }
    try {
      // still the stale lock we judged? (a lock exists → nobody can create one until it is gone)
      if (existsSync(file) && lockPid(file) === pid) unlinkQuietly(file);
    } finally {
      unlinkQuietly(mutex);
    }
  }
  throw new Error(`could not take ${file} – is another start running right now?`);
}

/** Removes the lock if this process holds it. */
export function releasePidLock(file: string): void {
  try {
    if (readFileSync(file, 'utf8').trim() === String(process.pid)) unlinkSync(file);
  } catch {
    // already gone
  }
}
