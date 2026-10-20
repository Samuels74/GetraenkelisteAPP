/**
 * Small helpers shared by several scenarios.
 */
import { sleep, type PerfContext } from '../scenario.ts';


/**
 * Warnings and errors PocketBase logged since `from` (storage format
 * "YYYY-MM-DD HH:MM:SS.sssZ"). PocketBase writes its request log in batches
 * (every 3 s or 200 entries, core/base.go), so this waits for one batch.
 */
export async function serverErrorLog(ctx: PerfContext, from: string): Promise<{ count: number; entries: string[] }> {
  await sleep(3_500, ctx.signal);
  const superuser = await ctx.instance.superuserClient();
  const list = await superuser.logs.getList(1, 50, {
    filter: superuser.filter('level > 0 && created >= {:from}', { from }),
    sort: '-created',
  });
  return {
    count: list.totalItems,
    entries: list.items.map((entry) => {
      const data = entry.data as { status?: number; url?: string; error?: unknown; details?: unknown };
      return [entry.message, data.status, data.url, data.error ? JSON.stringify(data.error) : '', data.details ? JSON.stringify(data.details) : '']
        .filter((part) => part !== undefined && part !== '')
        .join(' ');
    }),
  };
}

/** The total number of bookings (one request with the total count). */
export async function bookingCount(ctx: PerfContext, filter = ''): Promise<number> {
  const superuser = await ctx.instance.superuserClient();
  return (await superuser.collection('bookings').getList(1, 1, { filter, fields: 'id' })).totalItems;
}
