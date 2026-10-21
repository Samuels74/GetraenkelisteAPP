import { formatCents, formatCentsPlain, formatCount, parseMoneyToCents } from './money';

describe('formatCount', () => {
  it.each([
    [0, '0'],
    [7, '7'],
    [999, '999'],
    [1000, '1.000'],
    [14927, '14.927'],
    [-2500, '-2.500'],
    [1234567, '1.234.567'],
  ])('%i → %s (grouped like the amounts)', (count, expected) => {
    expect(formatCount(count)).toBe(expected);
  });
});

const nbsp = ' ';

describe('formatCents', () => {
  it('formats euros the Austrian way', () => {
    expect(formatCents(350)).toBe(`€${nbsp}3,50`);
    expect(formatCents(0)).toBe(`€${nbsp}0,00`);
    expect(formatCents(123456)).toBe(`€${nbsp}1.234,56`);
  });

  it('formats negative amounts', () => {
    expect(formatCents(-50)).toBe(`-€${nbsp}0,50`);
  });
});

describe('formatCentsPlain', () => {
  it.each([
    [0, '0,00'],
    [5, '0,05'],
    [350, '3,50'],
    [1000, '10,00'],
    [123456, '1234,56'],
    [-50, '-0,50'],
    [-1250, '-12,50'],
  ])('%i → %s', (cents, expected) => {
    expect(formatCentsPlain(cents)).toBe(expected);
  });
});

describe('parseMoneyToCents', () => {
  it.each([
    ['3,50', 350],
    ['3.50', 350],
    ['3', 300],
    ['3,5', 350],
    ['3.5', 350],
    ['0,05', 5],
    [',50', 50],
    ['3,', 300],
    ['0', 0],
    ['-0,50', -50],
    ['-2', -200],
    ['+1,20', 120],
    [' 4,20 ', 420],
    ['€ 3,50', 350],
    ['3,50 €', 350],
    ['1000', 100000],
    ['-0', 0],
  ])('parses %j → %i', (input, expected) => {
    expect(parseMoneyToCents(input)).toBe(expected);
  });

  it.each(['', ' ', 'abc', '3,555', '1.000,00', '1,000.00', '3,5a', '--1', '-', ',', '1e3', '0x10'])(
    'rejects %j',
    (input) => {
      expect(parseMoneyToCents(input)).toBeNull();
    },
  );

  it('round-trips with formatCentsPlain', () => {
    for (const cents of [0, 1, 99, 100, 350, -350, 99999, -100000]) {
      expect(parseMoneyToCents(formatCentsPlain(cents))).toBe(cents);
    }
  });
});
