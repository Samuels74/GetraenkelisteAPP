import { BOOKING_CSV_COLUMNS, bookingsToCsv, bookingToCsvRow, csvEscape, csvText, toCsv } from './csv';
import type { BookingRecord } from './types';

function booking(overrides: Partial<BookingRecord> = {}): BookingRecord {
  return {
    id: 'b1',
    collectionId: 'c',
    collectionName: 'bookings',
    created: '2026-09-28 16:05:09.123Z', // 18:05:09 in Vienna
    updated: '2026-09-28 16:05:09.123Z',
    person: 'p1',
    offering: 'o1',
    quantity: 1,
    unitPriceCents: 350,
    createdBy: 'u1',
    expand: {
      person: {
        id: 'p1',
        collectionId: 'c',
        collectionName: 'persons',
        created: '',
        updated: '',
        number: '001',
        name: 'Max Mustermann',
        nickname: 'Maxi',
      },
      offering: {
        id: 'o1',
        collectionId: 'c',
        collectionName: 'offerings',
        created: '',
        updated: '',
        name: 'Bier/Wein',
        group: 'g1',
        priceCents: 400,
        active: true,
        sortOrder: 10,
        expand: {
          group: {
            id: 'g1',
            collectionId: 'c',
            collectionName: 'groups',
            created: '',
            updated: '',
            name: 'Getränke',
            sortOrder: 10,
          },
        },
      },
      createdBy: {
        id: 'u1',
        collectionId: 'c',
        collectionName: 'users',
        created: '',
        updated: '',
        username: 'anna',
        name: 'Anna',
        role: 'user',
        mustChangePassword: false,
        disabled: false,
      },
    },
    ...overrides,
  };
}

describe('csvEscape', () => {
  it('leaves plain values untouched', () => {
    expect(csvEscape('Bier/Wein')).toBe('Bier/Wein');
    expect(csvEscape('3,50')).toBe('3,50');
    expect(csvEscape('')).toBe('');
  });

  it('quotes values containing separator, quotes or line breaks', () => {
    expect(csvEscape('a;b')).toBe('"a;b"');
    expect(csvEscape('Der "Boss"')).toBe('"Der ""Boss"""');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscape('x\r')).toBe('"x\r"');
    expect(csvEscape(' padded ')).toBe('" padded "');
  });
});

describe('csvText', () => {
  it('neutralizes formula injection', () => {
    expect(csvText('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvText('+43')).toBe("'+43");
    expect(csvText('-x')).toBe("'-x");
    expect(csvText('@foo')).toBe("'@foo");
    expect(csvText('Max')).toBe('Max');
  });
});

describe('toCsv', () => {
  it('starts with a BOM, uses ; and CRLF', () => {
    expect(toCsv([['a', 'b'], ['c;d', 'e']])).toBe('﻿a;b\r\n"c;d";e\r\n');
  });
});

describe('bookings CSV', () => {
  it('has the contract header', () => {
    const csv = bookingsToCsv([]);
    expect(csv).toBe(
      '﻿Datum;Uhrzeit;Nummer;Name;Nickname;Gruppe;Angebot;Anzahl;Einzelpreis;Summe;Gebucht von\r\n',
    );
    expect(BOOKING_CSV_COLUMNS).toHaveLength(11);
  });

  it('renders a booking row with local time and decimal comma', () => {
    expect(bookingToCsvRow(booking())).toEqual([
      '28.09.2026',
      '18:05:09',
      '001',
      'Max Mustermann',
      'Maxi',
      'Getränke',
      'Bier/Wein',
      '1',
      '3,50',
      '3,50',
      'anna',
    ]);
  });

  it('uses the price snapshot and multiplies quantities (negative prices too)', () => {
    const row = bookingToCsvRow(booking({ quantity: 3, unitPriceCents: -150 }));
    expect(row[7]).toBe('3');
    expect(row[8]).toBe('-1,50');
    expect(row[9]).toBe('-4,50');
  });

  it('escapes names with separators and quotes', () => {
    const b = booking();
    b.expand!.person!.name = 'Müller; "Hans"';
    const csv = bookingsToCsv([b]);
    const lines = csv.split('\r\n');
    expect(lines[1]).toBe(
      '28.09.2026;18:05:09;001;"Müller; ""Hans""";Maxi;Getränke;Bier/Wein;1;3,50;3,50;anna',
    );
    expect(lines[2]).toBe('');
  });

  it('tolerates missing expands', () => {
    const row = bookingToCsvRow(booking({ expand: {} }));
    expect(row.slice(2, 7)).toEqual(['', '', '', '', '']);
    expect(row[10]).toBe('');
  });
});
