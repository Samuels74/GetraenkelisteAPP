/**
 * A10 – realtime fan-out capacity: many open browsers (tabs left open,
 * forgotten devices) that only listen.
 *
 * For K = 6, 20, 100, 300 subscribers (quick: up to 100) – subscribed like
 * the SPA (bookings, persons, offerings, groups, own user) – 40 bookings are
 * created one after the other (each waits until all K subscribers received
 * it) and then deleted. PocketBase checks access and encodes the record per
 * subscriber (apis/realtime.go); for creates this happens before the creator
 * gets its answer, for deletes inside the delete transaction, which holds
 * SQLite's single write connection. Memory is reported per K (since
 * static.pb.js serves the SPA through a route of its own, a stream no longer
 * pins a JS VM – only static requests run JavaScript; before, each stream
 * cost ≈ 0.5–0.66 MiB of server memory).
 *
 * Subscribers do not refetch here: this isolates the broadcast cost (the
 * refetch load of active screens is what A2/A3 measure).
 */
import { latencyStats } from '../../stats.ts';
import { describeLatency } from '../analysis.ts';
import { HttpClient, parseJson } from '../http.ts';
import { bookingBody, paths, realtimeTopics } from '../requests.ts';
import { dbFileSizes } from '../server.ts';
import { fmt, runScenario, type PerfContext } from '../scenario.ts';
import { parseRecordEvent, SseClient } from '../sse.ts';
import type { ScenarioResult } from '../types.ts';

interface Subscriber {
  sse: SseClient;
  client: HttpClient;
  /** booking id → arrival (performance.now()) of its create / delete event */
  created: Map<string, number>;
  deleted: Map<string, number>;
}

export async function scenarioA10(ctx: PerfContext): Promise<ScenarioResult[]> {
  const result = await runScenario(
    ctx,
    {
      id: 'A10',
      title: 'Realtime fan-out capacity',
      simulates: 'many browsers left open (tabs, forgotten devices) that receive every booking',
    },
    async (rec) => {
      const users = ['user1', 'user2', 'user3', 'user4', 'user5'].map((name) => ctx.logins[name]!);
      const booker = ctx.logins.user2!;
      const writer = new HttpClient(ctx.url, { token: booker.token });
      const person = ctx.catalog.persons[123 % ctx.catalog.persons.length]!;
      const offering = ctx.catalog.offerings[1]!;
      const levels = ctx.quick ? [6, 20, 100] : [6, 20, 100, 300];
      const bookings = ctx.quick ? 20 : 40;
      const subscribers: Subscriber[] = [];
      // arrivals per event ("created:<id>") and the one waiter per event – O(1) per message, no scan over all subscribers
      const arrivals = new Map<string, number>();
      const waiters = new Map<string, () => void>();
      const rows: Array<Array<string | number>> = [];
      const perLevel = new Map<number, { delivery: number; create: number; del: number; delDelivery: number }>();

      const addSubscriber = async (i: number) => {
        const login = users[i % users.length]!;
        const client = new HttpClient(ctx.url, { token: login.token, maxSockets: 1 });
        const sub: Subscriber = { sse: undefined as unknown as SseClient, client, created: new Map(), deleted: new Map() };
        sub.sse = new SseClient({
          url: ctx.url,
          client,
          topics: realtimeTopics(String(login.record.id), false),
          reconnect: false,
          onMessage: (event, data, at) => {
            if (!event.startsWith('bookings/')) return;
            const parsed = parseRecordEvent(data);
            if (!parsed) return;
            const kind = parsed.action === 'delete' ? 'deleted' : 'created';
            sub[kind].set(parsed.id, at);
            const key = `${kind}:${parsed.id}`;
            const count = (arrivals.get(key) ?? 0) + 1;
            arrivals.set(key, count);
            if (count >= subscribers.length) waiters.get(key)?.();
          },
        });
        await sub.sse.open();
        subscribers.push(sub);
      };
      /** Resolves when every subscriber has the event (or after 10 s). */
      const allReceived = (id: string, kind: 'created' | 'deleted') =>
        new Promise<void>((resolve) => {
          const key = `${kind}:${id}`;
          const done = () => {
            waiters.delete(key);
            arrivals.delete(key);
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(done, 10_000);
          if ((arrivals.get(key) ?? 0) >= subscribers.length) done();
          else waiters.set(key, done);
        });

      const window = rec.window();
      try {
        for (const k of levels) {
          ctx.signal.throwIfAborted();
          for (let i = subscribers.length; i < k; i += 25) {
            await Promise.all(Array.from({ length: Math.min(25, k - i) }, (_, j) => addSubscriber(i + j)));
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
          const createMs: number[] = [];
          const deleteMs: number[] = [];
          const delivery: number[] = [];
          const deleteDelivery: number[] = [];
          let missing = 0;
          const ids: Array<{ id: string; t0: number }> = [];
          for (let i = 0; i < bookings; i++) {
            const t0 = performance.now();
            const result = await writer.post(paths.createBooking(), bookingBody(person.id, offering.id, String(booker.record.id)), { collect: true });
            createMs.push(result.ms);
            if (result.status !== 200) throw new Error(`create failed: ${result.error}`);
            const id = parseJson<{ id: string }>(result).id;
            ids.push({ id, t0 });
            await allReceived(id, 'created');
            for (const s of subscribers) {
              const at = s.created.get(id);
              if (at === undefined) missing++;
              else delivery.push(at - t0);
            }
          }
          for (const { id } of ids) {
            const t0 = performance.now();
            const result = await writer.delete(paths.booking(id));
            deleteMs.push(result.ms);
            if (result.status !== 204) throw new Error(`delete failed: ${result.error}`);
            await allReceived(id, 'deleted');
            for (const s of subscribers) {
              const at = s.deleted.get(id);
              if (at === undefined) missing++;
              else deleteDelivery.push(at - t0);
            }
          }
          for (const s of subscribers) {
            s.created.clear();
            s.deleted.clear();
          }
          const server = window.server({ from: performance.timeOrigin + performance.now() - 1500, to: performance.timeOrigin + performance.now() });
          const c = latencyStats(createMs);
          const d = latencyStats(deleteMs);
          const del = latencyStats(delivery);
          const dd = latencyStats(deleteDelivery);
          perLevel.set(k, { delivery: del.p95, create: c.p95, del: d.p95, delDelivery: dd.p95 });
          rows.push([k, c.p50, c.p95, d.p50, d.p95, del.p50, del.p95, del.max, dd.p95, missing, server?.rssEndMiB ?? 'n/a']);
          rec.info(`k${k}.delivery.p95`, `${k} subscribers – event delivery p95`, del.p95, 'ms', describeLatency(del));
          if (missing > 0) {
            rec.add({
              key: `k${k}.missing`,
              label: `${k} subscribers – events not delivered within 10 s`,
              value: missing,
              unit: 'count',
              budget: { direction: 'max', fail: 0, rationale: 'every open screen must receive every booking' },
            });
          }
        }
      } finally {
        window.stop();
        for (const s of subscribers) {
          s.sse.close();
          s.client.close();
        }
        writer.close();
      }
      const at20 = perLevel.get(20);
      rec.add({
        key: 'k20.delivery.p95',
        label: '20 subscribers – booking → event received (p95)',
        value: at20?.delivery ?? null,
        unit: 'ms',
        budget: { direction: 'max', warn: 50, fail: 250, rationale: 'the realtime event starts every other screen\'s refresh; baseline ≈ 3.5 ms at 20' },
        detail: at20 ? `create p95 ${at20.create} ms, delete p95 ${at20.del} ms` : 'not measured',
      });
      const at100 = perLevel.get(100);
      rec.add({
        key: 'k100.delete.p95',
        label: '100 subscribers – booking delete (p95)',
        value: at100?.del ?? null,
        unit: 'ms',
        budget: {
          direction: 'max',
          fail: 50,
          rationale: 'deletes prepare the event per subscriber inside the write transaction (blocks all writes); baseline ≈ 9 ms at 100',
        },
        detail: at100 ? `delete event delivery p95 ${at100.delDelivery} ms` : 'not measured',
        explain: (verdict) =>
          verdict === 'fail'
            ? 'every delete holds SQLite\'s only write connection while the event is prepared for each subscriber – all other writes wait'
            : undefined,
      });
      const top = levels.at(-1)!;
      const topLevel = perLevel.get(top);
      if (topLevel) rec.info(`k${top}.create.p95`, `${top} subscribers – booking create (p95)`, topLevel.create, 'ms');
      rec.table('Per number of subscribers (sequential creates, then deletes)', {
        columns: [
          'subscribers',
          'create p50 ms',
          'create p95 ms',
          'delete p50 ms',
          'delete p95 ms',
          'delivery p50 ms',
          'delivery p95 ms',
          'delivery max ms',
          'delete delivery p95 ms',
          'missing',
          'PocketBase RSS MiB',
        ],
        rows,
      });
      rec.note(
        `All ${levels.at(-1)} streams are read by one client thread: an arrival is timed when its chunk is read, so with many ` +
          'subscribers the later ones include a little client-side queueing – the delivery values at the highest level are upper bounds.',
      );
      rec.note(
        `Open realtime streams no longer run JavaScript: static.pb.js registers the SPA's static route itself, so only static requests ` +
          `pass its JS middleware (before the fixes a global middleware pinned one JS VM per stream). The broadcast itself costs tens of µs ` +
          `per subscriber; ${fmt(top)} open streams were held from one client here – see the RSS column for the memory per stream.`,
      );
      rec.data.dbAfter = dbFileSizes(ctx.instance.dataDir);
    },
  );
  return [result];
}
