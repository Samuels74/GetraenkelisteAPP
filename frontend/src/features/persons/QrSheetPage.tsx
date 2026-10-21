/**
 * Print sheet with QR codes (all persons, or `?ids=a,b`). `?drucken=1` opens
 * the print dialog automatically. Rendered without the app navigation.
 *
 * The cards are mounted step by step (useProgressiveCount): computing and
 * mounting 2000 QR codes in one commit froze phones for 0.74 s
 * (docs/LOADTEST-FINDINGS.md F4). Printing never shows a partial
 * sheet: "Drucken" and `drucken=1` wait until every card is rendered, and
 * printing from the browser menu renders the rest first (`beforeprint`).
 */
import { ArrowLeft, Printer } from 'lucide-react';
import { memo, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { usePersons } from '../../api/queries';
import { QrCode } from '../../components/QrCode';
import { Button, IconButton } from '../../components/ui/Button';
import { cn } from '../../components/ui/cn';
import { EmptyState, QueryError } from '../../components/ui/Feedback';
import { PageSpinner, Spinner } from '../../components/ui/Spinner';
import { formatCount } from '../../lib/money';
import { useDocumentTitle } from '../../lib/useDocumentTitle';
import { useProgressiveCount } from '../../lib/useProgressiveCount';

/**
 * Cards mounted first, and at most per step (useProgressiveCount): the QR
 * codes of a step are computed in time slices, but its commit lays out all
 * cards rendered so far – ≈ 0.1 s for 400 cards on a 4× throttled CPU.
 */
export const FIRST_CARDS = 100;
export const MAX_CARDS_PER_STEP = 400;

/** Pause between "all cards rendered" and the automatic print dialog (`drucken=1`). */
const AUTO_PRINT_DELAY_MS = 400;

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

  const { count, complete, finish } = useProgressiveCount(list.length, FIRST_CARDS, MAX_CARDS_PER_STEP, idsParam ?? '');
  // (a failed background refresh keeps the loaded persons)
  const loaded = persons.data !== undefined;
  const ready = loaded && list.length > 0;
  const printable = ready && complete;

  // Every print – the button, the browser menu / Ctrl+P (also while cards are
  // still being added: the rest is rendered first) or `drucken=1` – counts as
  // this visit's print.
  const printed = useRef(false);
  useEffect(() => {
    const beforePrint = () => {
      printed.current = true;
      finish();
    };
    window.addEventListener('beforeprint', beforePrint);
    return () => window.removeEventListener('beforeprint', beforePrint);
  }, [finish]);

  // `drucken=1`: one print dialog per visit – none if the sheet was printed
  // already, and none again if a person is added (realtime) after printing.
  useEffect(() => {
    if (!autoPrint || !printable || printed.current) return;
    const timer = window.setTimeout(() => {
      if (printed.current) return;
      printed.current = true;
      window.print();
    }, AUTO_PRINT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [autoPrint, printable]);

  // Back within the app when this page was opened from it, otherwise to the
  // persons – `history.length` also counts other sites and the tab's blank
  // start page (opened after the login redirect, "Zurück" left the app).
  // React Router numbers its history entries (`idx`, 0 = the first one of
  // this app visit; a reload keeps it).
  function goBack() {
    const index = (window.history.state as { idx?: unknown } | null)?.idx;
    if (typeof index === 'number' && index > 0) void navigate(-1);
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
            {loaded ? (
              <p className="text-sm text-muted">
                {formatCount(list.length)} {list.length === 1 ? 'Person' : 'Personen'}
              </p>
            ) : null}
          </div>
          <Button
            variant="primary"
            icon={<Printer className="size-5" aria-hidden />}
            onClick={() => window.print()}
            disabled={!printable}
            loading={ready && !complete}
          >
            Drucken
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-safe py-4 print:max-w-none print:p-0">
        {!loaded ? (
          persons.isError ? (
            <QueryError error={persons.error} onRetry={() => void persons.refetch()} />
          ) : (
            <PageSpinner />
          )
        ) : list.length === 0 ? (
          <EmptyState title="Keine Personen" />
        ) : (
          <>
            <div
              className="grid grid-cols-2 gap-3 rounded-2xl bg-white p-3 text-black shadow-sm sm:grid-cols-3 print:grid-cols-3 print:gap-[6mm] print:rounded-none print:p-0 print:shadow-none"
              data-testid="qr-sheet"
            >
              {list.slice(0, count).map((person) => (
                <QrCard key={person.id} number={person.number} name={person.name} nickname={person.nickname} />
              ))}
            </div>
            {complete ? null : (
              <p
                className="flex items-center justify-center gap-2 py-6 text-sm text-muted print:hidden"
                data-testid="qr-sheet-progress"
              >
                <Spinner className="size-5" />
                Weitere QR-Codes werden erstellt …
              </p>
            )}
          </>
        )}
      </main>
    </div>
  );
}

/**
 * Size of the number under the code: numbers have up to 20 characters, and a
 * long one in `text-2xl` ran into the neighbouring card (screen and print).
 */
function numberSize(number: string): string {
  if (number.length > 14) return 'text-base';
  if (number.length > 9) return 'text-lg';
  if (number.length > 5) return 'text-xl';
  return 'text-2xl';
}

/** Memoized: a refetch of the persons re-renders only the cards that changed. */
const QrCard = memo(function QrCard({ number, name, nickname }: { number: string; name: string; nickname: string }) {
  return (
    <figure
      className="flex min-w-0 break-inside-avoid flex-col items-center rounded-xl border border-dashed border-neutral-300 p-3 text-center"
      data-testid="qr-card"
      data-person-number={number}
    >
      <QrCode value={number} className="aspect-square w-full max-w-44 print:w-[42mm] print:max-w-full" />
      <figcaption className="mt-1 w-full min-w-0">
        {/* (a number never breaks inside a word unless it does not fit) */}
        <span className={cn('block font-bold tabular-nums wrap-anywhere', numberSize(number))}>{number}</span>
        {name ? <span className="block truncate text-sm">{name}</span> : null}
        {nickname ? <span className="block truncate text-xs text-neutral-600">„{nickname}“</span> : null}
      </figcaption>
    </figure>
  );
});
