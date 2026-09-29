import { fetchAllKeyset, keysetFilter } from './keyset';

interface Row {
  id: string;
  created: string;
}

const byNewest = (a: Row, b: Row) =>
  a.created < b.created ? 1 : a.created > b.created ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;

/** In-memory "server" that understands the keyset filter produced by keysetFilter(). */
function liveStore(initial: Row[]) {
  let rows = [...initial];
  const calls: string[] = [];
  return {
    calls,
    insert: (row: Row) => {
      rows.push(row);
    },
    remove: (id: string) => {
      rows = rows.filter((r) => r.id !== id);
    },
    fetchPage: (onPage?: (page: number) => void) => async (filter: string, size: number) => {
      calls.push(filter);
      onPage?.(calls.length);
      const cursor = /created < '([^']+)' \|\| \(created = '([^']+)' && id < '([^']+)'\)/.exec(filter);
      let list = [...rows].sort(byNewest);
      if (cursor) list = list.filter((r) => r.created < cursor[1]! || (r.created === cursor[2]! && r.id < cursor[3]!));
      return list.slice(0, size);
    },
  };
}

function rowsFor(count: number): Row[] {
  // two rows per millisecond → ties on `created` are exercised as well
  return Array.from({ length: count }, (_, i) => ({
    id: `id${String(i).padStart(5, '0')}`,
    created: `2026-09-28 18:00:${String(Math.floor(i / 2 / 1000)).padStart(2, '0')}.${String(Math.floor(i / 2) % 1000).padStart(3, '0')}Z`,
  }));
}

describe('keysetFilter', () => {
  it('builds the "older than cursor" condition on (created, id)', () => {
    expect(keysetFilter('', null)).toBe('');
    expect(keysetFilter("person = 'p1'", null)).toBe("(person = 'p1')");
    expect(keysetFilter("person = 'p1'", { created: '2026-09-28 18:00:00.123Z', id: 'abc' })).toBe(
      "(person = 'p1') && (created < '2026-09-28 18:00:00.123Z' || (created = '2026-09-28 18:00:00.123Z' && id < 'abc'))",
    );
  });
});

describe('fetchAllKeyset', () => {
  it('loads all rows across pages without duplicates (incl. created ties)', async () => {
    const store = liveStore(rowsFor(1201));
    const rows = await fetchAllKeyset(store.fetchPage(), '', 500);
    expect(rows).toHaveLength(1201);
    expect(new Set(rows.map((r) => r.id)).size).toBe(1201);
    expect(store.calls).toHaveLength(3);
  });

  it('stays consistent when a booking is created while paging (no duplicate, no drop)', async () => {
    const initial = rowsFor(520);
    const store = liveStore(initial);
    const rows = await fetchAllKeyset(
      store.fetchPage((page) => {
        if (page === 2) store.insert({ id: 'new', created: '2026-09-28 19:00:00.000Z' }); // newest
      }),
      '',
      500,
    );
    expect(rows).toHaveLength(520);
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(initial.map((r) => r.id)));
  });

  it('does not skip rows when an already exported booking is cancelled while paging', async () => {
    const initial = rowsFor(520); // index 519 is the newest
    const store = liveStore(initial);
    const rows = await fetchAllKeyset(
      store.fetchPage((page) => {
        if (page === 2) store.remove(initial[519]!.id); // was on page 1
      }),
      '',
      500,
    );
    // offset paging would now skip one row; keyset paging still returns all of them
    expect(rows).toHaveLength(520);
    expect(new Set(rows.map((r) => r.id)).size).toBe(520);
  });

  it('omits a not yet exported booking that is cancelled while paging', async () => {
    const initial = rowsFor(520);
    const store = liveStore(initial);
    const rows = await fetchAllKeyset(
      store.fetchPage((page) => {
        if (page === 2) store.remove(initial[0]!.id); // oldest, still to come
      }),
      '',
      500,
    );
    expect(rows).toHaveLength(519);
    expect(rows.some((r) => r.id === initial[0]!.id)).toBe(false);
  });

  it('handles an empty result and exact page multiples', async () => {
    expect(await fetchAllKeyset(liveStore([]).fetchPage(), '', 500)).toEqual([]);
    const store = liveStore(rowsFor(1000));
    expect(await fetchAllKeyset(store.fetchPage(), '', 500)).toHaveLength(1000);
    expect(store.calls).toHaveLength(3); // last page is empty
  });
});
