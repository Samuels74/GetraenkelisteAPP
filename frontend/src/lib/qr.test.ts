import { qrFileName, qrMatrix, qrSvgPath } from './qr';

describe('qr helpers', () => {
  it('creates a version 1 matrix for short numbers', () => {
    const matrix = qrMatrix('001');
    expect(matrix.size).toBe(21);
    // finder pattern corners are dark
    expect(matrix.dark(0, 0)).toBe(true);
    expect(matrix.dark(0, 20)).toBe(true);
    expect(matrix.dark(20, 0)).toBe(true);
    expect(matrix.dark(7, 7)).toBe(false);
  });

  it('builds an SVG path including the quiet zone', () => {
    const { path, size } = qrSvgPath('001', 4);
    expect(size).toBe(29);
    // top-left finder pattern starts at the quiet zone offset and is 7 modules wide
    expect(path.startsWith('M4 4h7v1h-7z')).toBe(true);
    expect(path).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/);
  });

  it('produces deterministic output', () => {
    expect(qrSvgPath('A7').path).toBe(qrSvgPath('A7').path);
    expect(qrSvgPath('A7').path).not.toBe(qrSvgPath('A8').path);
  });

  it('computes each code once and shares the frozen result', () => {
    const first = qrSvgPath('X-cache-1');
    expect(qrSvgPath('X-cache-1')).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(qrSvgPath('X-cache-1', 1)).not.toBe(first); // the margin is part of the key
    expect(qrSvgPath('X-cache-1', 1).size).toBe(first.size - 6);
  });

  it('keeps the most recently used codes when the cache is full', () => {
    const kept = qrSvgPath('X-kept');
    const dropped = qrSvgPath('X-dropped');
    // 2500 other codes; 'X-kept' is used again halfway, so 'X-dropped' is the oldest entry
    for (let i = 0; i < 2500; i++) {
      qrSvgPath(`X-fill-${i}`);
      if (i === 1250) qrSvgPath('X-kept');
    }
    expect(qrSvgPath('X-kept')).toBe(kept);
    const again = qrSvgPath('X-dropped');
    expect(again).not.toBe(dropped);
    expect(again).toEqual(dropped);
  });

  it('builds safe file names', () => {
    expect(qrFileName('001')).toBe('qr-001.png');
    expect(qrFileName('a/b')).toBe('qr-a_b.png');
  });
});
