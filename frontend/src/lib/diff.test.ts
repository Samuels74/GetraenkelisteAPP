import { changedFields, isEmptyPatch } from './diff';

describe('changedFields', () => {
  const original = { name: 'Bier', group: 'g1', priceCents: 350, active: true };

  it('returns only changed fields', () => {
    expect(changedFields(original, { ...original, priceCents: 400 })).toEqual({ priceCents: 400 });
    expect(changedFields(original, { ...original, name: 'Bier/Wein', active: false })).toEqual({
      name: 'Bier/Wein',
      active: false,
    });
  });

  it('returns an empty patch when nothing changed', () => {
    const patch = changedFields(original, { ...original });
    expect(patch).toEqual({});
    expect(isEmptyPatch(patch)).toBe(true);
  });

  it('does not resend stale values of untouched fields (concurrent edit)', () => {
    // Admin B opened the dialog while the offering was active; admin A deactivated
    // it meanwhile. B only changes the price → `active` must not be sent.
    const openedWith = { ...original };
    const patch = changedFields(openedWith, { ...openedWith, priceCents: 500 });
    expect(patch).not.toHaveProperty('active');
    expect(patch).toEqual({ priceCents: 500 });
  });

  it('treats 0 / -0 and strings strictly', () => {
    expect(changedFields({ a: 0 }, { a: -0 })).toEqual({ a: -0 });
    expect(changedFields({ a: '1' }, { a: '1' })).toEqual({});
  });
});
