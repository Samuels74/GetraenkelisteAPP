/** Rules for new passwords (the server requires at least 8 characters). */
export const MIN_PASSWORD_LENGTH = 8;

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
  if (password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein.`;
  } else if (current && password === current) {
    errors.password = 'Das neue Passwort muss sich vom aktuellen unterscheiden.';
  }
  if (password !== passwordConfirm) errors.passwordConfirm = 'Die Passwörter stimmen nicht überein.';
  return errors;
}
