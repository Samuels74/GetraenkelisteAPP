import { ChevronRight, Printer, Search, UserPlus, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { usePersons, useReferenceTotals } from '../../api/queries';
import { Button, ButtonLink } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { EmptyState, NumberBadge, QueryError } from '../../components/ui/Feedback';
import { PageHeader } from '../../components/ui/PageHeader';
import { PageSpinner } from '../../components/ui/Spinner';
import { formatCents } from '../../lib/money';
import { searchPersons } from '../../lib/search';
import { PersonForm } from './PersonForm';

export function PersonsPage() {
  const persons = usePersons();
  const totals = useReferenceTotals();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const [creating, setCreating] = useState(false);

  const all = useMemo(() => persons.data ?? [], [persons.data]);
  const results = useMemo(() => searchPersons(all, query), [all, query]);
  const totalsById = useMemo(
    () => new Map((totals.data?.perPerson ?? []).map((entry) => [entry.personId, entry])),
    [totals.data],
  );

  function setQuery(value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set('q', value);
    else next.delete('q');
    setParams(next, { replace: true });
  }

  return (
    <>
      <PageHeader
        title="Personen"
        subtitle={persons.data ? `${all.length} ${all.length === 1 ? 'Person' : 'Personen'}` : undefined}
        actions={
          <>
            <ButtonLink
              to="/personen/qr-codes"
              variant="ghost"
              icon={<Printer className="size-5" aria-hidden />}
              aria-label="Alle QR-Codes drucken"
              title="Alle QR-Codes drucken"
              className="px-3"
            >
              <span className="hidden sm:inline">QR-Codes</span>
            </ButtonLink>
            <Button variant="primary" icon={<UserPlus className="size-5" aria-hidden />} onClick={() => setCreating(true)}>
              Neu
            </Button>
          </>
        }
      />

      <div className="sticky top-0 z-10 -mx-4 bg-canvas/90 px-4 pt-[max(0.25rem,env(safe-area-inset-top))] pb-3 backdrop-blur-md lg:-mx-8 lg:px-8">
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

      {persons.isPending ? (
        <PageSpinner />
      ) : persons.isError ? (
        <QueryError error={persons.error} onRetry={() => void persons.refetch()} />
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
        <ul className="divide-y divide-line overflow-hidden rounded-3xl border border-line bg-surface" aria-label="Personen">
          {results.map((person) => {
            const total = totalsById.get(person.id);
            return (
              <li key={person.id}>
                <Link
                  to={`/personen/${person.id}`}
                  data-testid="person-row"
                  data-person-number={person.number}
                  className="flex min-h-16 items-center gap-3 px-3 py-2 transition-colors hover:bg-surface-2 active:bg-surface-3"
                >
                  <NumberBadge number={person.number} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">
                      {person.name || <span className="text-muted">Ohne Namen</span>}
                    </span>
                    {person.nickname ? (
                      <span className="block truncate text-sm text-muted">„{person.nickname}“</span>
                    ) : null}
                  </span>
                  {total ? (
                    <span className="shrink-0 text-right">
                      <span className="block font-semibold tabular-nums">{formatCents(total.totalCents)}</span>
                      <span className="block text-xs text-muted">
                        {total.count} {total.count === 1 ? 'Buchung' : 'Buchungen'}
                      </span>
                    </span>
                  ) : null}
                  <ChevronRight className="size-5 shrink-0 text-muted" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={creating} onClose={() => setCreating(false)} title="Neue Person" testId="person-dialog">
        <PersonForm
          onCancel={() => setCreating(false)}
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
