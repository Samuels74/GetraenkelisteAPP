/**
 * Parts of `GET /api/app/totals` (`parts=`, ARCHITECTURE.md §5). Every screen
 * asks only for what it shows: the per-person part is the expensive one (one
 * row per person – ≈250 KiB and most of the server time with 2000 persons),
 * the summary is a few bytes (docs/LOADTEST-FINDINGS.md F2).
 *
 * The parts are part of the query key, so the same filter with different parts
 * is a different cache entry; a response is cut down to the requested parts,
 * so the cache never depends on whether the server honoured `parts`.
 */
import type { Totals, TotalsPart } from '../lib/types';

export const ALL_TOTALS_PARTS: readonly TotalsPart[] = ['summary', 'perPerson', 'perOffering', 'perUser'];

/** Canonical form for query keys: fixed order, no duplicates; missing or empty = all parts. */
export function normalizeParts(parts?: readonly TotalsPart[] | null): TotalsPart[] {
  if (!parts || parts.length === 0) return [...ALL_TOTALS_PARTS];
  return ALL_TOTALS_PARTS.filter((part) => parts.includes(part));
}

/** Value of the `parts` query parameter; `undefined` (= omit it) when all parts are wanted. */
export function partsParam(parts?: readonly TotalsPart[] | null): string | undefined {
  const normalized = normalizeParts(parts);
  return normalized.length === ALL_TOTALS_PARTS.length ? undefined : normalized.join(',');
}

function hasPart(totals: Totals, part: TotalsPart): boolean {
  switch (part) {
    case 'summary':
      return totals.count !== undefined && totals.quantity !== undefined && totals.totalCents !== undefined;
    case 'perPerson':
      return Array.isArray(totals.perPerson);
    case 'perOffering':
      return Array.isArray(totals.perOffering);
    case 'perUser':
      return Array.isArray(totals.perUser);
  }
}

/** Whether `totals` contains all of `parts`. */
export function hasTotalsParts(totals: Totals | undefined, parts?: readonly TotalsPart[] | null): boolean {
  return Boolean(totals) && normalizeParts(parts).every((part) => hasPart(totals!, part));
}

/** The requested parts of `totals` (those that are present). */
export function pickTotals(totals: Totals, parts?: readonly TotalsPart[] | null): Totals {
  const result: Totals = {};
  for (const part of normalizeParts(parts)) {
    if (!hasPart(totals, part)) continue;
    if (part === 'summary') {
      result.count = totals.count;
      result.quantity = totals.quantity;
      result.totalCents = totals.totalCents;
    } else {
      // only the requested arrays are copied (hasPart checked that they exist)
      Object.assign(result, { [part]: totals[part] });
    }
  }
  return result;
}
