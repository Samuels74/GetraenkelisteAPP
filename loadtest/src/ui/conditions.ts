/**
 * "Ready" conditions of the app's screens for the in-page watches (page-probe.js).
 * Every condition describes the *expected new* content – counts, the first
 * row, texts computed from API data with the SPA's own rules (search.ts) – so
 * it can neither be satisfied by a skeleton nor by the previous content.
 *
 * Cost matters: the checks run in the measured page after DOM mutations, so
 * long lists are checked via the container's childElementCount and the first
 * row (React commits a list in one go), never by scanning 20,000 nodes.
 *
 * Elements that fade in must be *visibly* painted (`visible`: effective
 * opacity ≥ 0.5): sonner mounts a new toast at opacity 0 and fades it in over
 * 0.4 s, the picker <dialog> animates in over 0.22 s (sheet-in).
 */
import type { Cond, Conds } from './probe.ts';
import type { Person } from './rest.ts';
import { count, euro } from './search.ts';

/** Selectors (data-testid attributes of the components; see the frontend). */
export const SEL = {
  tile: '[data-testid="offering-tile"]',
  currentPerson: '[data-testid="current-person"]',
  currentTotal: '[data-testid="current-person-total"]',
  currentCount: '[data-testid="current-person-count"]',
  recentSection: '[data-testid="recent-bookings"]',
  recentList: '[data-testid="recent-bookings"] > ul',
  recentFirst: '[data-testid="recent-bookings"] [data-testid="booking-item"]',
  toastTitle: '[data-sonner-toast]:not([data-removed="true"]) [data-title]',
  picker: '[data-testid="person-picker"]',
  pickerSearch: '[data-testid="person-search"]',
  pickerList: '[data-testid="person-picker"] ul[aria-label="Personen"]',
  pickerFirst: '[data-testid="person-picker"] [data-testid="person-option"]',
  pickerMore: '[data-testid="person-picker"] ul[aria-label="Personen"] > li:last-child',
  pickerOption: '[data-testid="person-picker"] [data-testid="person-option"]',
  personsSearch: '[data-testid="persons-search"]',
  personsList: 'ul[aria-label="Personen"]',
  personRow: '[data-testid="person-row"]',
  /** "100 von 2000 Personen angezeigt" + "Weitere 100 anzeigen" below the Personen list (only while rows are hidden). */
  personsMore: '[data-testid="persons-more"]',
  pageContent: '[data-testid="page-content"]',
  qrSheet: '[data-testid="qr-sheet"]',
  qrHeaderCount: 'header p',
  /** "Weitere QR-Codes werden erstellt …" – only while the sheet is still growing. */
  qrProgress: '[data-testid="qr-sheet-progress"]',
  bookingsList: '[data-testid="bookings-list"]',
  bookingItem: '[data-testid="bookings-list"] [data-testid="booking-item"]',
  bookingsCount: '[data-testid="bookings-count"]',
  bookingsTotal: '[data-testid="bookings-total"]',
  perPersonList: '[data-testid="totals-per-person"]',
  perPersonRow: '[data-testid="totals-person-row"]',
  perPersonMore: '[data-testid="totals-per-person-more"]',
  personFilter: '[data-testid="person-filter"]',
  personFilterClear: '[data-testid="person-filter-clear"]',
  perOffering: '[data-testid="totals-per-offering"]',
  perOfferingRow: '[data-testid="totals-offering-row"]',
  offeringRow: '[data-testid="offering-row"]',
  userRow: '[data-testid="user-row"]',
} as const;

/** The app's page size of the Buchungen list and the picker's result cap. */
export const BOOKINGS_PAGE_SIZE = 50;
export const PICKER_MAX_RESULTS = 60;
export const RECENT_LIMIT = 8;
/** Rows of Personen / "Pro Person" rendered at first and added per "Weitere … anzeigen" (frontend/src/lib/useShowMore.ts). */
export const LIST_PAGE_SIZE = 100;

/** "1 Buchung", "2.000 Personen" – counts in the app's format (lib/money.ts formatCount). */
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;

// ------------------------------------------------------------------ Buchen

export interface BuchenExpectation {
  offerings: number;
  person: Person;
  totalCents: number;
  /** All bookings of the person (the card shows the total, the list the latest 8). */
  count: number;
}

/** Buchen with a selected person: tiles, person card with its total, recent bookings. */
export function buchenLoad(e: BuchenExpectation): Conds {
  const tiles: Cond = { sel: SEL.tile, count: e.offerings };
  const recent: Cond =
    e.count > 0
      ? { sel: SEL.recentList, children: Math.min(RECENT_LIMIT, e.count) }
      : { sel: SEL.recentSection, contains: 'Noch keine Buchungen.' };
  return {
    tiles,
    ready: {
      all: [
        { sel: SEL.currentPerson, attr: ['data-person-number', e.person.number] },
        { sel: SEL.currentTotal, text: euro(e.totalCents) },
        tiles,
        recent,
      ],
    },
  };
}

/** Buchen without a selected person (the offering tiles are the screen). */
export function buchenTiles(offerings: number): Conds {
  return { ready: { sel: SEL.tile, count: offerings } };
}

export function bookingToast(offeringName: string, priceCents: number): Cond {
  return { sel: SEL.toastTitle, anyContains: `${offeringName} gebucht · ${euro(priceCents)}`, visible: true };
}

export function personTotal(totalCents: number, count: number): Cond {
  return {
    all: [
      { sel: SEL.currentTotal, text: euro(totalCents) },
      { sel: SEL.currentCount, text: `· ${plural(count, 'Buchung', 'Buchungen')}` },
    ],
  };
}

export const UNDO_TOAST: Cond = { sel: SEL.toastTitle, anyContains: 'Buchung rückgängig gemacht', visible: true };

// ------------------------------------------------------------------ person picker

/** What the picker shows for a result list: ≤ 60 options + "… und N weitere". */
export function pickerState(results: readonly Person[]): Cond {
  const first = results[0];
  if (!first) return { sel: SEL.picker, contains: 'Keine Person gefunden', visible: true };
  const shown = Math.min(PICKER_MAX_RESULTS, results.length);
  const more = results.length - shown;
  const parts: Cond[] = [
    { sel: SEL.pickerList, children: shown + (more > 0 ? 1 : 0), visible: true },
    { sel: SEL.pickerFirst, attr: ['data-person-number', first.number] },
  ];
  if (more > 0) parts.push({ sel: SEL.pickerMore, contains: `und ${count(more)} weitere` });
  return { all: parts };
}

/** Distinguishes visible picker states (equal signature = no visible change). */
export function pickerSignature(results: readonly Person[]): string {
  return `${Math.min(PICKER_MAX_RESULTS, results.length)}|${results[0]?.number ?? ''}|${results.length}`;
}

// ------------------------------------------------------------------ Personen / "Pro Person": capped lists

/**
 * The footer of a capped list (components/ShowMoreFooter.tsx): "<shown> von
 * <total> Personen angezeigt" while rows are hidden, absent once all are shown.
 */
function showMoreFooter(sel: string, shown: number, total: number): Cond {
  return shown < total ? { sel: `${sel} [role="status"]`, text: `${count(shown)} von ${count(total)} Personen angezeigt` } : { sel, absent: true };
}

/** The Personen list for a result list: the first `limit` matches (100 + 100 per "Weitere 100 anzeigen") and the footer. */
export function personenState(results: readonly Person[], limit = LIST_PAGE_SIZE): Cond {
  const first = results[0];
  if (!first) return { sel: SEL.pageContent, contains: 'Keine Person gefunden' };
  const shown = Math.min(limit, results.length);
  return {
    all: [
      { sel: SEL.personsList, children: shown },
      { sel: SEL.personRow, attr: ['data-person-number', first.number] },
      showMoreFooter(SEL.personsMore, shown, results.length),
    ],
  };
}

/** Distinguishes visible Personen states (rows shown, first row, the footer's total). */
export function personenSignature(results: readonly Person[], limit = LIST_PAGE_SIZE): string {
  return `${Math.min(limit, results.length)}|${results[0]?.number ?? ''}|${results.length}`;
}

/**
 * Personen loaded: `rows` = the first 100 persons rendered, `ready` = also
 * the totals (the first row that has bookings shows its amount – the totals
 * arrive in one commit for all rows). `firstWithTotal` must be one of the
 * rendered rows.
 */
export function personenLoad(persons: readonly Person[], firstWithTotal: { person: Person; totalCents: number } | null): Conds {
  const rows = personenState(persons);
  if (!firstWithTotal) return { rows, ready: rows };
  const row = `${SEL.personRow}[data-person-number="${firstWithTotal.person.number}"]`;
  return { rows, ready: { all: [rows, { sel: row, contains: euro(firstWithTotal.totalCents) }] } };
}

/** A Personen row shows a new total (realtime update). */
export function personRowTotal(person: Person, totalCents: number, count: number): Cond {
  return {
    all: [
      { sel: `${SEL.personRow}[data-person-number="${person.number}"]`, contains: euro(totalCents) },
      { sel: `${SEL.personRow}[data-person-number="${person.number}"]`, contains: plural(count, 'Buchung', 'Buchungen') },
    ],
  };
}

// ------------------------------------------------------------------ QR sheet

/**
 * The QR sheet: the cards are added step by step (100, 200, 400, 800 …);
 * `first` = the first 100 cards painted, `ready` = every card painted and the
 * progress hint gone (printing is enabled only then). The header count is
 * shown from the start, so it is no completion signal on its own.
 */
export function qrSheetLoad(persons: number): Conds {
  const header: Cond = { sel: SEL.qrHeaderCount, text: plural(persons, 'Person', 'Personen') };
  return {
    first: { all: [{ sel: SEL.qrSheet, minChildren: Math.min(100, persons) }, header] },
    ready: { all: [{ sel: SEL.qrSheet, children: persons }, header, { sel: SEL.qrProgress, absent: true }] },
  };
}

// ------------------------------------------------------------------ Buchungen

export interface ListExpectation {
  /** URLSearchParams string of the filter, as BookingsPage puts it into data-filter. */
  filterKey: string;
  count: number;
  totalCents: number;
  /** Loaded pages (k × 50 rows). */
  pages?: number;
}

/** The booking list for a filter: list for that filter, k pages of rows, summary count + sum. */
export function bookingsState(e: ListExpectation): Cond {
  const summary: Cond[] = [
    { sel: SEL.bookingsCount, text: count(e.count) },
    { sel: SEL.bookingsTotal, text: euro(e.totalCents) },
  ];
  if (e.count === 0) {
    return { all: [...summary, { sel: SEL.pageContent, contains: 'Für diesen Filter gibt es keine Buchungen.' }] };
  }
  return {
    all: [
      { sel: `${SEL.bookingsList}[data-filter="${e.filterKey}"]` },
      ...summary,
      { sel: SEL.bookingItem, count: Math.min(BOOKINGS_PAGE_SIZE * (e.pages ?? 1), e.count) },
    ],
  };
}

/** Per person view: one row per person with bookings, natural order – the first `limit` rows and the footer. */
export function perPersonState(numbers: readonly string[], limit = LIST_PAGE_SIZE): Cond {
  const first = numbers[0];
  if (first === undefined) return { sel: SEL.pageContent, contains: 'Keine Buchungen' };
  const shown = Math.min(limit, numbers.length);
  return {
    all: [
      { sel: SEL.perPersonList, children: shown },
      { sel: SEL.perPersonRow, attr: ['data-person-number', first] },
      showMoreFooter(SEL.perPersonMore, shown, numbers.length),
    ],
  };
}

export function perOfferingState(rows: number): Cond {
  if (rows === 0) return { sel: SEL.pageContent, contains: 'Keine Buchungen' };
  return { all: [{ sel: SEL.perOffering }, { sel: SEL.perOfferingRow, count: rows }] };
}

export function exportDone(count: number): Conds {
  return {
    toast: { sel: SEL.toastTitle, anyContains: `${plural(count, 'Buchung', 'Buchungen')} exportiert`, visible: true },
    blob: { blob: true },
  };
}

// ------------------------------------------------------------------ Verwaltung

/** Angebote: all rows, and the per-offering totals arrived ("Gebucht" badges). */
export function angeboteLoad(rows: number, booked: number): Conds {
  const list: Cond = { sel: SEL.offeringRow, count: rows };
  return { rows: list, ready: { all: [list, { sel: SEL.offeringRow, countContains: ['Gebucht', booked] }] } };
}

export function benutzerLoad(rows: number): Conds {
  return { ready: { sel: SEL.userRow, count: rows } };
}
