/**
 * Date helpers: period presets → date ranges → PocketBase filters / totals
 * query parameters. All ranges are computed in the browser's local time zone;
 * `from` is inclusive, `to` is exclusive.
 */

export type PeriodKey = 'today' | '7d' | '30d' | 'all' | 'custom';

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  today: 'Heute',
  '7d': '7 Tage',
  '30d': '30 Tage',
  all: 'Alle',
  custom: 'Von–bis',
};

export interface DateRange {
  from?: Date;
  to?: Date;
}

/** Local midnight of the given day plus `offsetDays` days (DST-safe). */
export function startOfLocalDay(date: Date, offsetDays = 0): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offsetDays);
}

/** Parses a `YYYY-MM-DD` value of an `<input type="date">` as local midnight. */
export function parseDateInput(value: string | undefined | null): Date | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  if (
    date.getFullYear() !== Number(y) ||
    date.getMonth() !== Number(m) - 1 ||
    date.getDate() !== Number(d)
  ) {
    return undefined;
  }
  return date;
}

/** Formats a date as `YYYY-MM-DD` (local) for `<input type="date">`. */
export function toDateInputValue(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Converts a period preset into a date range.
 * - `today`: today 00:00 → tomorrow 00:00
 * - `7d` / `30d`: the last 7 / 30 calendar days including today
 * - `all`: unbounded
 * - `custom`: `customFrom` 00:00 → the day after `customTo` 00:00 (both
 *   `YYYY-MM-DD`, both optional, inclusive days)
 */
export function periodToRange(
  period: PeriodKey,
  now: Date,
  customFrom?: string | null,
  customTo?: string | null,
): DateRange {
  const tomorrow = startOfLocalDay(now, 1);
  switch (period) {
    case 'today':
      return { from: startOfLocalDay(now), to: tomorrow };
    case '7d':
      return { from: startOfLocalDay(now, -6), to: tomorrow };
    case '30d':
      return { from: startOfLocalDay(now, -29), to: tomorrow };
    case 'all':
      return {};
    case 'custom': {
      const from = parseDateInput(customFrom);
      const toDay = parseDateInput(customTo);
      return { from, to: toDay ? startOfLocalDay(toDay, 1) : undefined };
    }
  }
}

/** Formats a date in PocketBase's datetime format `YYYY-MM-DD HH:MM:SS.sssZ` (UTC). */
export function toPbDate(date: Date): string {
  return date.toISOString().replace('T', ' ');
}

/** Parses a PocketBase datetime (`YYYY-MM-DD HH:MM:SS.sssZ`) or ISO string. */
export function parsePbDate(value: string): Date {
  return new Date(value.includes('T') ? value : value.replace(' ', 'T'));
}

/**
 * Quotes a string for use as a literal in a PocketBase filter expression
 * (same escaping as the SDK's `pb.filter()`: only the quote char is escaped).
 */
export function pbQuote(value: string): string {
  return `'${value.replace(/'/g, "\\'")}'`;
}

export interface BookingFilter {
  range: DateRange;
  personId?: string | null;
  createdBy?: string | null;
}

/** Builds the PocketBase `filter` string for listing bookings. */
export function buildBookingsFilter({ range, personId, createdBy }: BookingFilter): string {
  const parts: string[] = [];
  if (range.from) parts.push(`created >= ${pbQuote(toPbDate(range.from))}`);
  if (range.to) parts.push(`created < ${pbQuote(toPbDate(range.to))}`);
  if (personId) parts.push(`person = ${pbQuote(personId)}`);
  if (createdBy) parts.push(`createdBy = ${pbQuote(createdBy)}`);
  return parts.join(' && ');
}

/** Builds the query parameters for `GET /api/app/totals` (ISO 8601 UTC). */
export function buildTotalsQuery({ range, personId, createdBy }: BookingFilter): Record<string, string> {
  const query: Record<string, string> = {};
  if (range.from) query.from = range.from.toISOString();
  if (range.to) query.to = range.to.toISOString();
  if (personId) query.person = personId;
  if (createdBy) query.createdBy = createdBy;
  return query;
}

const weekdayFormat = new Intl.DateTimeFormat('de-AT', { weekday: 'long' });

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `28.09.2026` (local time). */
export function formatDate(date: Date): string {
  return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${date.getFullYear()}`;
}

/** `18:05` (local time). */
export function formatTime(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** `18:05:09` (local time). */
export function formatTimeWithSeconds(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** `28.09.2026, 18:05` (local time). */
export function formatDateTime(date: Date): string {
  return `${formatDate(date)}, ${formatTime(date)}`;
}

/** Heading for a day in lists: `Heute`, `Gestern` or `Montag, 28.09.2026`. */
export function formatDayHeading(date: Date, now: Date): string {
  const day = startOfLocalDay(date).getTime();
  if (day === startOfLocalDay(now).getTime()) return 'Heute';
  if (day === startOfLocalDay(now, -1).getTime()) return 'Gestern';
  return `${weekdayFormat.format(date)}, ${formatDate(date)}`;
}
