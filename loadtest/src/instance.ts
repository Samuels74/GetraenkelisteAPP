/**
 * Load-test PocketBase instances: the app's migrations and hooks plus the
 * test-only routes of loadtest/support/*.pb.js, the built SPA as public dir
 * and a superuser created through the CLI. Started like the other harnesses
 * (e2e/scripts/start-pocketbase.mjs, backend/tests/setup/global-setup.ts):
 * `superuser upsert`, then `serve` with --automigrate=false --hooksWatch=false,
 * then wait for /api/health. `--dev=false` is always passed: PocketBase turns
 * its dev mode (every SQL statement logged) on by itself when the binary lies
 * below the temp or cache dir, which would distort every measurement.
 *
 * The support routes are copied into a hooks dir that belongs to the
 * instance (next to a copy of backend/pb_hooks); they are never added to
 * backend/pb_hooks and never reach an image. Hooks dirs and temp dirs are
 * created and deleted only through the owned-directory guard of paths.ts
 * (marker file + allowed locations), so a wrong `hooksDir` can neither delete
 * an unrelated directory nor write into the repository's sources.
 *
 * Throw-away instances (no `dataDir`) live in a temp dir that stop() removes.
 * PocketBase runs in the caller's process group, so a Ctrl+C in the terminal
 * reaches it directly as well; a process 'exit' hook sends SIGTERM to
 * instances that were not stopped, so a crashing caller leaves no server
 * behind.
 */
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, type WriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, open, readdir, type FileHandle } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type PocketBase from 'pocketbase';
import {
  loginSuperuser,
  setRateLimiting,
  type RateLimitSettings,
  type SuperuserCredentials,
} from './api.ts';
import {
  APP_HOOKS_DIR,
  checkPaths,
  createOwnedDir,
  defaultPaths,
  isSameOrInside,
  realPath,
  removeOwnedDir,
  REPO_ROOT,
  SUPPORT_DIR,
  type InstancePaths,
} from './paths.ts';

/** The PocketBase version the app is built for (Makefile PB_VERSION); env PB_VERSION overrides it. */
export const EXPECTED_POCKETBASE_VERSION = process.env.PB_VERSION || '0.40.4';

export interface StartInstanceOptions {
  /** Persistent data dir (kept by stop()). Default: `pb_data` in a fresh temp dir. */
  dataDir?: string;
  /**
   * Hooks dir that is rebuilt on every start: backend/pb_hooks + the support
   * routes. Default: inside the instance's temp dir. Must lie below the OS
   * temp dir or <repo>/.pb, must not overlap the data dir or a source dir, and
   * an existing directory is only replaced when the load test created it.
   */
  hooksDir?: string;
  /** Listen address `host:port`. Default `127.0.0.1:<port>`. */
  http?: string;
  /** Port on 127.0.0.1 when `http` is not given. Default: a free port. */
  port?: number;
  /** Keep the temp dir of a throw-away instance after stop() (debugging). */
  keepData?: boolean;
  /** Write the PocketBase output (stdout + stderr) to this file. */
  logFile?: string;
  /** Echo the PocketBase output line by line (true: to stderr with a "[pocketbase]" prefix). */
  echo?: boolean | ((line: string) => void);
  /** Superuser to upsert before the start. Default: a random throw-away one. */
  superuser?: SuperuserCredentials;
  /** Extra `serve` arguments, e.g. ['--hooksPool=25']. */
  serveArgs?: string[];
  /** Overrides of the binary / migrations / app hooks / public dir (default: paths.ts). */
  paths?: Partial<InstancePaths>;
  /** Timeout for /api/health after the start (default 30 s). */
  startTimeoutMs?: number;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface Instance {
  /** Base URL for clients, e.g. http://127.0.0.1:8091 (also for a 0.0.0.0 listen address). */
  url: string;
  /** The listen address passed to `serve --http`. */
  http: string;
  superuser: SuperuserCredentials;
  pid: number;
  dataDir: string;
  hooksDir: string;
  /** True for throw-away instances (data in a temp dir). */
  temporary: boolean;
  logFile?: string;
  paths: InstancePaths;
  /** The most recent PocketBase output (for error messages). */
  output(): string;
  /** Resolves when the PocketBase process has exited (for whatever reason). */
  exited: Promise<ExitInfo>;
  /** Exit code/signal once the process has exited, null while it runs. */
  exitStatus(): ExitInfo | null;
  /** A superuser SDK client (logged in on first use, then cached). */
  superuserClient(): Promise<PocketBase>;
  /** Switches the rate limiter (login throttling) on or off. */
  setRateLimiting(enabled: boolean): Promise<RateLimitSettings>;
  /** SIGTERM, SIGKILL after `timeoutMs` (default 10 s); removes a throw-away instance's temp dir. Idempotent. */
  stop(timeoutMs?: number): Promise<void>;
}

const OUTPUT_LINES = 200;
const running = new Set<{ kill(signal: NodeJS.Signals): boolean }>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const child of running) child.kill('SIGTERM');
  });
}

/** Splits `host:port` / `[v6]:port`. */
export function parseListenAddress(http: string): { host: string; port: number } {
  const match = /^(?:\[([^\]]*)\]|([^:]*)):(\d{1,5})$/.exec(http.trim());
  const port = match ? Number(match[3]) : NaN;
  if (!match || port < 1 || port > 65_535) {
    throw new Error(`invalid listen address "${http}" (expected host:port, e.g. 127.0.0.1:8091)`);
  }
  return { host: match[1] ?? match[2] ?? '', port };
}

/** Base URL to reach a listen address from this machine (wildcard → loopback; localhost → 127.0.0.1 like Go binds it). */
export function clientUrl(http: string): string {
  const { host, port } = parseListenAddress(http);
  const reachable =
    host === '' || host === '0.0.0.0' || host === 'localhost' ? '127.0.0.1' : host === '::' ? '::1' : host;
  return `http://${reachable.includes(':') ? `[${reachable}]` : reachable}:${port}`;
}

/** Whether the address is only reachable from this machine. */
export function isLoopback(http: string): boolean {
  const { host } = parseListenAddress(http);
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

/** True if a server could bind host:port right now (`localhost` is probed as 127.0.0.1, where Go binds it). */
export function isPortFree(host: string, port: number): Promise<boolean> {
  const bindHost = host === '' ? '0.0.0.0' : host === 'localhost' ? '127.0.0.1' : host;
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: bindHost, port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/** A port that is free on 127.0.0.1 at the moment of the call. */
export function freePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

const versionChecks = new Map<string, Promise<void>>();

/** Fails unless the binary reports EXPECTED_POCKETBASE_VERSION (checked once per binary and process). */
export function assertPocketBaseVersion(pbBin: string): Promise<void> {
  let check = versionChecks.get(pbBin);
  if (!check) {
    check = (async () => {
      const { stdout } = await promisify(execFile)(pbBin, ['--version'], { timeout: 30_000 });
      const version = stdout.trim().split(/\s+/).pop() ?? '';
      if (version !== EXPECTED_POCKETBASE_VERSION) {
        throw new Error(
          `${pbBin} is PocketBase ${version || '(unknown version)'}, the app needs ${EXPECTED_POCKETBASE_VERSION} ` +
            '(scripts/dev-pocketbase.sh --download-only installs it; env PB_VERSION changes the expectation)',
        );
      }
    })();
    check.catch(() => versionChecks.delete(pbBin));
    versionChecks.set(pbBin, check);
  }
  return check;
}

/** A hooks dir written by an earlier version (no marker file yet) is recognized by the support route in it. */
function isLegacyHooksDir(dir: string): boolean {
  return existsSync(path.join(dir, 'zz_loadtest-routes.pb.js'));
}

/** backend/pb_hooks (or PB_HOOKS_DIR) + loadtest/support/*.pb.js → hooksDir (recreated as an owned dir). */
async function buildHooksDir(hooksDir: string, paths: InstancePaths, protect: readonly string[]): Promise<void> {
  await removeOwnedDir(hooksDir, { protect, isLegacy: isLegacyHooksDir });
  await createOwnedDir(hooksDir, { protect });
  await cp(paths.hooksDir, hooksDir, { recursive: true });
  for (const file of await readdir(SUPPORT_DIR)) {
    if (file.endsWith('.pb.js')) await cp(path.join(SUPPORT_DIR, file), path.join(hooksDir, file));
  }
}

/** The instance's data dir must not overlap a source dir (it is written by PocketBase). */
function assertDataDir(dataDir: string, paths: InstancePaths): void {
  const target = realPath(dataDir);
  for (const source of [APP_HOOKS_DIR, SUPPORT_DIR, paths.hooksDir, paths.migrationsDir, paths.publicDir]) {
    const real = realPath(source);
    if (isSameOrInside(target, real) || isSameOrInside(real, target)) {
      throw new Error(`refusing ${dataDir} as data dir: it overlaps ${source}`);
    }
  }
  if (isSameOrInside(realPath(REPO_ROOT), target)) throw new Error(`refusing ${dataDir} as data dir: it contains the repository`);
}

export async function startInstance(options: StartInstanceOptions = {}): Promise<Instance> {
  const paths: InstancePaths = { ...defaultPaths(), ...options.paths };
  const problems = checkPaths(paths);
  if (problems.length > 0) throw new Error(`cannot start PocketBase:\n  ${problems.join('\n  ')}`);
  await assertPocketBaseVersion(paths.pbBin);

  const http = options.http ?? `127.0.0.1:${options.port ?? (await freePort())}`;
  const { host, port } = parseListenAddress(http);
  if (!(await isPortFree(host, port))) {
    throw new Error(`port ${port} is already in use (${http}) – stop the other server or choose another port`);
  }

  const temporary = options.dataDir === undefined;
  const superuser = options.superuser ?? {
    email: 'loadtest-superuser@example.com',
    password: `su-${randomBytes(12).toString('hex')}`,
  };

  // The log file first: if it cannot be opened, nothing has been created yet.
  let logHandle: FileHandle | undefined;
  if (options.logFile) {
    await mkdir(path.dirname(path.resolve(options.logFile)), { recursive: true });
    logHandle = await open(options.logFile, 'w');
  }

  let tmpDir: string | undefined;
  const removeTemp = async () => {
    if (tmpDir && !(temporary && options.keepData)) await removeOwnedDir(tmpDir);
  };
  let dataDir = '';
  let hooksDir = '';
  const commonArgs: string[] = [];
  try {
    if (temporary || options.hooksDir === undefined) {
      tmpDir = await mkdtemp(path.join(os.tmpdir(), 'getraenkeliste-loadtest-'));
      await createOwnedDir(tmpDir);
    }
    dataDir = options.dataDir ? path.resolve(options.dataDir) : path.join(tmpDir as string, 'pb_data');
    hooksDir = options.hooksDir ? path.resolve(options.hooksDir) : path.join(tmpDir as string, 'pb_hooks');
    assertDataDir(dataDir, paths);
    commonArgs.push(
      `--dir=${dataDir}`,
      `--migrationsDir=${paths.migrationsDir}`,
      `--hooksDir=${hooksDir}`,
      '--automigrate=false',
      '--hooksWatch=false',
      '--dev=false',
    );
    await mkdir(dataDir, { recursive: true });
    await buildHooksDir(hooksDir, paths, [paths.hooksDir, paths.migrationsDir, paths.publicDir, dataDir]);
    await promisify(execFile)(paths.pbBin, ['superuser', 'upsert', superuser.email, superuser.password, ...commonArgs], {
      timeout: 120_000,
    });
  } catch (error) {
    await logHandle?.close();
    await removeTemp().catch(() => undefined);
    const stderr = (error as { stderr?: string }).stderr;
    throw new Error(`preparing PocketBase failed: ${stderr?.trim() || (error as Error).message}`, { cause: error });
  }

  let log: WriteStream | undefined = logHandle?.createWriteStream();
  // a failing log file (disk full, …) must not take the caller down
  log?.on('error', (error) => {
    process.stderr.write(`[loadtest] writing ${options.logFile} failed: ${error.message}\n`);
    log = undefined;
  });
  const echo =
    options.echo === true
      ? (line: string) => process.stderr.write(`[pocketbase] ${line}\n`)
      : typeof options.echo === 'function'
        ? options.echo
        : undefined;

  const args = ['serve', `--http=${http}`, `--publicDir=${paths.publicDir}`, ...commonArgs, ...(options.serveArgs ?? [])];
  const child = spawn(paths.pbBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  running.add(child);
  installExitHook();

  const lines: string[] = [];
  let partial = '';
  const onData = (chunk: Buffer) => {
    log?.write(chunk);
    const text = partial + chunk.toString('utf8');
    const parts = text.split('\n');
    partial = parts.pop() ?? '';
    for (const line of parts) {
      lines.push(line);
      if (lines.length > OUTPUT_LINES) lines.shift();
      echo?.(line);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const output = () => [...lines, partial].join('\n').trim();

  const exited = new Promise<ExitInfo>((resolve) => {
    child.once('error', (error) => {
      lines.push(`spawn error: ${error.message}`);
      running.delete(child);
      resolve({ code: null, signal: null });
    });
    child.once('exit', (code, signal) => {
      running.delete(child);
      resolve({ code, signal });
    });
  });
  let exitInfo: ExitInfo | null = null;
  void exited.then((info) => (exitInfo = info));

  const url = clientUrl(http);
  let stopping: Promise<void> | null = null;
  let superuserClient: Promise<PocketBase> | null = null;

  const instance: Instance = {
    url,
    http,
    superuser,
    pid: child.pid ?? -1,
    dataDir,
    hooksDir,
    temporary,
    logFile: options.logFile ? path.resolve(options.logFile) : undefined,
    paths,
    output,
    exited,
    exitStatus: () => exitInfo,
    superuserClient() {
      superuserClient ??= loginSuperuser(url, superuser).catch((error: unknown) => {
        superuserClient = null;
        throw error;
      });
      return superuserClient;
    },
    async setRateLimiting(enabled) {
      return setRateLimiting(await instance.superuserClient(), enabled);
    },
    stop(timeoutMs = 10_000) {
      stopping ??= (async () => {
        if (exitInfo === null && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
          await exited;
          clearTimeout(timer);
        }
        await new Promise<void>((resolve) => (log ? log.end(resolve) : resolve()));
        await removeTemp();
      })();
      return stopping;
    },
  };

  // wait for /api/health; fail with the PocketBase output on an early exit
  const deadline = Date.now() + (options.startTimeoutMs ?? 30_000);
  try {
    for (;;) {
      if (exitInfo !== null) {
        const { code, signal } = exitInfo as ExitInfo;
        throw new Error(`PocketBase exited during the start (code ${code}, signal ${signal}):\n${output()}`);
      }
      try {
        const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2_000) });
        if (res.ok) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error(`PocketBase did not become healthy at ${url}:\n${output()}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    await instance.stop(2_000);
    throw error;
  }
  return instance;
}
