/**
 * Rules for new passwords, as the server checks them (PocketBase password
 * field): at least 8 characters, at most 71 – bcrypt only uses 72 bytes, and
 * longer passwords are rejected ("Der Wert ist zu lang." / "Ungültiger Wert."
 * without this check). Characters are counted like the server counts them
 * (code points); umlauts and other non-ASCII characters take 2–4 of the 72
 * bytes, so a long password with many of them can hit the byte limit first.
 *
 * No `maxLength` on the inputs: a password manager's longer password would be
 * cut silently and then fail at the next login.
 */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 71;
const MAX_PASSWORD_BYTES = 72;

export const PASSWORD_HINT = `Mindestens ${MIN_PASSWORD_LENGTH}, höchstens ${MAX_PASSWORD_LENGTH} Zeichen.`;

/** The error for a new password's length, or undefined. */
export function passwordLengthError(password: string): string | undefined {
  const length = [...password].length;
  if (length < MIN_PASSWORD_LENGTH) return `Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein.`;
  if (length > MAX_PASSWORD_LENGTH) return `Das Passwort darf höchstens ${MAX_PASSWORD_LENGTH} Zeichen lang sein.`;
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) {
    return 'Das Passwort ist zu lang – Umlaute und Sonderzeichen zählen dabei mehrfach.';
  }
  return undefined;
}

export interface NewPasswordErrors {
  password?: string;
  passwordConfirm?: string;
}

export function validateNewPassword({
  current,
  password,
  passwordConfirm,
}: {
  current: string;
  password: string;
  passwordConfirm: string;
}): NewPasswordErrors {
  const errors: NewPasswordErrors = {};
  const lengthError = passwordLengthError(password);
  if (lengthError) {
    errors.password = lengthError;
  } else if (current && password === current) {
    // (the server's wording – it checks the same)
    errors.password = 'Das neue Passwort muss sich vom bisherigen unterscheiden.';
  }
  if (password !== passwordConfirm) errors.passwordConfirm = 'Die Passwörter stimmen nicht überein.';
  return errors;
}
