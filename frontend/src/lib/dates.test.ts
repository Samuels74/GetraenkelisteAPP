import {
  buildBookingsFilter,
  buildTotalsQuery,
  formatDate,
  formatDateTime,
  formatDayHeading,
  formatTime,
  formatTimeWithSeconds,
  parseDateInput,
  parsePbDate,
  pbQuote,
  periodToRange,
  toDateInputValue,
  toPbDate,
} from './dates';

// vite.config.ts pins TZ=Europe/Vienna for the test run (CEST = UTC+2 in September).
describe('time zone setup', () => {
  it('runs the tests in Europe/Vienna', () => {
    expect(new Date(2026, 8, 28).getTimezoneOffset()).toBe(-120);
  });
});

describe('toPbDate / parsePbDate', () => {
  it('formats in PocketBase datetime format (UTC)', () => {
    expect(toPbDate(new Date('2026-09-28T18:32:05.123Z'))).toBe('2026-09-28 18:32:05.123Z');
  });

  it('parses PocketBase and ISO datetimes', () => {
    expect(parsePbDate('2026-09-28 18:32:05.123Z').toISOString()).toBe('2026-09-28T18:32:05.123Z');
    expect(parsePbDate('2026-09-28T18:32:05.123Z').toISOString()).toBe('2026-09-28T18:32:05.123Z');
  });
});

describe('periodToRange', () => {
  const now = new Date(2026, 8, 28, 1, 30); // 28.09.2026 01:30 local

  it('today = local midnight to next local midnight', () => {
    const range = periodToRange('today', now);
    expect(range.from?.toISOString()).toBe('2026-09-27T22:00:00.000Z');
    expect(range.to?.toISOString()).toBe('2026-09-28T22:00:00.000Z');
  });

  it('7 days includes today and the 6 previous days', () => {
    const range = periodToRange('7d', now);
    expect(range.from?.toISOString()).toBe('2026-09-21T22:00:00.000Z');
    expect(range.to?.toISOString()).toBe('2026-09-28T22:00:00.000Z');
  });

  it('30 days includes today and the 29 previous days', () => {
    const range = periodToRange('30d', now);
    expect(range.from?.toISOString()).toBe('2026-08-29T22:00:00.000Z');
    expect(range.to?.toISOString()).toBe('2026-09-28T22:00:00.000Z');
  });

  it('all is unbounded', () => {
    expect(periodToRange('all', now)).toEqual({});
  });

  it('custom range includes both days', () => {
    const range = periodToRange('custom', now, '2026-09-01', '2026-09-03');
    expect(range.from?.toISOString()).toBe('2026-08-31T22:00:00.000Z');
    expect(range.to?.toISOString()).toBe('2026-09-03T22:00:00.000Z');
  });

  it('custom range may be open on either side', () => {
    expect(periodToRange('custom', now, '2026-09-01', '')).toEqual({
      from: new Date(2026, 8, 1),
      to: undefined,
    });
    expect(periodToRange('custom', now, null, '2026-09-01')).toEqual({
      from: undefined,
      to: new Date(2026, 8, 2),
    });
  });

  it('handles the DST switch (25-hour day on 25.10.2026)', () => {
    const range = periodToRange('today', new Date(2026, 9, 25, 12));
    expect(range.from?.toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(range.to?.toISOString()).toBe('2026-10-25T23:00:00.000Z');
  });
});

describe('date input helpers', () => {
  it('parses valid YYYY-MM-DD values as local midnight', () => {
    expect(parseDateInput('2026-02-28')).toEqual(new Date(2026, 1, 28));
  });

  it('rejects invalid values', () => {
    expect(parseDateInput('')).toBeUndefined();
    expect(parseDateInput(undefined)).toBeUndefined();
    expect(parseDateInput('2026-02-30')).toBeUndefined();
    expect(parseDateInput('28.09.2026')).toBeUndefined();
  });

  it('formats dates for <input type=date>', () => {
    expect(toDateInputValue(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});

describe('buildBookingsFilter', () => {
  const range = periodToRange('today', new Date(2026, 8, 28, 12));

  it('returns an empty filter without constraints', () => {
    expect(buildBookingsFilter({ range: {} })).toBe('');
  });

  it('combines date range, person and creator', () => {
    expect(buildBookingsFilter({ range, personId: 'p1', createdBy: 'u1' })).toBe(
      "created >= '2026-09-27 22:00:00.000Z' && created < '2026-09-28 22:00:00.000Z'" +
        " && person = 'p1' && createdBy = 'u1'",
    );
  });

  it('supports single-sided ranges', () => {
    expect(buildBookingsFilter({ range: { from: new Date('2026-09-01T10:00:00Z') } })).toBe(
      "created >= '2026-09-01 10:00:00.000Z'",
    );
  });

  it('escapes quotes in values', () => {
    expect(pbQuote("a'b")).toBe("'a\\'b'");
    expect(buildBookingsFilter({ range: {}, personId: "x' || id != '" })).toBe(
      "person = 'x\\' || id != \\''",
    );
  });
});

describe('buildTotalsQuery', () => {
  it('uses ISO 8601 UTC timestamps', () => {
    const range = periodToRange('today', new Date(2026, 8, 28, 12));
    expect(buildTotalsQuery({ range, personId: 'p1', createdBy: null })).toEqual({
      from: '2026-09-27T22:00:00.000Z',
      to: '2026-09-28T22:00:00.000Z',
      person: 'p1',
    });
  });

  it('omits empty parameters', () => {
    expect(buildTotalsQuery({ range: {} })).toEqual({});
  });
});

describe('formatting', () => {
  const date = new Date('2026-09-28T16:05:09.000Z'); // 18:05:09 in Vienna

  it('formats local date and time', () => {
    expect(formatDate(date)).toBe('28.09.2026');
    expect(formatTime(date)).toBe('18:05');
    expect(formatTimeWithSeconds(date)).toBe('18:05:09');
    expect(formatDateTime(date)).toBe('28.09.2026, 18:05');
  });

  it('formats day headings relative to now', () => {
    const now = new Date(2026, 8, 28, 20);
    expect(formatDayHeading(new Date(2026, 8, 28, 0, 1), now)).toBe('Heute');
    expect(formatDayHeading(new Date(2026, 8, 27, 23, 59), now)).toBe('Gestern');
    expect(formatDayHeading(new Date(2026, 8, 21, 12), now)).toBe('Montag, 21.09.2026');
  });
});
