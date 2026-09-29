/**
 * Money helpers. All amounts are integer cents (see ARCHITECTURE.md §2).
 */

/** Price range of `offerings.priceCents` (ARCHITECTURE.md §4). */
export const MAX_PRICE_CENTS = 100_000;

const currencyFormat = new Intl.NumberFormat('de-AT', { style: 'currency', currency: 'EUR' });

/** Formats cents for display, e.g. `350` → `€ 3,50` (de-AT). */
export function formatCents(cents: number): string {
  return currencyFormat.format(cents / 100);
}

/**
 * Formats cents as a plain decimal-comma number without currency symbol and
 * without thousands separators, e.g. `-50` → `-0,50`, `123456` → `1234,56`.
 * Used for price input fields and the CSV export.
 */
export function formatCentsPlain(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  const euros = Math.floor(abs / 100);
  const rest = abs % 100;
  return `${sign}${euros},${String(rest).padStart(2, '0')}`;
}

const MONEY_PATTERN = /^([+-])?(\d*)(?:[.,](\d{0,2}))?$/;

/**
 * Parses a user-entered price into cents. Accepts `3,50`, `3.50`, `3`, `3,5`,
 * `,50`, `-0,50`, an optional `€` sign and surrounding whitespace.
 * Returns `null` for anything else (letters, more than two decimals,
 * thousands separators, empty input).
 */
export function parseMoneyToCents(input: string): number | null {
  const cleaned = input.replace(/€|EUR/gi, '').replace(/\s+/g, '');
  const match = MONEY_PATTERN.exec(cleaned);
  if (!match) return null;
  const [, sign, wholePart = '', fractionPart = ''] = match;
  if (wholePart === '' && fractionPart === '') return null;
  const whole = wholePart === '' ? 0 : Number(wholePart);
  const fraction = Number(fractionPart.padEnd(2, '0'));
  if (!Number.isSafeInteger(whole)) return null;
  const cents = whole * 100 + fraction;
  if (!Number.isSafeInteger(cents)) return null;
  return sign === '-' && cents !== 0 ? -cents : cents;
}
