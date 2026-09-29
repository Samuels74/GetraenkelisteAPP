import { RotateCw } from 'lucide-react';
import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { AppLogo } from '../components/AppLogo';
import { Button } from '../components/ui/Button';

function isChunkLoadError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(error.message)
  );
}

export function RouteError() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  const outdated = isChunkLoadError(error);
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <AppLogo className="size-16" />
      <h1 className="text-2xl font-bold">{notFound ? 'Seite nicht gefunden' : 'Etwas ist schiefgelaufen'}</h1>
      <p className="text-muted">
        {outdated
          ? 'Die App wurde aktualisiert. Bitte lade die Seite neu.'
          : notFound
            ? 'Diese Seite gibt es nicht.'
            : 'Bitte lade die Seite neu. Wenn das Problem bleibt, melde dich bei der Verwaltung.'}
      </p>
      <div className="flex gap-3">
        <Button variant="primary" icon={<RotateCw className="size-5" aria-hidden />} onClick={() => window.location.reload()}>
          Neu laden
        </Button>
        <Link to="/" className="inline-flex min-h-12 items-center rounded-xl px-4 font-semibold text-primary">
          Zur Startseite
        </Link>
      </div>
    </main>
  );
}
