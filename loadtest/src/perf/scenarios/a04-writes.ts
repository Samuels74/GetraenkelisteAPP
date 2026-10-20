/**
 * A4 – write contention: many simultaneous booking taps.
 *
 * 20 closed-loop writers (each with its own connection, users round-robin,
 * spread over 4 worker threads) create bookings back to back with the SPA's
 * request (expand included); 10 % of the creates are deleted right away
 * ("Rückgängig"). Meanwhile 6 realtime subscribers receive every event and a
 * background client fetches the reference totals 5 times per second (the
 * read load of the big screens). SQLite has one write connection – writes
 * queue in Go; this checks that they queue without errors (no SQLITE_BUSY,
 * PocketBase's busy_timeout is 10 s) and how long a tap waits meanwhile.
 *
 * Capped at 20 s or 5,000 creates (quick: 5 s / 1,000), so the dataset stays
 * near its seeded size (≈ +4,500 bookings; it runs near the end of the
 * default order). At ≈ 2,000 creates/s the burst lasts 2–3 s; its p99 then
 * depends on whether one or two short write stalls (≈ 50–70 ms, cause not
 * determined) fall into it – it ranged from 17 to 51 ms on the reference
 * machine, p50/p95 stay at ≈ 7 / 12–14 ms. The WARN limit is therefore the
 * perception threshold of a tap (100 ms), not 1B's 50 ms, which assumed 13 ms
 * for 16 writers without listeners and reads.
 *
 * Every background activity stops on every exit path: the totals reader has
 * its own AbortController (aborted in `finally`, then awaited), the clients
 * are closed (a closed HttpClient sends nothing).
 *
 * Test hook (verification only): LOADTEST_FAULT=a4-writers makes the writer
 * pool reject after 1 s, as a crashed worker thread would.
 */
import { latencyStats } from '../../stats.ts';
import { describeLatency, typeTable } from '../analysis.ts';
import { HttpClient } from '../http.ts';
import { constantArrivals, runClosedLoopDistributed, runOpenLoop, type OpenLoopSample, type RequestTemplate } from '../load.ts';
import { bookingBody, paths, realtimeTopics } from '../requests.ts';
import { errorGroups, formatErrorGroups, latencies, nowAbs, summarize } from '../samples.ts';
import { fmt, runScenario, sleep, type PerfContext } from '../scenario.ts';
import { SseClient } from '../sse.ts';
import type { ScenarioResult } from '../types.ts';
import { serverErrorLog } from './common.ts';

export async function scenarioA4(ctx: PerfContext): Promise<ScenarioResult[]> {
  const result = await runScenario(
    ctx,
    {
      id: 'A4',
      title: 'Write contention',
      simulates: '20 devices booking as fast as they can (10 % undo) while 6 screens listen and the totals are read 5×/s',
    },
    async (rec) => {
      const { catalog } = ctx;
      const users = ['user1', 'user2', 'user3', 'user4', 'user5'].map((name) => ctx.logins[name]!);
      const durationMs = ctx.quick ? 5_000 : 20_000;
      const maxCreates = ctx.quick ? 1_000 : 5_000;
      const writers = 20;

      // the requests: bookings for 50 persons spread over the list, offerings round-robin
      const requests: RequestTemplate[] = [];
      for (let i = 0; i < 50; i++) {
        const person = catalog.persons[(i * 41) % catalog.persons.length]!;
        const offering = catalog.offerings[i % catalog.offerings.length]!;
        // createdBy is set per writer to its own user id (load.ts userIds), as the SPA sends it
        requests.push({ type: 'create', method: 'POST', path: paths.createBooking(), body: bookingBody(person.id, offering.id, '') });
      }

      const subscribers: SseClient[] = [];
      const listenerClients: HttpClient[] = [];
      const reader = new HttpClient(ctx.url, { token: ctx.logins.admin!.token });
      // one switch for everything this scenario starts: the writer threads and the totals reader
      const stop = new AbortController();
      const signal = AbortSignal.any([ctx.signal, stop.signal]);
      let reading: Promise<OpenLoopSample[]> = Promise.resolve([]);
      const logFrom = new Date().toISOString().replace('T', ' ');
      const filesBefore = rec.dbSizes();
      const window = rec.window();
      let raws;
      let background: OpenLoopSample[];
      try {
        // 6 realtime subscribers (no refetching – they only receive)
        for (let i = 0; i < 6; i++) {
          const login = users[i % users.length]!;
          const client = new HttpClient(ctx.url, { token: login.token });
          listenerClients.push(client);
          const sse = new SseClient({ url: ctx.url, client, topics: realtimeTopics(String(login.record.id), false), reconnect: false });
          await sse.open();
          subscribers.push(sse);
        }
        const writing = runClosedLoopDistributed(
          {
            url: ctx.url,
            tokens: users.map((u) => u.token),
            userIds: users.map((u) => String(u.record.id)),
            requests,
            concurrency: writers,
            warmupMs: 0,
            durationMs,
            maxRequests: maxCreates,
            undoShare: 0.1,
            seed: 'loadtest-A4',
          },
          4,
          signal,
        );
        writing.catch(() => undefined); // awaited below; after a fault its late outcome must not be an unhandled rejection
        // background: reference totals 5×/s, open loop, for as long as the writers run
        reading = (async () => {
          const results: OpenLoopSample[] = [];
          let start = nowAbs() + 50;
          while (!signal.aborted) {
            results.push(...(await runOpenLoop(constantArrivals(5, 1000), start, () => reader.get(paths.totals()), signal)));
            start += 1000;
          }
          return results;
        })();
        const faulty =
          process.env.LOADTEST_FAULT === 'a4-writers'
            ? sleep(1000, ctx.signal).then(() => Promise.reject(new Error('injected fault: the writer pool failed (LOADTEST_FAULT=a4-writers)')))
            : undefined;
        raws = await (faulty ? Promise.race([writing, faulty]) : writing);
      } finally {
        // whatever happened: stop the writer threads and the reader loop, wait for the reader, close every client
        stop.abort();
        background = await reading;
        for (const sse of subscribers) sse.close();
        for (const client of listenerClients) client.close();
        reader.close();
      }
      const stats = window.stop();
      const filesAfter = rec.dbSizes();

      const samples = raws.map((raw) => raw.samples);
      const createMs = latencies(samples, { types: ['create'] });
      const deleteMs = latencies(samples, { types: ['delete'] });
      const create = latencyStats(createMs);
      const undo = latencyStats(deleteMs);
      const first = Math.min(...raws.flatMap((raw) => raw.samples.start));
      const spanMs = Math.max(...raws.flatMap((raw) => raw.samples.start.map((s, i) => s + (raw.samples.ms[i] ?? 0)))) - first;
      const groups = errorGroups(samples);
      const errorCount = groups.reduce((sum, g) => sum + g.count, 0) + background.filter((b) => b.result.error).length;
      const busyClient = groups.filter((g) => /locked|busy/i.test(g.key)).reduce((sum, g) => sum + g.count, 0);
      const logs = await serverErrorLog(ctx, logFrom);
      const busyServer = logs.entries.filter((e) => /locked|busy/i.test(e)).length;
      rec.addClientHealth(raws.map((raw) => raw.health));

      rec.add({
        key: 'create.p99',
        label: 'booking create – p99 (closed loop, 20 writers)',
        value: create.count ? create.p99 : null,
        unit: 'ms',
        budget: {
          direction: 'max',
          warn: 100,
          fail: 250,
          rationale:
            'p99 tap → answer while 20 devices write at once: below 100 ms a tap feels instant; measured 17–51 ms in this setup (13 ms for 16 writers without listeners and reads)',
        },
        detail: describeLatency(create),
        explain: (verdict) =>
          verdict === 'warn' || verdict === 'fail'
            ? `writes queue on SQLite's single write connection: 1 % of the taps wait ${create.p99} ms or longer while 20 devices book at once`
            : undefined,
      });
      rec.info('create.p95', 'booking create – p95', create.p95, 'ms');
      rec.info(
        'creates.perSecond',
        'creates per second (20 writers)',
        Math.round(createMs.length / (spanMs / 1000)),
        'rps',
        `${createMs.length} creates, ${deleteMs.length} undone in ${fmt(spanMs / 1000, 2)} s`,
      );
      rec.info('delete.p99', 'booking delete (Rückgängig) – p99', undo.count ? undo.p99 : null, 'ms', describeLatency(undo));
      rec.add({
        key: 'errors',
        label: 'failed requests (incl. SQLITE_BUSY / "database is locked")',
        value: errorCount,
        unit: 'count',
        budget: { direction: 'max', fail: 0, rationale: 'a lost booking is never acceptable' },
        detail: `${formatErrorGroups(groups)}; busy/locked: ${busyClient} in responses, ${busyServer} in the server log; server log warnings/errors: ${logs.count}`,
      });
      const bg = latencyStats(background.map((b) => b.ms));
      rec.info('background.totals.p95', 'reference totals during the write burst – p95 from the scheduled time', bg.count ? bg.p95 : null, 'ms', describeLatency(bg));
      if (stats.server) rec.info('server.cpu.mean', 'PocketBase CPU (mean)', stats.server.cpuMeanPct, '%', `peak ${stats.server.cpuPeakPct} %`);
      const expectedEvents = (createMs.length + deleteMs.length) * subscribers.length;
      const received = subscribers.reduce((sum, s) => sum + s.stats.messages, 0);
      rec.info('realtime.delivered', 'realtime events delivered to the 6 subscribers', received, 'count', `${expectedEvents} expected`);
      rec.info('wal.after', 'data.db-wal after the burst', filesAfter.dataWal, 'MiB', `${filesBefore.dataWal} MiB before (checkpointed by the runner)`);

      // when do the slow creates happen? (write stalls show up as a slow quarter)
      const quarters = [0, 1, 2, 3].map((q) =>
        latencyStats(latencies(samples, { types: ['create'], from: first + (q * spanMs) / 4, to: first + ((q + 1) * spanMs) / 4 })),
      );
      rec.table('Create latency per quarter of the burst', {
        columns: ['quarter', 'creates', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms'],
        rows: quarters.map((q, i) => [i + 1, q.count, q.p50, q.p95, q.p99, q.max]),
      });
      rec.table('Requests', typeTable(summarize(samples, {}, spanMs)));
      rec.data.cap = { durationMs, maxCreates };
      rec.note(
        `The burst stopped after ${fmt(spanMs / 1000, 1)} s (cap: ${fmt(durationMs / 1000)} s or ${maxCreates.toLocaleString('en')} creates); ` +
          `the dataset grew by ≈ ${(createMs.length - deleteMs.length).toLocaleString('en')} bookings.`,
      );
    },
  );
  return [result];
}
