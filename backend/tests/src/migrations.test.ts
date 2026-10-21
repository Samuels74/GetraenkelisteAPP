import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";

// `pocketbase migrate down` / `up` across the seed migration, on a database of
// its own (not the shared test instance) and with the app hooks loaded, as on
// a server. The seed's down step deletes the seeded admin – on a fresh
// database the only active admin: the "at least one active admin" rule binds
// the REST API only, migrations are trusted code (verification R1: the rule
// used to run at model level and blocked the revert).

const { bin, migrationsDir, hooksDir } = inject("pocketbase");
const APP_TABLES = ["bookings", "groups", "offerings", "persons"];

let dataDir = "";

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "getraenkeliste-migrations-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** Runs a PocketBase CLI command on the test's database; rejects with the output if it fails. */
function pocketbase(...args: string[]): Promise<string> {
  const options = [`--dir=${dataDir}`, `--migrationsDir=${migrationsDir}`, `--hooksDir=${hooksDir}`];
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      [...args, ...options, "--automigrate=false", "--hooksWatch=false"],
      { timeout: 60_000 },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim();
        if (error) {
          reject(new Error(`pocketbase ${args.join(" ")} failed:\n${output}`));
        } else {
          resolve(output);
        }
      },
    );
    child.stdin?.end("y\n"); // "migrate down" asks for a confirmation
  });
}

/** Reads the test's database directly (PocketBase is not running then). */
function query(sql: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(path.join(dataDir, "data.db"), { readOnly: true });
  try {
    return db.prepare(sql).all().map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

describe("migrations", () => {
  it("revert and re-apply the seed and all app migrations on a fresh database", async () => {
    const migrations = (await readdir(migrationsDir)).filter((file) => file.endsWith(".js")).sort();
    const seed = migrations.findIndex((file) => file.endsWith("_seed_data.js"));
    expect(seed, "seed migration").toBeGreaterThan(0);

    const applied = () =>
      query("SELECT file FROM _migrations")
        .map((row) => String(row.file))
        .filter((file) => migrations.includes(file))
        .sort();
    const appTables = () =>
      query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${APP_TABLES.map((t) => `'${t}'`).join(", ")})`)
        .map((row) => String(row.name))
        .sort();
    const seeded = () => {
      expect(applied()).toEqual(migrations);
      expect(query("SELECT username, role, disabled FROM users")).toEqual([{ username: "admin", role: "admin", disabled: 0 }]);
      expect(query("SELECT name FROM groups")).toEqual([{ name: "Getränke" }]);
    };

    await pocketbase("migrate", "up");
    seeded();

    // back to before the seed: its admin – the only active admin – and its group go, the schema stays
    await pocketbase("migrate", "down", String(migrations.length - seed));
    expect(applied()).toEqual(migrations.slice(0, seed));
    expect(query("SELECT username FROM users")).toEqual([]);
    expect(query("SELECT COUNT(*) AS n FROM groups")).toEqual([{ n: 0 }]);
    expect(appTables()).toEqual(APP_TABLES);

    await pocketbase("migrate", "up");
    seeded();

    // all app migrations: the app tables go as well
    await pocketbase("migrate", "down", String(migrations.length));
    expect(applied()).toEqual([]);
    expect(appTables()).toEqual([]);

    await pocketbase("migrate", "up");
    seeded();
  }, 120_000);
});
