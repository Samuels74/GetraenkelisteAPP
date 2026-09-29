// Starts a throw-away PocketBase for the API tests and stops it afterwards.
//
// Environment (paths may be relative to the current working directory):
//   PB_BIN             PocketBase binary        (default ../../.pb/pocketbase)
//   PB_MIGRATIONS_DIR  migrations              (default ../pb_migrations)
//   PB_HOOKS_DIR       hooks                   (default ../pb_hooks)
//   TEST_RESULTS_DIR   if set, the PocketBase log is written to <dir>/api/pocketbase.log
//   KEEP_PB_DATA=1     keep the temp data dir for debugging
//
// The hooks are copied into a temp dir together with support/test-routes.pb.js,
// a test-only route that performs plain model deletes (bypassing the REST
// handlers) so the model-level delete guards can be verified. The public dir
// gets the fixture files of support/public (cache header tests).
//
// After the start the login throttling configured by the migrations is
// disabled via PATCH /api/settings {"rateLimits":{"enabled":false}}.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { TestProject } from "vitest/node";

const testsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolvePath(envName: string, fallbackRelativeToTests: string): string {
  const value = process.env[envName];
  return value ? path.resolve(process.cwd(), value) : path.resolve(testsDir, fallbackRelativeToTests);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url: string, proc: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`PocketBase exited early (code ${proc.exitCode}):\n${output()}`);
    }
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) {
        return;
      }
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`PocketBase did not become healthy within 30s:\n${output()}`);
}

/**
 * The migrations enable login throttling (10 attempts / 60 s / IP); the tests
 * log in far more often from 127.0.0.1, so it is switched off through the
 * superuser settings API (the dedicated throttling test re-enables it).
 */
async function disableLoginThrottling(url: string, superuser: { email: string; password: string }): Promise<void> {
  const auth = await fetch(`${url}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: superuser.email, password: superuser.password }),
  });
  if (!auth.ok) {
    throw new Error(`superuser login failed: ${auth.status} ${await auth.text()}`);
  }
  const { token } = (await auth.json()) as { token: string };

  const res = await fetch(`${url}/api/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({ rateLimits: { enabled: false } }),
  });
  const settings = (await res.json()) as { rateLimits?: { enabled?: boolean } };
  if (!res.ok || settings.rateLimits?.enabled !== false) {
    throw new Error(`could not disable the rate limiting: ${res.status} ${JSON.stringify(settings)}`);
  }
}

export default async function setup(project: TestProject) {
  const pbBin = resolvePath("PB_BIN", "../../.pb/pocketbase");
  const migrationsDir = resolvePath("PB_MIGRATIONS_DIR", "../pb_migrations");
  const hooksSourceDir = resolvePath("PB_HOOKS_DIR", "../pb_hooks");

  for (const [name, p] of Object.entries({ PB_BIN: pbBin, PB_MIGRATIONS_DIR: migrationsDir, PB_HOOKS_DIR: hooksSourceDir })) {
    if (!existsSync(p)) {
      throw new Error(`${name} not found: ${p} (run scripts/dev-pocketbase.sh --download-only for the binary)`);
    }
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), "getraenkeliste-api-tests-"));
  const dataDir = path.join(tmp, "pb_data");
  const hooksDir = path.join(tmp, "pb_hooks");
  const publicDir = path.join(tmp, "pb_public");
  await cp(hooksSourceDir, hooksDir, { recursive: true });
  await cp(path.join(testsDir, "support", "test-routes.pb.js"), path.join(hooksDir, "zz_test-routes.pb.js"));
  // minimal SPA build output for the cache header tests
  await cp(path.join(testsDir, "support", "public"), publicDir, { recursive: true });

  const commonArgs = [
    `--dir=${dataDir}`,
    `--migrationsDir=${migrationsDir}`,
    `--hooksDir=${hooksDir}`,
    "--automigrate=false",
    "--hooksWatch=false",
  ];

  const superuser = { email: "superuser@example.com", password: `su-${Math.random().toString(36).slice(2)}-pw` };
  await promisify(execFile)(pbBin, ["superuser", "upsert", superuser.email, superuser.password, ...commonArgs]);

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let log = "";
  const proc = spawn(pbBin, ["serve", `--http=127.0.0.1:${port}`, `--publicDir=${publicDir}`, ...commonArgs], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (chunk) => (log += chunk));
  proc.stderr?.on("data", (chunk) => (log += chunk));

  try {
    await waitForHealth(url, proc, () => log);
    await disableLoginThrottling(url, superuser);
  } catch (err) {
    proc.kill("SIGKILL");
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }

  project.provide("pbUrl", url);
  project.provide("superuser", superuser);
  console.log(`[api-tests] PocketBase ${pbBin} listening on ${url} (data: ${dataDir})`);

  return async () => {
    if (proc.exitCode === null) {
      const exited = new Promise((resolve) => proc.once("exit", resolve));
      proc.kill("SIGTERM");
      const timer = setTimeout(() => proc.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(timer);
    }

    const resultsDir = process.env.TEST_RESULTS_DIR;
    if (resultsDir) {
      await mkdir(path.resolve(resultsDir, "api"), { recursive: true });
      await writeFile(path.resolve(resultsDir, "api", "pocketbase.log"), log);
    }

    if (process.env.KEEP_PB_DATA === "1") {
      console.log(`[api-tests] kept PocketBase data in ${tmp}`);
    } else {
      await rm(tmp, { recursive: true, force: true });
    }
  };
}
