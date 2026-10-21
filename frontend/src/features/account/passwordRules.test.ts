import { MAX_PASSWORD_LENGTH, passwordLengthError, PASSWORD_HINT, validateNewPassword } from './passwordRules';

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
    ).toBe('Das neue Passwort muss sich vom bisherigen unterscheiden.');
    expect(
      validateNewPassword({ current: '', password: 'geheim123', passwordConfirm: 'geheim124' }).passwordConfirm,
    ).toBe('Die Passwörter stimmen nicht überein.');
  });

  it('rejects passwords longer than the server accepts (71 characters, bcrypt)', () => {
    const long = 'x'.repeat(72);
    expect(validateNewPassword({ current: 'alt', password: long, passwordConfirm: long }).password).toBe(
      'Das Passwort darf höchstens 71 Zeichen lang sein.',
    );
  });
});

describe('passwordLengthError', () => {
  it('allows 8 to 71 characters', () => {
    expect(passwordLengthError('x'.repeat(7))).toContain('mindestens 8 Zeichen');
    expect(passwordLengthError('x'.repeat(8))).toBeUndefined();
    expect(passwordLengthError('x'.repeat(MAX_PASSWORD_LENGTH))).toBeUndefined();
    expect(passwordLengthError('x'.repeat(MAX_PASSWORD_LENGTH + 1))).toContain('höchstens 71 Zeichen');
  });

  it('counts characters like the server (code points, not UTF-16 units)', () => {
    // 8 emoji are 16 UTF-16 units but 8 characters (32 bytes – fine for bcrypt)
    expect(passwordLengthError('🍺'.repeat(8))).toBeUndefined();
    expect(passwordLengthError('🍺'.repeat(7))).toContain('mindestens 8 Zeichen');
  });

  it('respects the 72 bytes of bcrypt for non-ASCII characters', () => {
    expect(passwordLengthError('ä'.repeat(36))).toBeUndefined(); // 72 bytes
    expect(passwordLengthError('ä'.repeat(37))).toContain('Umlaute'); // 74 bytes, 37 characters
  });

  it('describes the rule for the field hints', () => {
    expect(PASSWORD_HINT).toBe('Mindestens 8, höchstens 71 Zeichen.');
  });
});
