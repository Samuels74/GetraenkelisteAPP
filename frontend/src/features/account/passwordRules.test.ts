import { validateNewPassword } from './passwordRules';

describe('validateNewPassword', () => {
  it('accepts a new password of at least 8 characters', () => {
    expect(validateNewPassword({ current: 'admin', password: 'geheim123', passwordConfirm: 'geheim123' })).toEqual({});
  });

  it('rejects short, unchanged or mismatching passwords', () => {
    expect(validateNewPassword({ current: 'x', password: 'kurz', passwordConfirm: 'kurz' }).password).toContain(
      'mindestens 8 Zeichen',
    );
    expect(
      validateNewPassword({ current: 'anna1234', password: 'anna1234', passwordConfirm: 'anna1234' }).password,
    ).toContain('unterscheiden');
    expect(
      validateNewPassword({ current: '', password: 'geheim123', passwordConfirm: 'geheim124' }).passwordConfirm,
    ).toBe('Die Passwörter stimmen nicht überein.');
  });
});
