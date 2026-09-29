import { csvFileName, DEFAULT_FILTER, filterToParams, parseFilterParams, toBookingQuery } from './filters';

describe('booking filter params', () => {
  it('uses defaults for empty params', () => {
    expect(parseFilterParams(new URLSearchParams())).toEqual(DEFAULT_FILTER);
    expect(filterToParams(DEFAULT_FILTER).toString()).toBe('');
  });

  it('round-trips all fields', () => {
    const state = {
      period: 'custom' as const,
      from: '2026-09-01',
      to: '2026-09-28',
      personId: 'p1',
      mine: true,
      view: 'personen' as const,
    };
    const params = filterToParams(state);
    expect(params.toString()).toBe('zeitraum=zeitraum&von=2026-09-01&bis=2026-09-28&person=p1&meine=1&ansicht=personen');
    expect(parseFilterParams(params)).toEqual(state);
  });

  it('ignores invalid values', () => {
    const state = parseFilterParams(new URLSearchParams('zeitraum=foo&von=2026-02-30&ansicht=bar&meine=yes'));
    expect(state).toEqual(DEFAULT_FILTER);
  });

  it('drops custom dates for preset periods', () => {
    expect(parseFilterParams(new URLSearchParams('zeitraum=heute&von=2026-09-01'))).toMatchObject({
      period: 'today',
      from: '',
    });
  });

  it('builds the query with the current user for "nur meine"', () => {
    expect(toBookingQuery({ ...DEFAULT_FILTER, mine: true, personId: 'p' }, 'u1')).toEqual({
      period: 'all',
      from: null,
      to: null,
      personId: 'p',
      createdBy: 'u1',
    });
  });

  it('names CSV files after the filter', () => {
    const now = new Date(2026, 8, 28, 12);
    expect(csvFileName({ ...DEFAULT_FILTER, period: 'today' }, now)).toBe('buchungen_heute_2026-09-28.csv');
    expect(csvFileName(DEFAULT_FILTER, now)).toBe('buchungen_alle_2026-09-28.csv');
    expect(csvFileName({ ...DEFAULT_FILTER, period: 'custom', from: '2026-09-01' }, now)).toBe(
      'buchungen_2026-09-01_bis_2026-09-28.csv',
    );
  });
});
