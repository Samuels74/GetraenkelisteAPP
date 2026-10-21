import { pb } from '../lib/pb';
import type { Totals } from '../lib/types';
import { fetchTotals, periodRangeKey, queryKeys } from './queries';
import { hasTotalsParts, normalizeParts, partsParam, pickTotals } from './totals';

const FULL: Totals = {
  count: 3,
  quantity: 4,
  totalCents: 900,
  perPerson: [{ personId: 'p1', number: '1', name: 'A', nickname: '', count: 3, quantity: 4, totalCents: 900 }],
  perOffering: [{ offeringId: 'o1', name: 'Bier', groupId: 'g1', groupName: 'G', count: 3, quantity: 4, totalCents: 900 }],
  perUser: [{ userId: 'u1', username: 'anna', name: '', count: 3, quantity: 4, totalCents: 900 }],
};

describe('totals parts', () => {
  it('normalizes parts to a canonical order; nothing = all', () => {
    expect(normalizeParts(['perPerson', 'summary', 'perPerson'])).toEqual(['summary', 'perPerson']);
    expect(normalizeParts()).toEqual(['summary', 'perPerson', 'perOffering', 'perUser']);
    expect(normalizeParts([])).toEqual(['summary', 'perPerson', 'perOffering', 'perUser']);
  });

  it('sends `parts` only for a subset', () => {
    expect(partsParam(['perUser', 'summary'])).toBe('summary,perUser');
    expect(partsParam(['perUser', 'perOffering', 'perPerson', 'summary'])).toBeUndefined();
    expect(partsParam()).toBeUndefined();
  });

  it('keeps only the requested parts and tells which are there', () => {
    expect(pickTotals(FULL, ['summary'])).toEqual({ count: 3, quantity: 4, totalCents: 900 });
    expect(pickTotals(FULL, ['perOffering'])).toEqual({ perOffering: FULL.perOffering });
    expect(pickTotals({ count: 1, quantity: 1, totalCents: 1 }, ['summary', 'perPerson'])).toEqual({
      count: 1,
      quantity: 1,
      totalCents: 1,
    });
    expect(hasTotalsParts(FULL, ['summary', 'perUser'])).toBe(true);
    expect(hasTotalsParts({ count: 0, quantity: 0, totalCents: 0 }, ['summary', 'perPerson'])).toBe(false);
    // an empty array is a part that is there ("no bookings")
    expect(hasTotalsParts({ perPerson: [] }, ['perPerson'])).toBe(true);
    expect(hasTotalsParts(undefined, ['summary'])).toBe(false);
  });

  it('puts the parts into the query key (canonical)', () => {
    expect(queryKeys.totalsFor({ period: 'all' }, ['perPerson', 'summary'])).toEqual([
      'totals',
      { period: 'all' },
      ['summary', 'perPerson'],
    ]);
    expect(queryKeys.totalsFor({ period: 'all' })).toEqual([
      'totals',
      { period: 'all' },
      ['summary', 'perPerson', 'perOffering', 'perUser'],
    ]);
  });
});

describe('fetchTotals', () => {
  afterEach(() => vi.restoreAllMocks());

  it('requests only the given parts, after the filters; keeps the period it was computed for', async () => {
    const send = vi.spyOn(pb, 'send').mockResolvedValue({ count: 1, quantity: 1, totalCents: 250 });
    const now = new Date('2026-10-20T10:00:00Z');
    const query = { period: 'today' as const, personId: 'p1' };
    await expect(fetchTotals(query, ['summary'], now)).resolves.toEqual({
      count: 1,
      quantity: 1,
      totalCents: 250,
      // Vienna: 20 Oct 00:00 – 21 Oct 00:00 (moves at midnight, see bookingSync.ts)
      range: '2026-10-19T22:00:00.000Z/2026-10-20T22:00:00.000Z',
    });
    expect(periodRangeKey(query, now)).toBe('2026-10-19T22:00:00.000Z/2026-10-20T22:00:00.000Z');
    const [path, options] = send.mock.calls[0]!;
    expect(path).toBe('/api/app/totals');
    const params = (options as { query: Record<string, string> }).query;
    expect(Object.keys(params)).toEqual(['from', 'to', 'person', 'parts']);
    expect(params).toMatchObject({ person: 'p1', parts: 'summary' });
  });

  it('sends no `parts` for all parts', async () => {
    const send = vi.spyOn(pb, 'send').mockResolvedValue(FULL);
    await expect(fetchTotals({ period: 'all' })).resolves.toEqual({ ...FULL, range: '/' });
    expect((send.mock.calls[0]![1] as { query: Record<string, string> }).query).toEqual({});
  });

  it('cuts a response that contains more than requested (a server without `parts`)', async () => {
    vi.spyOn(pb, 'send').mockResolvedValue(FULL);
    await expect(fetchTotals({ period: 'all' }, ['perUser'])).resolves.toEqual({ perUser: FULL.perUser, range: '/' });
  });

  it('fails when a requested part is missing (instead of showing "no bookings")', async () => {
    vi.spyOn(pb, 'send').mockResolvedValue({ count: 1, quantity: 1, totalCents: 1 });
    await expect(fetchTotals({ period: 'all' }, ['summary', 'perPerson'])).rejects.toThrow(/Summen/);
  });
});
