import {
  comparePersons,
  findPersonByNumber,
  isValidPersonNumber,
  normalizeSearch,
  personLabel,
  searchPersons,
  sortPersons,
} from './search';

const persons = [
  { id: '1', number: '10', name: 'Zoe Zenz', nickname: '' },
  { id: '2', number: '2', name: 'Max Mustermann', nickname: 'Maxi' },
  { id: '3', number: '001', name: 'Anna Müller', nickname: 'Anni' },
  { id: '4', number: 'A7', name: 'Bernd', nickname: 'Der Boss' },
  { id: '5', number: '100', name: 'Paul', nickname: 'Max' },
];

describe('sorting', () => {
  it('sorts numbers naturally', () => {
    expect(sortPersons(persons).map((p) => p.number)).toEqual(['001', '2', '10', '100', 'A7']);
    expect(comparePersons(persons[1]!, persons[0]!)).toBeLessThan(0);
  });
});

describe('normalizeSearch', () => {
  it('strips diacritics and case', () => {
    expect(normalizeSearch('  MÜLLER ')).toBe('muller');
  });
});

describe('findPersonByNumber', () => {
  it('matches exactly, case-insensitive and trimmed', () => {
    expect(findPersonByNumber(persons, ' a7 ')?.id).toBe('4');
    expect(findPersonByNumber(persons, '1')).toBeUndefined();
    expect(findPersonByNumber(persons, '')).toBeUndefined();
  });
});

describe('searchPersons', () => {
  it('returns everyone sorted for an empty query', () => {
    expect(searchPersons(persons, '  ').map((p) => p.id)).toEqual(['3', '2', '1', '5', '4']);
  });

  it('ranks exact number matches first, then prefixes', () => {
    expect(searchPersons(persons, '10').map((p) => p.number)).toEqual(['10', '100']);
  });

  it('finds by name, nickname and word prefixes', () => {
    expect(searchPersons(persons, 'max').map((p) => p.id)).toEqual(['2', '5']);
    expect(searchPersons(persons, 'boss').map((p) => p.id)).toEqual(['4']);
    expect(searchPersons(persons, 'muller').map((p) => p.id)).toEqual(['3']);
    expect(searchPersons(persons, 'Müll').map((p) => p.id)).toEqual(['3']);
  });

  it('matches multi-word queries', () => {
    expect(searchPersons(persons, 'anna anni').map((p) => p.id)).toEqual(['3']);
  });

  it('returns nothing for unknown queries', () => {
    expect(searchPersons(persons, 'xyz')).toEqual([]);
  });
});

describe('labels and validation', () => {
  it('builds person labels', () => {
    expect(personLabel({ number: '001', name: 'Anna', nickname: 'Anni' })).toBe('001 · Anna („Anni“)');
    expect(personLabel({ number: '7', name: '', nickname: '' })).toBe('7');
  });

  it('validates person numbers', () => {
    expect(isValidPersonNumber('001')).toBe(true);
    expect(isValidPersonNumber('A-7_b')).toBe(true);
    expect(isValidPersonNumber('')).toBe(false);
    expect(isValidPersonNumber('a b')).toBe(false);
    expect(isValidPersonNumber('ä1')).toBe(false);
    expect(isValidPersonNumber('x'.repeat(21))).toBe(false);
  });
});
