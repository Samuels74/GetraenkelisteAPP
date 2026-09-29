/**
 * Blocking "Neues Passwort festlegen" screen for users with
 * `mustChangePassword` (seeded admin, accounts created or reset by an admin).
 * Every route shows it until the password is changed; only "Abmelden" is
 * possible. The password typed on the login form is reused as the current
 * password (kept in memory only); after a reload it is asked for again.
 */
import { KeyRound, LogOut } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import {
  changeOwnPassword,
  forgetRememberedLoginPassword,
  getRememberedLoginPassword,
  logout,
} from '../../auth/session';
import { AppLogo } from '../../components/AppLogo';
import { Button } from '../../components/ui/Button';
import { FormError, TextField } from '../../components/ui/Field';
import { describeError } from '../../lib/errors';
import type { UserRecord } from '../../lib/types';
import { useDocumentTitle } from '../../lib/useDocumentTitle';
import { MIN_PASSWORD_LENGTH, validateNewPassword } from './passwordRules';

type Errors = Partial<Record<'oldPassword' | 'password' | 'passwordConfirm', string>>;

export function ForcePasswordChange({ user }: { user: UserRecord }) {
  useDocumentTitle('Neues Passwort festlegen');
  const [remembered, setRemembered] = useState<string | null>(() => getRememberedLoginPassword());
  const [oldPassword, setOldPassword] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const askCurrent = remembered === null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const current = remembered ?? oldPassword;
    const next: Errors = validateNewPassword({ current, password, passwordConfirm });
    if (askCurrent && !oldPassword) next.oldPassword = 'Bitte das aktuelle Passwort eingeben.';
    setErrors(next);
    setFormError(null);
    if (Object.values(next).some(Boolean)) return;
    setBusy(true);
    try {
      await changeOwnPassword({ oldPassword: current, password, passwordConfirm });
      toast.success('Passwort gespeichert');
      // mustChangePassword is now false → the requested page renders.
    } catch (error) {
      const info = describeError(error, 'account');
      if (info.fieldErrors.oldPassword && !askCurrent) {
        // The login password was not accepted as current password → ask for it.
        forgetRememberedLoginPassword();
        setRemembered(null);
        setErrors({ oldPassword: info.fieldErrors.oldPassword });
        setFormError(null);
      } else {
        setErrors({
          oldPassword: info.fieldErrors.oldPassword,
          password: info.fieldErrors.password,
          passwordConfirm: info.fieldErrors.passwordConfirm,
        });
        const shownInline = Boolean(
          info.fieldErrors.oldPassword || info.fieldErrors.password || info.fieldErrors.passwordConfirm,
        );
        setFormError(shownInline ? null : info.message);
      }
      setBusy(false);
    }
  }

  return (
    <main
      className="flex min-h-dvh items-center justify-center px-safe pt-safe pb-safe"
      data-testid="force-password"
    >
      <div className="w-full max-w-sm py-10">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <AppLogo className="size-16 drop-shadow-sm" />
          <h1 className="text-2xl font-bold tracking-tight">Neues Passwort festlegen</h1>
          <p className="text-muted">
            Hallo <span className="font-semibold text-fg">{user.name || user.username}</span>! Du verwendest noch ein
            Startpasswort. Bitte lege jetzt ein eigenes Passwort fest.
          </p>
        </div>
        <form
          onSubmit={(e) => void handleSubmit(e)}
          noValidate
          aria-label="Neues Passwort festlegen"
          data-testid="force-password-form"
          className="space-y-4 rounded-3xl border border-line bg-surface p-5 shadow-sm"
        >
          {/* Hidden username helps password managers. */}
          <input type="text" name="username" autoComplete="username" value={user.username} readOnly hidden />
          {askCurrent ? (
            <TextField
              label="Aktuelles Passwort"
              type="password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              error={errors.oldPassword}
              autoComplete="current-password"
            />
          ) : null}
          <TextField
            label="Neues Passwort"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={errors.password}
            hint={`Mindestens ${MIN_PASSWORD_LENGTH} Zeichen.`}
            autoComplete="new-password"
          />
          <TextField
            label="Neues Passwort wiederholen"
            type="password"
            value={passwordConfirm}
            onChange={(e) => setPasswordConfirm(e.target.value)}
            error={errors.passwordConfirm}
            autoComplete="new-password"
          />
          <FormError message={formError} />
          <Button
            type="submit"
            variant="primary"
            size="lg"
            block
            loading={busy}
            icon={<KeyRound className="size-5" aria-hidden />}
          >
            Passwort speichern
          </Button>
        </form>
        <Button
          variant="ghost"
          block
          className="mt-4"
          icon={<LogOut className="size-5" aria-hidden />}
          onClick={() => logout()}
          data-testid="logout"
        >
          Abmelden
        </Button>
      </div>
    </main>
  );
}
