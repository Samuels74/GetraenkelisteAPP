/**
 * Buchungen "Pro Person": one row per person with bookings in the current
 * filter, natural order by number (2 before 10, like the person list).
 *
 * With thousands of persons only the first 100 rows are rendered ("Weitere
 * 100 anzeigen" appends), and the rows are memoized with primitive props, so
 * a totals update re-renders only the rows that changed – rendering every
 * row took 0.64 s on a phone (docs/LOADTEST-FINDINGS.md F5).
 */
import { ChevronRight, ReceiptText } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { ShowMoreFooter } from '../../components/ShowMoreFooter';
import { cn } from '../../components/ui/cn';
import { EmptyState, NumberBadge, QueryError } from '../../components/ui/Feedback';
import { PageSpinner } from '../../components/ui/Spinner';
import { formatCents, formatCount } from '../../lib/money';
import { sortPersons } from '../../lib/search';
import type { Totals } from '../../lib/types';
import { LIST_PAGE_SIZE, useShowMore } from '../../lib/useShowMore';

/**
 * Rows shown per history entry: a row opens that person's bookings as a new
 * entry, and Back returns to the list with the rows ("Weitere …") it showed.
 * Only the most recent entries are remembered (Back rarely goes further).
 */
const shownPerEntry = new Map<string, number>();
const REMEMBERED_ENTRIES = 50;

function rememberShown(entryKey: string, limit: number): void {
  shownPerEntry.delete(entryKey); // (re-inserted: the most recent last)
  shownPerEntry.set(entryKey, limit);
  for (const oldest of shownPerEntry.keys()) {
    if (shownPerEntry.size <= REMEMBERED_ENTRIES) break;
    shownPerEntry.delete(oldest);
  }
}

export function PerPersonView({
  totals,
  stale = false,
  error,
  onRetry,
  onSelect,
  resetKey,
  entryKey,
}: {
  totals: Totals | undefined;
  /** `totals` belong to the previous filter (the new ones are loading): shown dimmed. */
  stale?: boolean;
  /** The totals' error: without numbers the summary shows it; with no rows, it replaces "Keine Buchungen". */
  error?: unknown;
  onRetry?: () => void;
  onSelect: (personId: string) => void;
  /** The filter: a new filter shows the first 100 rows again. */
  resetKey: string;
  /** The history entry (location.key) – its rows are restored when Back returns to it. */
  entryKey?: string;
}) {
  const entries = useMemo(
    () => sortPersons((totals?.perPerson ?? []).map((entry) => ({ ...entry, id: entry.personId }))),
    [totals],
  );
  const { limit, showMore } = useShowMore(resetKey, LIST_PAGE_SIZE, entryKey ? shownPerEntry.get(entryKey) : undefined);
  useEffect(() => {
    if (entryKey) rememberShown(entryKey, limit);
  }, [entryKey, limit]);
  const listRef = useRef<HTMLUListElement>(null);
  // The memoized rows get one stable handler that calls the latest onSelect.
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  });
  const select = useCallback((personId: string) => onSelectRef.current(personId), []);

  // (no perPerson part yet, e.g. the summary of the list view as placeholder data: still loading)
  if (!totals?.perPerson) return error ? null : <PageSpinner />;
  if (entries.length === 0) {
    // a failed refresh of an empty view: "Keine Buchungen" may be wrong (L4)
    if (error) return <QueryError error={error} onRetry={onRetry} />;
    return <EmptyState icon={<ReceiptText className="size-7" aria-hidden />} title="Keine Buchungen" />;
  }
  return (
    <>
      <ul
        ref={listRef}
        className={cn(
          'divide-y divide-line overflow-hidden rounded-3xl border border-line bg-surface transition-opacity',
          stale && 'opacity-50',
        )}
        data-testid="totals-per-person"
        aria-busy={stale || undefined}
      >
        {entries.slice(0, limit).map((entry) => (
          <PerPersonRow
            key={entry.personId}
            personId={entry.personId}
            number={entry.number}
            name={entry.name}
            nickname={entry.nickname}
            quantity={entry.quantity}
            totalCents={entry.totalCents}
            onSelect={select}
          />
        ))}
      </ul>
      <ShowMoreFooter
        shown={Math.min(limit, entries.length)}
        total={entries.length}
        onShowMore={showMore}
        listRef={listRef}
        testId="totals-per-person-more"
      />
    </>
  );
}

const PerPersonRow = memo(function PerPersonRow({
  personId,
  number,
  name,
  nickname,
  quantity,
  totalCents,
  onSelect,
}: {
  personId: string;
  number: string;
  name: string;
  nickname: string;
  quantity: number;
  totalCents: number;
  onSelect: (personId: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(personId)}
        className="flex min-h-16 w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-surface-2 active:bg-surface-3"
        data-testid="totals-person-row"
        data-person-number={number}
      >
        <NumberBadge number={number} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{name || 'Ohne Namen'}</span>
          <span className="block truncate text-sm text-muted">
            {nickname ? `„${nickname}“ · ` : ''}
            {formatCount(quantity)}×
          </span>
        </span>
        <span className="shrink-0 font-bold tabular-nums">{formatCents(totalCents)}</span>
        <ChevronRight className="size-5 shrink-0 text-muted" aria-hidden />
      </button>
    </li>
  );
});
