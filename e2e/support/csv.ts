/** Minimal parser for the app's CSV export (`;` separator, `"` quoting, CRLF). */
export function parseCsvLine(line: string, separator = ';'): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"' && cell === '') {
      quoted = true;
    } else if (char === separator) {
      cells.push(cell);
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

/** `3,50` → 350 */
export function parseAmount(value: string): number {
  const match = /^(-?)(\d+),(\d{2})$/.exec(value);
  if (!match) throw new Error(`not an amount: ${value}`);
  const cents = Number(match[2]) * 100 + Number(match[3]);
  return match[1] ? -cents : cents;
}
