/**
 * Wall-clock helpers for one IANA time zone, built on Intl only (no date
 * library). The SPA computes its period filters (Heute / 7 Tage / 30 Tage) in
 * the browser's local time zone and the generated bookings follow a bar's
 * evening rhythm in local time, so both need local-midnight / local-time ↔
 * UTC conversions. Precision is sufficient for test data: times inside the
 * spring-forward gap or the autumn overlap may land one hour off.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface LocalDate {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let result = formatters.get(timeZone);
  if (!result) {
    result = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, result);
  }
  return result;
}

/** Throws a RangeError for unknown time zones. */
export function assertTimeZone(timeZone: string): void {
  formatter(timeZone);
}

interface WallClock extends LocalDate {
  hour: number;
  minute: number;
  second: number;
}

function wallClock(utcMs: number, timeZone: string): WallClock {
  const values: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year ?? NaN,
    month: values.month ?? NaN,
    day: values.day ?? NaN,
    hour: values.hour ?? NaN,
    minute: values.minute ?? NaN,
    second: values.second ?? NaN,
  };
}

/** UTC offset of the zone at the given instant (local = UTC + offset). */
export function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const w = wallClock(utcMs, timeZone);
  const localAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return localAsUtc - Math.floor(utcMs / 1000) * 1000;
}

/** The calendar date in the zone at the given instant. */
export function localDateOf(utcMs: number, timeZone: string): LocalDate {
  const { year, month, day } = wallClock(utcMs, timeZone);
  return { year, month, day };
}

/** Milliseconds since local midnight (wall clock) at the given instant. */
export function localTimeOfDayMs(utcMs: number, timeZone: string): number {
  const w = wallClock(utcMs, timeZone);
  const millis = ((utcMs % 1000) + 1000) % 1000;
  return ((w.hour * 60 + w.minute) * 60 + w.second) * 1000 + millis;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** UTC instant of the wall-clock time `msOfDay` (after local midnight) on a local date. */
export function zonedTimeToUtc(date: LocalDate, msOfDay: number, timeZone: string): number {
  const naive = Date.UTC(date.year, date.month - 1, date.day) + msOfDay;
  let utc = naive - zoneOffsetMs(naive, timeZone);
  utc = naive - zoneOffsetMs(utc, timeZone);
  return utc;
}

/** Local midnight of the day of `utcMs` plus `offsetDays` days, as UTC instant. */
export function startOfLocalDay(utcMs: number, timeZone: string, offsetDays = 0): number {
  return zonedTimeToUtc(addDays(localDateOf(utcMs, timeZone), offsetDays), 0, timeZone);
}

export interface TimeRange {
  /** inclusive, UTC ms */
  from?: number;
  /** exclusive, UTC ms */
  to?: number;
}

export type PeriodKey = 'today' | '7d' | '30d' | 'all';

/**
 * The SPA's period presets (frontend/src/lib/dates.ts periodToRange) for a
 * browser in `timeZone` at `nowMs`.
 */
export function periodRanges(nowMs: number, timeZone: string): Record<PeriodKey, TimeRange> {
  const tomorrow = startOfLocalDay(nowMs, timeZone, 1);
  return {
    today: { from: startOfLocalDay(nowMs, timeZone), to: tomorrow },
    '7d': { from: startOfLocalDay(nowMs, timeZone, -6), to: tomorrow },
    '30d': { from: startOfLocalDay(nowMs, timeZone, -29), to: tomorrow },
    all: {},
  };
}

/** Number of timestamps per period preset (as the Buchungen screen would count them). */
export function countPerPeriod(timestamps: readonly number[], nowMs: number, timeZone: string): Record<PeriodKey, number> {
  const ranges = periodRanges(nowMs, timeZone);
  const counts: Record<PeriodKey, number> = { today: 0, '7d': 0, '30d': 0, all: 0 };
  for (const t of timestamps) {
    for (const key of Object.keys(ranges) as PeriodKey[]) {
      const { from, to } = ranges[key];
      if ((from === undefined || t >= from) && (to === undefined || t < to)) counts[key]++;
    }
  }
  return counts;
}

/** PocketBase's datetime storage format `YYYY-MM-DD HH:MM:SS.sssZ` (UTC). */
export function toPbDate(utcMs: number): string {
  return new Date(utcMs).toISOString().replace('T', ' ');
}

/** Parses PocketBase's storage format (or ISO 8601) into UTC ms. */
export function parsePbDate(value: string): number {
  return Date.parse(value.includes('T') ? value : value.replace(' ', 'T'));
}
