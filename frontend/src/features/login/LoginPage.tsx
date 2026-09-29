import { useQueryClient } from '@tanstack/react-query';
import { LogIn } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router';
import { login, useCurrentUser } from '../../auth/session';
import { AppLogo } from '../../components/AppLogo';
import { Button } from '../../components/ui/Button';
import { FormError, TextField } from '../../components/ui/Field';
import { errorMessage } from '../../lib/errors';
import { useDocumentTitle } from '../../lib/useDocumentTitle';

function redirectTarget(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from;
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') && !from.startsWith('/login')
    ? from
    : '/';
}

export function LoginPage() {
  useDocumentTitle('Anmelden');
  const user = useCurrentUser();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={redirectTarget(location.state)} replace />;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!username.trim() || !password) {
      setError('Bitte Benutzername und Passwort eingeben.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      queryClient.clear();
      // On success the auth store changes and the <Navigate> above redirects.
      await login(username, password);
    } catch (err) {
      setError(errorMessage(err, 'auth'));
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-safe pt-safe pb-safe">
      <div className="w-full max-w-sm py-10">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <AppLogo className="size-20 drop-shadow-sm" />
          <h1 className="text-3xl font-bold tracking-tight">Getränkeliste</h1>
          <p className="text-muted">Bitte melde dich an.</p>
        </div>
        <form
          onSubmit={handleSubmit}
          noValidate
          aria-label="Anmelden"
          className="space-y-4 rounded-3xl border border-line bg-surface p-5 shadow-sm"
        >
          <TextField
            label="Benutzername"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="next"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
          <TextField
            label="Passwort"
            name="password"
            type="password"
            autoComplete="current-password"
            enterKeyHint="go"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <FormError message={error} />
          <Button
            type="submit"
            variant="primary"
            size="lg"
            block
            loading={busy}
            icon={<LogIn className="size-5" aria-hidden />}
          >
            Anmelden
          </Button>
        </form>
      </div>
    </main>
  );
}
