import { RotateCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { AppLogo } from '../components/AppLogo';
import { Button } from '../components/ui/Button';
import { readSessionStorage, writeSessionStorage } from '../lib/storage';

function isChunkLoadError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(error.message)
  );
}

type ChunkCause = 'checking' | 'offline' | 'outdated';

/** While the server is unreachable, it is asked this often whether it is back. */
export const HEALTH_POLL_MS = 5_000;
/** A health check without an answer after this long counts as "unreachable". */
const HEALTH_TIMEOUT_MS = 5_000;
/** The automatic reload after an app update happens once per this time (no reload loop). */
const AUTO_RELOAD_GUARD_MS = 60_000;
const AUTO_RELOAD_KEY = 'gl.chunkReloadAt';

/**
 * Whether PocketBase itself answers: `/api/health` with its JSON. A proxy's
 * 502 / 404 page (the app container restarting) or a captive portal's page
 * also "answers" – fetch resolves on every HTTP status –, but not with this.
 */
async function serverAnswers(): Promise<boolean> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch('/api/health', { cache: 'no-store', signal: timeout.signal });
    return res.ok && (res.headers.get('content-type') ?? '').includes('json');
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Reloads once – not again if the last automatic reload was less than a minute ago (it did not help). */
function reloadOnce(): boolean {
  const last = Number(readSessionStorage(AUTO_RELOAD_KEY));
  if (Number.isFinite(last) && last > 0 && Date.now() - last < AUTO_RELOAD_GUARD_MS) return false;
  writeSessionStorage(AUTO_RELOAD_KEY, String(Date.now()));
  window.location.reload();
  return true;
}

/**
 * Why a screen's code could not be loaded (a failed module import is not
 * retried by the browser – only a reload loads it):
 * - the server answers: the app was updated meanwhile (the old code is gone) –
 *   the page reloads once by itself into the new version;
 * - no connection, or not PocketBase's answer (the browser says offline, a
 *   network error, a proxy's 502 while the app restarts): the page asks the
 *   server every few seconds (and at once when the browser is online again)
 *   and reloads when it answers – the Wi-Fi may stay up all the time.
 */
function useChunkCause(chunkFailed: boolean): { cause: ChunkCause | null; reloaded: boolean } {
  const [cause, setCause] = useState<ChunkCause | null>(() =>
    chunkFailed ? (navigator.onLine ? 'checking' : 'offline') : null,
  );
  const [reloaded, setReloaded] = useState(false);

  useEffect(() => {
    if (cause !== 'checking') return;
    let cancelled = false;
    void serverAnswers().then((answers) => {
      if (cancelled) return;
      if (answers) setReloaded(reloadOnce());
      setCause(answers ? 'outdated' : 'offline');
    });
    return () => {
      cancelled = true;
    };
  }, [cause]);

  useEffect(() => {
    if (cause !== 'offline') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let asking = false;
    const ask = async () => {
      clearTimeout(timer);
      if (asking) return;
      asking = true;
      const answers = await serverAnswers();
      asking = false;
      if (cancelled) return;
      if (answers) window.location.reload();
      else timer = setTimeout(() => void ask(), HEALTH_POLL_MS);
    };
    timer = setTimeout(() => void ask(), HEALTH_POLL_MS);
    const onOnline = () => void ask();
    window.addEventListener('online', onOnline);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener('online', onOnline);
    };
  }, [cause]);

  return { cause, reloaded };
}

export function RouteError() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  const { cause, reloaded } = useChunkCause(isChunkLoadError(error));
  const title = notFound
    ? 'Seite nicht gefunden'
    : cause === 'offline'
      ? 'Keine Verbindung zum Server'
      : 'Etwas ist schiefgelaufen';
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <AppLogo className="size-16" />
      <h1 className="text-2xl font-bold">{title}</h1>
      <p className="text-muted" role="status">
        {cause === 'offline'
          ? 'Der Server ist gerade nicht erreichbar. Die Seite wird neu geladen, sobald er wieder antwortet.'
          : cause === 'checking'
            ? 'Verbindung wird geprüft …'
            : cause === 'outdated'
              ? reloaded
                ? 'Die App wurde aktualisiert – sie wird neu geladen …'
                : 'Die App wurde aktualisiert. Bitte lade die Seite neu.'
              : notFound
                ? 'Diese Seite gibt es nicht.'
                : 'Bitte lade die Seite neu. Wenn das Problem bleibt, melde dich bei der Verwaltung.'}
      </p>
      <div className="flex gap-3">
        <Button variant="primary" icon={<RotateCw className="size-5" aria-hidden />} onClick={() => window.location.reload()}>
          {cause === 'offline' ? 'Erneut versuchen' : 'Neu laden'}
        </Button>
        <Link to="/" className="inline-flex min-h-12 items-center rounded-xl px-4 font-semibold text-primary">
          Zur Startseite
        </Link>
      </div>
    </main>
  );
}
