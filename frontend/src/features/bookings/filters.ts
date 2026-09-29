/**
 * Booking filters ↔ URL search params (so filters survive reloads and can be
 * linked, e.g. `/buchungen?person=<id>`).
 */
import type { BookingQuery } from '../../api/queries';
import { parseDateInput, toDateInputValue, type PeriodKey } from '../../lib/dates';

export type BookingView = 'liste' | 'personen' | 'angebote';

export interface BookingFilterState {
  period: PeriodKey;
  from: string;
  to: string;
  personId: string;
  mine: boolean;
  view: BookingView;
}

const PERIOD_TO_PARAM: Record<PeriodKey, string> = {
  today: 'heute',
  '7d': '7-tage',
  '30d': '30-tage',
  all: 'alle',
  custom: 'zeitraum',
};

const PARAM_TO_PERIOD = Object.fromEntries(
  Object.entries(PERIOD_TO_PARAM).map(([key, value]) => [value, key as PeriodKey]),
) as Record<string, PeriodKey>;

export const DEFAULT_FILTER: BookingFilterState = {
  period: 'all',
  from: '',
  to: '',
  personId: '',
  mine: false,
  view: 'liste',
};

function validDate(value: string | null): string {
  return value && parseDateInput(value) ? value : '';
}

export function parseFilterParams(params: URLSearchParams): BookingFilterState {
  const period = PARAM_TO_PERIOD[params.get('zeitraum') ?? ''] ?? DEFAULT_FILTER.period;
  const view = params.get('ansicht');
  return {
    period,
    from: period === 'custom' ? validDate(params.get('von')) : '',
    to: period === 'custom' ? validDate(params.get('bis')) : '',
    personId: params.get('person') ?? '',
    mine: params.get('meine') === '1',
    view: view === 'personen' || view === 'angebote' ? view : 'liste',
  };
}

export function filterToParams(state: BookingFilterState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.period !== DEFAULT_FILTER.period) params.set('zeitraum', PERIOD_TO_PARAM[state.period]);
  if (state.period === 'custom') {
    if (state.from) params.set('von', state.from);
    if (state.to) params.set('bis', state.to);
  }
  if (state.personId) params.set('person', state.personId);
  if (state.mine) params.set('meine', '1');
  if (state.view !== 'liste') params.set('ansicht', state.view);
  return params;
}

export function toBookingQuery(state: BookingFilterState, currentUserId: string | null | undefined): BookingQuery {
  return {
    period: state.period,
    from: state.period === 'custom' ? state.from || null : null,
    to: state.period === 'custom' ? state.to || null : null,
    personId: state.personId || null,
    createdBy: state.mine ? (currentUserId ?? null) : null,
  };
}

/** e.g. `buchungen_heute_2026-09-28.csv`, `buchungen_2026-09-01_bis_2026-09-28.csv`. */
export function csvFileName(state: BookingFilterState, now: Date): string {
  const today = toDateInputValue(now);
  if (state.period === 'custom') {
    const from = state.from || 'anfang';
    const to = state.to || today;
    return `buchungen_${from}_bis_${to}.csv`;
  }
  return `buchungen_${PERIOD_TO_PARAM[state.period]}_${today}.csv`;
}
