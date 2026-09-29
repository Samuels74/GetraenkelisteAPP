import { createOnceGuard } from './onceGuard';

describe('createOnceGuard', () => {
  it('allows each key only once', () => {
    const guard = createOnceGuard();
    expect(guard.tryBegin('b1')).toBe(true);
    expect(guard.tryBegin('b1')).toBe(false);
    expect(guard.tryBegin('b2')).toBe(true);
  });

  it('can release a key after a failed attempt', () => {
    const guard = createOnceGuard();
    expect(guard.tryBegin('b1')).toBe(true);
    guard.release('b1');
    expect(guard.tryBegin('b1')).toBe(true);
  });
});
