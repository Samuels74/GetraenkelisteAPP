/**
 * Print sheet with QR codes (all persons, or `?ids=a,b`). `?drucken=1` opens
 * the print dialog automatically. Rendered without the app navigation.
 */
import { ArrowLeft, Printer } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { usePersons } from '../../api/queries';
import { QrCode } from '../../components/QrCode';
import { Button, IconButton } from '../../components/ui/Button';
import { EmptyState, QueryError } from '../../components/ui/Feedback';
import { PageSpinner } from '../../components/ui/Spinner';
import { useDocumentTitle } from '../../lib/useDocumentTitle';

export function QrSheetPage() {
  useDocumentTitle('QR-Codes drucken');
  const persons = usePersons();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const idsParam = params.get('ids');
  const autoPrint = params.get('drucken') === '1';

  const list = useMemo(() => {
    const all = persons.data ?? [];
    if (!idsParam) return all;
    const ids = new Set(idsParam.split(',').filter(Boolean));
    return all.filter((p) => ids.has(p.id));
  }, [persons.data, idsParam]);

  const ready = persons.isSuccess && list.length > 0;
  useEffect(() => {
    if (!autoPrint || !ready) return;
    const timer = window.setTimeout(() => window.print(), 400);
    return () => window.clearTimeout(timer);
  }, [autoPrint, ready]);

  function goBack() {
    if (window.history.length > 1) void navigate(-1);
    else void navigate('/personen');
  }

  const single = Boolean(idsParam) && list.length === 1;

  return (
    <div className="min-h-dvh bg-canvas print:bg-white">
      <header className="sticky top-0 z-10 border-b border-line bg-surface/95 pt-safe backdrop-blur print:hidden">
        <div className="mx-auto flex max-w-5xl items-center gap-2 px-safe py-2">
          <IconButton label="Zurück" onClick={goBack}>
            <ArrowLeft className="size-6" aria-hidden />
          </IconButton>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-bold">{single ? 'QR-Code drucken' : 'QR-Codes drucken'}</h1>
            {persons.isSuccess ? (
              <p className="text-sm text-muted">
                {list.length} {list.length === 1 ? 'Person' : 'Personen'}
              </p>
            ) : null}
          </div>
          <Button
            variant="primary"
            icon={<Printer className="size-5" aria-hidden />}
            onClick={() => window.print()}
            disabled={!ready}
          >
            Drucken
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-safe py-4 print:max-w-none print:p-0">
        {persons.isPending ? (
          <PageSpinner />
        ) : persons.isError ? (
          <QueryError error={persons.error} onRetry={() => void persons.refetch()} />
        ) : list.length === 0 ? (
          <EmptyState title="Keine Personen" />
        ) : (
          <div
            className="grid grid-cols-2 gap-3 rounded-2xl bg-white p-3 text-black shadow-sm sm:grid-cols-3 print:grid-cols-3 print:gap-[6mm] print:rounded-none print:p-0 print:shadow-none"
            data-testid="qr-sheet"
          >
            {list.map((person) => (
              <figure
                key={person.id}
                className="flex break-inside-avoid flex-col items-center rounded-xl border border-dashed border-neutral-300 p-3 text-center"
                data-testid="qr-card"
                data-person-number={person.number}
              >
                <QrCode value={person.number} className="aspect-square w-full max-w-44 print:w-[42mm]" />
                <figcaption className="mt-1 w-full">
                  <span className="block text-2xl font-bold tabular-nums">{person.number}</span>
                  {person.name ? <span className="block truncate text-sm">{person.name}</span> : null}
                  {person.nickname ? (
                    <span className="block truncate text-xs text-neutral-600">„{person.nickname}“</span>
                  ) : null}
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
