import { KeyRound, LogOut, Save } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router';
import { toast } from 'sonner';
import { useUpdateUser } from '../../api/mutations';
import { changeOwnPassword, logout, useCurrentUser } from '../../auth/session';
import { Button } from '../../components/ui/Button';
import { Badge, Card } from '../../components/ui/Feedback';
import { FormError, TextField } from '../../components/ui/Field';
import { PageHeader } from '../../components/ui/PageHeader';
import { describeError } from '../../lib/errors';
import type { UserRecord } from '../../lib/types';
import { MIN_PASSWORD_LENGTH, validateNewPassword } from './passwordRules';


export function AccountPage() {
  const user = useCurrentUser();
  if (!user) return null;
  return (
    <div className="space-y-4 pb-4">
      <PageHeader title="Konto" />
      <Card className="flex items-center gap-4 p-4">
        <span
          aria-hidden
          className="flex size-14 shrink-0 items-center justify-center rounded-full bg-primary text-2xl font-bold text-on-primary uppercase"
        >
          {(user.name || user.username).slice(0, 1)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-lg font-bold" data-testid="account-name">
            {user.name || user.username}
          </p>
          <p className="truncate text-sm text-muted">
            Angemeldet als <span className="font-semibold text-fg" data-testid="account-username">{user.username}</span>
          </p>
        </div>
        <Badge tone={user.role === 'admin' ? 'primary' : 'neutral'}>{user.role === 'admin' ? 'Admin' : 'Benutzer'}</Badge>
      </Card>

      <NameForm key={`${user.id}:${user.name}`} user={user} />
      <PasswordForm user={user} />

      <Button
        block
        size="lg"
        variant="secondary"
        icon={<LogOut className="size-5" aria-hidden />}
        onClick={() => {
          logout();
          toast.success('Abgemeldet');
        }}
        data-testid="logout"
      >
        Abmelden
      </Button>
    </div>
  );
}

function NameForm({ user }: { user: UserRecord }) {
  const updateUser = useUpdateUser();
  const [name, setName] = useState(user.name);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name.trim().length > 100) {
      setError('Höchstens 100 Zeichen erlaubt.');
      return;
    }
    setError(null);
    try {
      await updateUser.mutateAsync({ id: user.id, input: { name: name.trim() } });
      toast.success('Name gespeichert');
    } catch (err) {
      setError(describeError(err, 'account').message);
    }
  }

  return (
    <Card className="p-4">
      <form onSubmit={(e) => void handleSubmit(e)} noValidate className="space-y-3" aria-labelledby="name-heading">
        <h2 id="name-heading" className="font-semibold">
          Anzeigename
        </h2>
        <TextField
          label="Name"
          hideLabel
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="z. B. Anna Beispiel"
          autoComplete="name"
          maxLength={100}
          error={error}
        />
        <Button
          type="submit"
          icon={<Save className="size-5" aria-hidden />}
          loading={updateUser.isPending}
          disabled={name.trim() === user.name}
        >
          Speichern
        </Button>
      </form>
    </Card>
  );
}

function PasswordForm({ user }: { user: UserRecord }) {
  const location = useLocation();
  const sectionRef = useRef<HTMLDivElement>(null);
  const [oldPassword, setOldPassword] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Deep link (/konto#passwort).
  useEffect(() => {
    if (location.hash === '#passwort') {
      sectionRef.current?.scrollIntoView({ block: 'start' });
      sectionRef.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    }
  }, [location.hash]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next: Record<string, string | undefined> = {
      ...validateNewPassword({ current: oldPassword, password, passwordConfirm }),
    };
    if (!oldPassword) next.oldPassword = 'Bitte das aktuelle Passwort eingeben.';
    setErrors(next);
    setFormError(null);
    if (Object.values(next).some(Boolean)) return;
    setBusy(true);
    try {
      await changeOwnPassword({ oldPassword, password, passwordConfirm });
      setOldPassword('');
      setPassword('');
      setPasswordConfirm('');
      toast.success('Passwort geändert');
    } catch (err) {
      const info = describeError(err, 'account');
      setErrors(info.fieldErrors);
      setFormError(info.fieldErrors.oldPassword || info.fieldErrors.password ? null : info.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="scroll-mt-4 p-4">
      <div ref={sectionRef} id="passwort" className="scroll-mt-4">
        <form
          onSubmit={(e) => void handleSubmit(e)}
          noValidate
          className="space-y-4"
          aria-labelledby="password-heading"
          data-testid="password-form"
        >
          <div>
            <h2 id="password-heading" className="font-semibold">
              Passwort ändern
            </h2>
          </div>
          {/* Hidden username helps password managers. */}
          <input type="text" name="username" autoComplete="username" value={user.username} readOnly hidden />
          <TextField
            label="Aktuelles Passwort"
            type="password"
            value={oldPassword}
            onChange={(e) => setOldPassword(e.target.value)}
            error={errors.oldPassword}
            autoComplete="current-password"
          />
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
          <Button type="submit" variant="primary" icon={<KeyRound className="size-5" aria-hidden />} loading={busy}>
            Passwort ändern
          </Button>
        </form>
      </div>
    </Card>
  );
}
