/**
 * Personen – search and list (number, name, nickname, total per person).
 *
 * Built for thousands of persons on phones (docs/LOADTEST-FINDINGS.md F1):
 * only the first 100 matches are rendered ("Weitere 100 anzeigen" appends),
 * the rows are memoized with primitive props (a totals update re-renders
 * only the rows whose numbers changed), and the list follows the search
 * field as a deferred value, so typing never waits for the list. The search
 * text stays in the URL (`?q=`), updated shortly after typing stops.
 */
import { ChevronRight, Printer, Search, UserPlus, Users } from 'lucide-react';
import { memo, useDeferredValue, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { usePersons, useReferenceTotals } from '../../api/queries';
import { ConnectionHint } from '../../components/ConnectionHint';
import { ShowMoreFooter } from '../../components/ShowMoreFooter';
import { Button, ButtonLink } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { EmptyState, NumberBadge, QueryError } from '../../components/ui/Feedback';
import { PageHeader } from '../../components/ui/PageHeader';
import { PageSpinner } from '../../components/ui/Spinner';
import { formatCents, formatCount } from '../../lib/money';
import { searchPersons } from '../../lib/search';
import { useSearchParamState } from '../../lib/useSearchParamState';
import { useShowMore } from '../../lib/useShowMore';
import { PersonForm } from './PersonForm';

export function PersonsPage() {
  const persons = usePersons();
  const totals = useReferenceTotals({ parts: ['perPerson'] });
  const navigate = useNavigate();
  // flushQuery: a person tapped right after typing – the search goes into the URL first (Back returns to it)
  const [query, setQuery, flushQuery] = useSearchParamState('q');
  const listQuery = useDeferredValue(query);
  const [creating, setCreating] = useState(false);

  const all = useMemo(() => persons.data ?? [], [persons.data]);
  const results = useMemo(() => searchPersons(all, listQuery), [all, listQuery]);
  const { limit, showMore } = useShowMore(listQuery);
  const listRef = useRef<HTMLUListElement>(null);
  const totalsById = useMemo(
    () => new Map((totals.data?.perPerson ?? []).map((entry) => [entry.personId, entry])),
    [totals.data],
  );

  return (
    <>
      <PageHeader
        title="Personen"
        subtitle={persons.data ? `${formatCount(all.length)} ${all.length === 1 ? 'Person' : 'Personen'}` : undefined}
        actions={
          <>
            <ButtonLink
              to="/personen/qr-codes"
              variant="ghost"
              icon={<Printer className="size-5" aria-hidden />}
              aria-label="Alle QR-Codes drucken"
              title="Alle QR-Codes drucken"
              className="min-w-12 px-3"
            >
              <span className="hidden sm:inline">QR-Codes</span>
            </ButtonLink>
            <Button variant="primary" icon={<UserPlus className="size-5" aria-hidden />} onClick={() => setCreating(true)}>
              Neu
            </Button>
          </>
        }
      />

      <div className="sticky top-app z-10 -mx-4 bg-canvas/90 px-4 pt-1 pb-3 backdrop-blur-md lg:-mx-8 lg:px-8">
        <label className="relative block">
          <span className="sr-only">Personen durchsuchen</span>
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-muted" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Nummer, Name oder Nickname"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            data-testid="persons-search"
            className="block h-12 w-full rounded-2xl border border-line-strong bg-surface pr-4 pl-11 shadow-sm focus:border-primary focus:outline-2 focus:outline-offset-0 focus:outline-primary/40"
          />
        </label>
      </div>

      {/* a failed background refresh keeps the loaded persons – the hint says they may be outdated */}
      <ConnectionHint className="mb-3" />
      {!persons.data || (persons.isError && all.length === 0) ? (
        persons.isError ? (
          <QueryError error={persons.error} onRetry={() => void persons.refetch()} />
        ) : (
          <PageSpinner />
        )
      ) : results.length === 0 ? (
        <EmptyState
          icon={<Users className="size-7" aria-hidden />}
          title={all.length === 0 ? 'Noch keine Personen' : 'Keine Person gefunden'}
          action={
            <Button variant="primary" icon={<UserPlus className="size-5" aria-hidden />} onClick={() => setCreating(true)}>
              Person anlegen
            </Button>
          }
        />
      ) : (
        <>
          <ul
            ref={listRef}
            className="divide-y divide-line overflow-hidden rounded-3xl border border-line bg-surface"
            aria-label="Personen"
          >
            {results.slice(0, limit).map((person) => {
              const total = totalsById.get(person.id);
              return (
                <PersonRow
                  key={person.id}
                  id={person.id}
                  number={person.number}
                  name={person.name}
                  nickname={person.nickname}
                  totalCents={total?.totalCents ?? null}
                  count={total?.count ?? null}
                  onOpen={flushQuery}
                />
              );
            })}
          </ul>
          <ShowMoreFooter
            shown={Math.min(limit, results.length)}
            total={results.length}
            onShowMore={showMore}
            listRef={listRef}
            testId="persons-more"
          />
        </>
      )}

      <Dialog open={creating} onClose={() => setCreating(false)} title="Neue Person" testId="person-dialog">
        <PersonForm
          onCancel={() => setCreating(false)}
          // (not called when the dialog was closed while saving – see PersonForm)
          onSaved={(person) => {
            setCreating(false);
            toast.success(`Person ${person.number} angelegt`);
            void navigate(`/personen/${person.id}`, { state: { created: true } });
          }}
        />
      </Dialog>
    </>
  );
}

interface PersonRowProps {
  id: string;
  number: string;
  name: string;
  nickname: string;
  /** null: no bookings (or the totals are still loading). */
  totalCents: number | null;
  count: number | null;
  /** Stable callback, runs before the row navigates. */
  onOpen: () => void;
}

/**
 * Only primitive props: the totals arrive as new objects after every booking
 * (refetch or patch), but a row re-renders only when its own values changed.
 */
const PersonRow = memo(function PersonRow({ id, number, name, nickname, totalCents, count, onOpen }: PersonRowProps) {
  return (
    <li>
      <Link
        to={`/personen/${id}`}
        onClick={onOpen}
        data-testid="person-row"
        data-person-number={number}
        className="flex min-h-16 items-center gap-3 px-3 py-2 transition-colors hover:bg-surface-2 active:bg-surface-3"
      >
        <NumberBadge number={number} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{name || <span className="text-muted">Ohne Namen</span>}</span>
          {nickname ? <span className="block truncate text-sm text-muted">„{nickname}“</span> : null}
        </span>
        {totalCents !== null && count !== null ? (
          <span className="shrink-0 text-right">
            <span className="block font-semibold tabular-nums">{formatCents(totalCents)}</span>
            <span className="block text-xs text-muted">
              {formatCount(count)} {count === 1 ? 'Buchung' : 'Buchungen'}
            </span>
          </span>
        ) : null}
        <ChevronRight className="size-5 shrink-0 text-muted" aria-hidden />
      </Link>
    </li>
  );
});
