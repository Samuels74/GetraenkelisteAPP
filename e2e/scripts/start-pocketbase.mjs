#!/usr/bin/env node
// Starts a throw-away PocketBase for the E2E tests (Playwright `webServer`):
// fresh temp data dir, the app's migrations + hooks, the built SPA as public dir.
//
// The app's migrations enable login throttling (10 attempts / 60 s per client
// IP). All parallel test workers share one IP, so a temporary superuser
// disables the rate limiter (PATCH /api/settings) before "[pocketbase] ready"
// is printed – Playwright waits for that line (config.webServer.wait).
//
// Runs until SIGTERM/SIGINT, then stops PocketBase and deletes the data dir.
//
// Environment (relative paths are resolved against the current directory):
//   PB_BIN             PocketBase binary      (default ../.pb/pocketbase, relative to e2e/)
//   PB_MIGRATIONS_DIR  migrations             (default ../backend/pb_migrations)
//   PB_HOOKS_DIR       hooks                  (default ../backend/pb_hooks)
//   PB_PUBLIC_DIR      built SPA              (default ../frontend/dist)
//   E2E_PORT           HTTP port on 127.0.0.1 (default 18181)
//   PB_LOG_FILE        if set, the PocketBase output is also written to this file
//   KEEP_PB_DATA=1     keep the temp data dir (debugging)

import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const e2eDir = path.resolve(import.meta.dirname, '..');

function resolvePath(envName, fallbackRelativeToE2e) {
  const value = process.env[envName];
  return value ? path.resolve(process.cwd(), value) : path.resolve(e2eDir, fallbackRelativeToE2e);
}

function fail(message) {
  console.error(`[pocketbase] ${message}`);
  process.exit(1);
}

const pbBin = resolvePath('PB_BIN', '../.pb/pocketbase');
const migrationsDir = resolvePath('PB_MIGRATIONS_DIR', '../backend/pb_migrations');
const hooksDir = resolvePath('PB_HOOKS_DIR', '../backend/pb_hooks');
const publicDir = resolvePath('PB_PUBLIC_DIR', '../frontend/dist');
const port = Number(process.env.E2E_PORT || 18181);
const baseUrl = `http://127.0.0.1:${port}`;

const missing = Object.entries({ PB_BIN: pbBin, PB_MIGRATIONS_DIR: migrationsDir, PB_HOOKS_DIR: hooksDir })
  .filter(([, p]) => !existsSync(p))
  .map(([name, p]) => `${name} not found: ${p}`);
if (!existsSync(path.join(publicDir, 'index.html'))) {
  missing.push(`PB_PUBLIC_DIR has no index.html: ${publicDir} (build the frontend first: cd frontend && npm run build)`);
}
if (missing.length > 0) fail(`cannot start:\n  ${missing.join('\n  ')}`);

const portInUse = await new Promise((resolve) => {
  const socket = net.connect(port, '127.0.0.1');
  socket.once('connect', () => {
    socket.destroy();
    resolve(true);
  });
  socket.once('error', () => resolve(false));
});
if (portInUse) fail(`port ${port} is already in use (set E2E_PORT to another port)`);

const tmp = await mkdtemp(path.join(os.tmpdir(), 'getraenkeliste-e2e-pb-'));
const dataDir = path.join(tmp, 'pb_data');
const commonArgs = [
  `--dir=${dataDir}`,
  `--migrationsDir=${migrationsDir}`,
  `--hooksDir=${hooksDir}`,
  '--automigrate=false',
  '--hooksWatch=false',
];

let log = null;
if (process.env.PB_LOG_FILE) {
  mkdirSync(path.dirname(process.env.PB_LOG_FILE), { recursive: true });
  log = createWriteStream(process.env.PB_LOG_FILE, { flags: 'w' });
}

async function cleanup() {
  log?.end();
  if (process.env.KEEP_PB_DATA === '1') console.log(`[pocketbase] kept data dir ${tmp}`);
  else await rm(tmp, { recursive: true, force: true });
}

// A superuser that exists only in this throw-away instance.
const superuser = { email: 'e2e-superuser@example.com', password: `su-${randomBytes(12).toString('hex')}` };
try {
  await promisify(execFile)(pbBin, ['superuser', 'upsert', superuser.email, superuser.password, ...commonArgs]);
} catch (error) {
  await cleanup();
  fail(`superuser upsert failed: ${error.stderr || error.message}`);
}

const args = ['serve', `--http=127.0.0.1:${port}`, `--publicDir=${publicDir}`, ...commonArgs];
console.log(`[pocketbase] ${pbBin} ${args.join(' ')}`);
const pb = spawn(pbBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
for (const stream of [pb.stdout, pb.stderr]) {
  stream.on('data', (chunk) => {
    process.stdout.write(chunk);
    log?.write(chunk);
  });
}

let stopping = false;
let exitCode = 0;
pb.on('exit', async (code, signal) => {
  await cleanup();
  if (!stopping) console.error(`[pocketbase] exited unexpectedly (code ${code}, signal ${signal})`);
  process.exit(stopping ? exitCode : 1);
});

function stop() {
  if (stopping) return;
  stopping = true;
  // Playwright signals the whole process group, so PocketBase may already be
  // shutting down; make sure it goes away even if it does not react.
  if (pb.exitCode === null) pb.kill('SIGTERM');
  setTimeout(() => pb.kill('SIGKILL'), 5_000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('PocketBase did not become healthy within 30 s');
}

async function disableLoginThrottling() {
  const auth = await fetch(`${baseUrl}/api/collections/_superusers/auth-with-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: superuser.email, password: superuser.password }),
  });
  if (!auth.ok) throw new Error(`superuser login failed: HTTP ${auth.status} ${await auth.text()}`);
  const { token } = await auth.json();
  const res = await fetch(`${baseUrl}/api/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ rateLimits: { enabled: false } }),
  });
  const settings = await res.json().catch(() => ({}));
  if (!res.ok || settings?.rateLimits?.enabled !== false) {
    throw new Error(`could not disable the rate limiter: HTTP ${res.status} ${JSON.stringify(settings)}`);
  }
}

try {
  await waitForHealth();
  await disableLoginThrottling();
} catch (error) {
  console.error(`[pocketbase] ${error.message}`);
  exitCode = 1;
  stop();
}
if (!stopping) console.log(`[pocketbase] ready on ${baseUrl} (login throttling disabled for the tests)`);
