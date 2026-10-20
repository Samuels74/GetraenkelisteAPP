/**
 * `npm run seed` – seeds the load-test dataset and prints the summary.
 *
 * Without --url: starts a throw-away instance (random free port, temp dir,
 * login throttling off), seeds, verifies, stops it – a self-contained check of
 * the generator and a measurement of the write path under seeding load.
 * With --url: seeds that running instance (superuser credentials required;
 * refuses instances that already contain persons or bookings unless --force).
 *
 * Exit code: 0 = seeded and every check passed, 1 = failed, 2 = usage error,
 * 130/143 = interrupted.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { formatSeedSummary } from '../format.ts';
import { startInstance, type Instance } from '../instance.ts';
import { runSeed, SeedRefusedError, type SeedOptions } from '../seed.ts';
import {
  abortOnSignals,
  DATASET_FLAGS,
  DATASET_FLAGS_HELP,
  datasetOptionsFrom,
  parseInteger,
  signalExitCode,
  UsageError,
} from './args.ts';

const HELP = `Usage: npm run seed -- [options]

Seeds the load-test dataset (persons, users, bookings through the REST API),
backdates the bookings, verifies everything and prints a summary.

Target (default: a throw-away PocketBase on a free port, removed afterwards):
  --url <url>                  seed this running instance instead
  --superuser-email <email>    its superuser (or LOADTEST_SUPERUSER_EMAIL)
  --superuser-password <pw>    (or LOADTEST_SUPERUSER_PASSWORD)
  --force                      seed even if it already contains persons/bookings
  --no-backdate                keep the creation times (instance without the
                               load-test support route, e.g. make dev)
Throw-away instance:
  --keep-data                  keep its temp dir after the run
  --log <file>                 write the PocketBase output to this file
${DATASET_FLAGS_HELP}
Other:
  --max-errors <n>             abort when more requests failed (10)
  --no-verify                  skip the read-back checks
  --json <file>                write the summary as JSON
  --dump <file>                write the read-back content (no ids/timestamps) as JSON
  --quiet                      no progress lines
  -h, --help`;

function parseFlags() {
  return parseArgs({
    allowNegative: true,
    options: {
      ...DATASET_FLAGS,
      url: { type: 'string' },
      'superuser-email': { type: 'string' },
      'superuser-password': { type: 'string' },
      force: { type: 'boolean', default: false },
      backdate: { type: 'boolean', default: true },
      verify: { type: 'boolean', default: true },
      'keep-data': { type: 'boolean', default: false },
      log: { type: 'string' },
      'max-errors': { type: 'string' },
      json: { type: 'string' },
      dump: { type: 'string' },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }).values;
}

async function main(): Promise<number> {
  let values: ReturnType<typeof parseFlags>;
  let dataset: ReturnType<typeof datasetOptionsFrom>;
  let maxErrors: number | undefined;
  try {
    values = parseFlags();
    if (values.help) {
      console.log(HELP);
      return 0;
    }
    dataset = datasetOptionsFrom(values);
    maxErrors = parseInteger('--max-errors', values['max-errors']);
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${HELP}`);
    return 2;
  }

  const out = (line: string) => console.log(`[seed] ${line}`);
  const { controller, received } = abortOnSignals((signal) => out(`${signal} received – stopping`));

  let instance: Instance | undefined;
  try {
    let url = values.url;
    let superuser: SeedOptions['superuser'];
    if (url) {
      const email = values['superuser-email'] ?? process.env.LOADTEST_SUPERUSER_EMAIL;
      const password = values['superuser-password'] ?? process.env.LOADTEST_SUPERUSER_PASSWORD;
      if (!email || !password) throw new UsageError('--url needs --superuser-email and --superuser-password');
      superuser = { email, password };
    } else {
      instance = await startInstance({ keepData: values['keep-data'], logFile: values.log });
      out(`throw-away PocketBase ${instance.url} (pid ${instance.pid}, data ${instance.dataDir})`);
      // like the other harnesses: all logins come from 127.0.0.1 (see docs/LOADTEST.md)
      await instance.setRateLimiting(false);
      url = instance.url;
      superuser = instance.superuser;
    }

    out(`seeding ${url} ...`);
    const result = await runSeed({
      url,
      superuser,
      ...dataset,
      maxErrors,
      force: values.force,
      backdate: values.backdate,
      verify: values.verify,
      log: values.quiet ? undefined : out,
      signal: controller.signal,
    });
    for (const line of formatSeedSummary(result.summary)) console.log(line);
    if (values.json) {
      await writeFile(values.json, `${JSON.stringify(result.summary, null, 2)}\n`);
      out(`summary written to ${path.resolve(values.json)}`);
    }
    if (values.dump && result.content) {
      await writeFile(values.dump, `${JSON.stringify(result.content, null, 1)}\n`);
      out(`content written to ${path.resolve(values.dump)}`);
    }
    return result.summary.ok ? 0 : 1;
  } catch (error) {
    const signal = received();
    if (signal) return signalExitCode(signal);
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${HELP}`);
      return 2;
    }
    console.error(`[seed] ${error instanceof SeedRefusedError ? 'refused' : 'failed'}: ${(error as Error).message}`);
    const exit = instance?.exitStatus();
    if (instance && exit) {
      console.error(`[seed] PocketBase exited unexpectedly (code ${exit.code}, signal ${exit.signal}):\n${instance.output()}`);
    }
    return 1;
  } finally {
    if (instance) {
      await instance.stop();
      if (values['keep-data']) out(`kept ${path.dirname(instance.dataDir)}`);
    }
  }
}

process.exitCode = await main();
