/**
 * CSV export (ARCHITECTURE.md §6): UTF-8 with BOM, `;` separator, decimal
 * comma, CRLF line endings, fields quoted when needed.
 */
import { formatDate, formatTimeWithSeconds, parsePbDate } from './dates';
import { formatCentsPlain } from './money';
import type { BookingRecord } from './types';

export const CSV_BOM = '﻿';
export const CSV_SEPARATOR = ';';

export const BOOKING_CSV_COLUMNS = [
  'Datum',
  'Uhrzeit',
  'Nummer',
  'Name',
  'Nickname',
  'Gruppe',
  'Angebot',
  'Anzahl',
  'Einzelpreis',
  'Summe',
  'Gebucht von',
] as const;

/** Quotes a field if it contains the separator, quotes, line breaks or edge whitespace. */
export function csvEscape(value: string): string {
  if (/[";\r\n]/.test(value) || value !== value.trim()) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Neutralizes spreadsheet formula injection for free-text fields
 * (values starting with `=`, `+`, `-`, `@`, tab or CR are prefixed with `'`).
 */
export function csvText(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** Serializes rows (first row = header) to a CSV string with BOM. */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  return CSV_BOM + rows.map((row) => row.map(csvEscape).join(CSV_SEPARATOR)).join('\r\n') + '\r\n';
}

/** One CSV row per booking; bookings must be loaded with `expand=person,offering.group,createdBy`. */
export function bookingToCsvRow(booking: BookingRecord): string[] {
  const created = parsePbDate(booking.created);
  const person = booking.expand?.person;
  const offering = booking.expand?.offering;
  const group = offering?.expand?.group;
  const user = booking.expand?.createdBy;
  return [
    formatDate(created),
    formatTimeWithSeconds(created),
    csvText(person?.number ?? ''),
    csvText(person?.name ?? ''),
    csvText(person?.nickname ?? ''),
    csvText(group?.name ?? ''),
    csvText(offering?.name ?? ''),
    String(booking.quantity),
    formatCentsPlain(booking.unitPriceCents),
    formatCentsPlain(booking.quantity * booking.unitPriceCents),
    csvText(user?.username ?? ''),
  ];
}

export function bookingsToCsv(bookings: readonly BookingRecord[]): string {
  return toCsv([[...BOOKING_CSV_COLUMNS], ...bookings.map(bookingToCsvRow)]);
}
