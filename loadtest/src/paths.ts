/**
 * Paths of the repository parts a load-test instance is built from, and the
 * guard for every directory the load test creates and deletes again.
 *
 * The same environment variables as the API and E2E test harnesses override
 * the defaults (docs/ARCHITECTURE.md §3 "npm script contract"), so the load
 * test can also run against a PocketBase binary / SPA build placed elsewhere
 * (e.g. inside a container). Relative values are resolved against the current
 * working directory, like in the other harnesses.
 *
 * Deleting is only possible for directories this package created itself:
 * createOwnedDir() writes a marker file, removeOwnedDir() refuses directories
 * without it. Both also require an allowed location (below the OS temp dir or
 * below <repo>/.pb – also when .pb is a symlink to another disk –, never the
 * repository's sources) – compared on real paths, so a symlinked ancestor
 * cannot smuggle a source directory in.
 */
import { existsSync, realpathSync } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** `loadtest/` */
export const LOADTEST_DIR = path.resolve(import.meta.dirname, '..');
/** The repository root. */
export const REPO_ROOT = path.resolve(LOADTEST_DIR, '..');
/** Test-only `*.pb.js` files copied next to the app hooks of load-test instances. */
export const SUPPORT_DIR = path.join(LOADTEST_DIR, 'support');
/** The app hooks of the repository – never written to or deleted, whatever PB_HOOKS_DIR says. */
export const APP_HOOKS_DIR = path.join(REPO_ROOT, 'backend', 'pb_hooks');
/** `.pb/` (gitignored): PocketBase binary and local data dirs. */
export const PB_HOME = path.join(REPO_ROOT, '.pb');
/** Marker file in every directory created by createOwnedDir(). */
export const OWNED_DIR_MARKER = '.getraenkeliste-loadtest';

export interface InstancePaths {
  /** PocketBase binary (`scripts/dev-pocketbase.sh --download-only` puts it into `.pb/`). */
  pbBin: string;
  migrationsDir: string;
  /** The app hooks; copied into the instance's own hooks dir together with SUPPORT_DIR. */
  hooksDir: string;
  /** The built SPA (`cd frontend && npm run build`). */
  publicDir: string;
}

function fromEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value ? path.resolve(process.cwd(), value) : fallback;
}

export function defaultPaths(): InstancePaths {
  return {
    pbBin: fromEnv('PB_BIN', path.join(REPO_ROOT, '.pb', 'pocketbase')),
    migrationsDir: fromEnv('PB_MIGRATIONS_DIR', path.join(REPO_ROOT, 'backend', 'pb_migrations')),
    hooksDir: fromEnv('PB_HOOKS_DIR', path.join(REPO_ROOT, 'backend', 'pb_hooks')),
    publicDir: fromEnv('PB_PUBLIC_DIR', path.join(REPO_ROOT, 'frontend', 'dist')),
  };
}

/** Human-readable problems with the given paths (empty when everything is in place). */
export function checkPaths(paths: InstancePaths): string[] {
  const problems: string[] = [];
  if (!existsSync(paths.pbBin)) {
    problems.push(`PocketBase binary not found: ${paths.pbBin} (run scripts/dev-pocketbase.sh --download-only)`);
  }
  if (!existsSync(paths.migrationsDir)) problems.push(`migrations dir not found: ${paths.migrationsDir}`);
  if (!existsSync(paths.hooksDir)) problems.push(`hooks dir not found: ${paths.hooksDir}`);
  if (!existsSync(path.join(paths.publicDir, 'index.html'))) {
    problems.push(`no SPA build in ${paths.publicDir} (run: cd frontend && npm run build)`);
  }
  return problems;
}

/** Path relative to the repository root for messages (absolute if outside of it). */
export function displayPath(target: string): string {
  const relative = path.relative(REPO_ROOT, target);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : target;
}

// ---------------------------------------------------------------------------
// Owned directories

/** Real path of `target`: symlinks of its existing part resolved, the missing rest appended. */
export function realPath(target: string): string {
  let existing = path.resolve(target);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(existing), ...missing);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return path.resolve(target);
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/** Whether `inner` is `outer` itself or lies inside it (plain path comparison). */
export function isSameOrInside(inner: string, outer: string): boolean {
  const relative = path.relative(outer, inner);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isStrictlyInside(inner: string, outer: string): boolean {
  return inner !== outer && isSameOrInside(inner, outer);
}

/**
 * Throws unless the load test may create and later delete `dir`:
 * - below <repo>/.pb, wherever .pb resolves to (a symlink to another disk is
 *   fine – unless it resolves to the repository or one of its parents), or
 *   below the OS temp dir but outside the repository (also when the checkout
 *   itself lives in the temp dir) – never one of these roots,
 * - not overlapping backend/pb_hooks, loadtest/support or `protect` (e.g. the
 *   instance's app hooks, migrations, SPA build, data dir) in either direction,
 * - not containing the repository.
 */
export function assertDisposableLocation(dir: string, protect: readonly string[] = []): void {
  const target = realPath(dir);
  const repo = realPath(REPO_ROOT);
  const pbHome = realPath(PB_HOME);
  const inPbHome = !isSameOrInside(repo, pbHome) && isStrictlyInside(target, pbHome);
  const inTemp = !isSameOrInside(target, repo) && isStrictlyInside(target, realPath(os.tmpdir()));
  if (!inPbHome && !inTemp) {
    throw new Error(
      `refusing to create or delete ${dir}: the load test only manages directories below ${PB_HOME}` +
        `${pbHome !== PB_HOME ? ` (= ${pbHome})` : ''} or below ${os.tmpdir()} outside the repository`,
    );
  }
  if (isSameOrInside(repo, target)) throw new Error(`refusing to create or delete ${dir}: it contains the repository`);
  for (const source of [APP_HOOKS_DIR, SUPPORT_DIR, ...protect]) {
    const real = realPath(source);
    if (isSameOrInside(target, real) || isSameOrInside(real, target)) {
      throw new Error(`refusing to create or delete ${dir}: it overlaps ${source}`);
    }
  }
}

/** Throws for a symlink: the load test never deletes or writes through one (its target is not its own). */
async function assertNoSymlink(dir: string): Promise<boolean> {
  try {
    const stats = await lstat(dir);
    if (stats.isSymbolicLink()) {
      throw new Error(
        `refusing to create or delete ${dir}: it is a symlink (to ${await readlink(dir)}) – ` +
          'remove the link or use a real directory',
      );
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Creates `dir` (with parents) as a directory the load test owns: checks the
 * location (assertDisposableLocation) and writes the marker file that allows
 * removeOwnedDir() to delete it later. An existing directory must be empty or
 * already carry the marker; a symlink is refused.
 */
export async function createOwnedDir(dir: string, options: { protect?: readonly string[] } = {}): Promise<void> {
  await assertNoSymlink(dir);
  assertDisposableLocation(dir, options.protect);
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir);
  if (entries.length > 0 && !entries.includes(OWNED_DIR_MARKER)) {
    throw new Error(`refusing to use ${dir}: it is not empty and was not created by the load test`);
  }
  await writeFile(
    path.join(dir, OWNED_DIR_MARKER),
    `Created by the getraenkeliste load test (pid ${process.pid}, ${new Date().toISOString()}).\n` +
      'The load-test tooling deletes and recreates this directory.\n',
  );
}

/**
 * Deletes a directory created by createOwnedDir() (`rm -rf`). A missing path
 * is fine. Refused: symlinks, wrong locations (assertDisposableLocation),
 * anything that is not a directory, and directories without the marker –
 * unless they are empty or `isLegacy(dir)` recognizes them as created by an
 * earlier version of the load test (which wrote no marker).
 */
export async function removeOwnedDir(
  dir: string,
  options: { protect?: readonly string[]; isLegacy?: (dir: string) => boolean } = {},
): Promise<void> {
  if (!(await assertNoSymlink(dir))) return; // missing: nothing to delete
  const stats = await lstat(dir);
  if (!stats.isDirectory()) throw new Error(`refusing to delete ${dir}: it is not a directory`);
  assertDisposableLocation(dir, options.protect);
  const entries = await readdir(dir);
  const owned = entries.length === 0 || entries.includes(OWNED_DIR_MARKER) || (options.isLegacy?.(dir) ?? false);
  if (!owned) {
    throw new Error(`refusing to delete ${dir}: it was not created by the load test (no ${OWNED_DIR_MARKER} file)`);
  }
  await rm(dir, { recursive: true, force: true });
}

/**
 * Copies an SPA build into `<root>/dist`, where `root` is an owned directory –
 * a fresh one in the OS temp dir, or `root` (recreated). The instance serves
 * the copy, so a rebuild of frontend/dist (`make loadtest` runs `vite build`
 * with emptyOutDir) cannot pull files away from it or from the browsers that
 * have it open. Remove `root` with removeOwnedDir() when done (a fixed `root`
 * may also be kept and is replaced on the next call).
 */
export async function snapshotSpa(source: string, root?: string): Promise<{ root: string; publicDir: string }> {
  if (!existsSync(path.join(source, 'index.html'))) throw new Error(`no SPA build in ${source} (run: cd frontend && npm run build)`);
  const dir = root ?? (await mkdtemp(path.join(os.tmpdir(), 'getraenkeliste-loadtest-spa-')));
  if (root) await removeOwnedDir(root, { protect: [source] });
  await createOwnedDir(dir, { protect: [source] });
  const publicDir = path.join(dir, 'dist');
  await cp(source, publicDir, { recursive: true });
  return { root: dir, publicDir };
}
