/**
 * Buchungen – list (newest first, paginated), filters, summary, views per
 * person / per offering, CSV export of the current filter, cancel.
 */
import { ChevronRight, FileDown, ReceiptText, Square, SquareCheck } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { fetchAllBookings, useBookingList, usePersons, useTotals } from '../../api/queries';
import { useCurrentUser } from '../../auth/session';
import { Button } from '../../components/ui/Button';
import { Card, EmptyState, NumberBadge, QueryError } from '../../components/ui/Feedback';
import { cn } from '../../components/ui/cn';
import { SelectField, TextField } from '../../components/ui/Field';
import { PageHeader } from '../../components/ui/PageHeader';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { PageSpinner } from '../../components/ui/Spinner';
import { bookingsToCsv } from '../../lib/csv';
import { formatDayHeading, parsePbDate, PERIOD_LABELS, startOfLocalDay, type PeriodKey } from '../../lib/dates';
import { downloadText } from '../../lib/download';
import { errorMessage } from '../../lib/errors';
import { formatCents } from '../../lib/money';
import { canCancelBooking } from '../../lib/permissions';
import { sortPersons } from '../../lib/search';
import type { BookingRecord, Totals, TotalsPerOffering } from '../../lib/types';
import { BookingItem } from './BookingItem';
import { CancelBookingDialog } from './CancelBookingDialog';
import {
  csvFileName,
  filterToParams,
  parseFilterParams,
  toBookingQuery,
  type BookingFilterState,
  type BookingView,
} from './filters';

const PERIOD_OPTIONS = (['today', '7d', '30d', 'all', 'custom'] as const).map((value: PeriodKey) => ({
  value,
  label: PERIOD_LABELS[value],
}));

const VIEW_OPTIONS: ReadonlyArray<{ value: BookingView; label: string }> = [
  { value: 'liste', label: 'Liste' },
  { value: 'personen', label: 'Pro Person' },
  { value: 'angebote', label: 'Pro Angebot' },
];

export function BookingsPage() {
  const user = useCurrentUser();
  const [params, setParams] = useSearchParams();
  const filter = useMemo(() => parseFilterParams(params), [params]);
  const query = useMemo(() => toBookingQuery(filter, user?.id), [filter, user?.id]);
  const persons = usePersons();
  const totals = useTotals(query, true, { keepPrevious: true });
  const [exporting, setExporting] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<BookingRecord | null>(null);

  // Latest filter, also between a URL update and the next render (fast
  // successive changes must not overwrite each other).
  const latestFilter = useRef(filter);
  useEffect(() => {
    latestFilter.current = filter;
  }, [filter]);

  function update(patch: Partial<BookingFilterState>) {
    const next = { ...latestFilter.current, ...patch };
    latestFilter.current = next;
    setParams(filterToParams(next), { replace: true });
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const bookings = await fetchAllBookings(query);
      if (bookings.length === 0) {
        toast.info('Keine Buchungen für diesen Filter.');
        return;
      }
      downloadText(bookingsToCsv(bookings), csvFileName(filter, new Date()));
      toast.success(`${bookings.length} ${bookings.length === 1 ? 'Buchung' : 'Buchungen'} exportiert`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setExporting(false);
    }
  }

  const selectedPersonMissing =
    filter.personId && persons.data && !persons.data.some((p) => p.id === filter.personId);

  return (
    <>
      <PageHeader
        title="Buchungen"
        actions={
          <Button
            icon={<FileDown className="size-5" aria-hidden />}
            loading={exporting}
            onClick={() => void exportCsv()}
            data-testid="csv-export"
          >
            CSV
          </Button>
        }
      />

      <Card className="space-y-3 p-3">
        <SegmentedControl
          label="Zeitraum"
          options={PERIOD_OPTIONS}
          value={filter.period}
          onChange={(period) => update({ period })}
          testId="period-filter"
        />
        {filter.period === 'custom' ? (
          <div className="grid grid-cols-2 gap-3">
            <TextField
              label="Von"
              type="date"
              value={filter.from}
              max={filter.to || undefined}
              onChange={(e) => update({ from: e.target.value })}
            />
            <TextField
              label="Bis"
              type="date"
              value={filter.to}
              min={filter.from || undefined}
              onChange={(e) => update({ to: e.target.value })}
            />
          </div>
        ) : null}
        <div className="flex items-stretch gap-2">
          <SelectField
            label="Person"
            hideLabel
            containerClassName="min-w-0 flex-1"
            value={filter.personId}
            onChange={(e) => update({ personId: e.target.value })}
            data-testid="person-filter"
          >
            <option value="">Alle Personen</option>
            {selectedPersonMissing ? <option value={filter.personId}>Unbekannte Person</option> : null}
            {(persons.data ?? []).map((person) => (
              <option key={person.id} value={person.id}>
                {person.number}
                {person.name ? ` – ${person.name}` : ''}
                {person.nickname ? ` („${person.nickname}“)` : ''}
              </option>
            ))}
          </SelectField>
          <button
            type="button"
            aria-pressed={filter.mine}
            onClick={() => update({ mine: !filter.mine })}
            data-testid="only-mine"
            className={cn(
              'flex min-h-12 shrink-0 items-center gap-2 rounded-xl border px-3 text-sm font-semibold whitespace-nowrap shadow-sm transition-colors',
              filter.mine
                ? 'border-primary bg-primary-soft text-on-primary-soft'
                : 'border-line-strong bg-surface text-fg hover:bg-surface-2',
            )}
          >
            {filter.mine ? (
              <SquareCheck className="size-5" aria-hidden />
            ) : (
              <Square className="size-5 text-muted" aria-hidden />
            )}
            Nur meine
          </button>
        </div>
      </Card>

      <Summary totals={totals.data} loading={totals.isPending} error={totals.error} onRetry={() => void totals.refetch()} />

      <div className="mt-4 mb-3">
        <SegmentedControl
          label="Ansicht"
          options={VIEW_OPTIONS}
          value={filter.view}
          onChange={(view) => update({ view })}
          testId="view-switch"
        />
      </div>

      {filter.view === 'liste' ? (
        <BookingList
          filterKey={params.toString()}
          query={query}
          onCancel={setCancelTarget}
          canCancel={(booking) => canCancelBooking(user, booking)}
        />
      ) : filter.view === 'personen' ? (
        <PerPersonView totals={totals.data} onSelect={(personId) => update({ personId, view: 'liste' })} />
      ) : (
        <PerOfferingView totals={totals.data} />
      )}

      <CancelBookingDialog booking={cancelTarget} onClose={() => setCancelTarget(null)} />
    </>
  );
}

function Summary({
  totals,
  loading,
  error,
  onRetry,
}: {
  totals: Totals | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  if (error && !totals) return <QueryError error={error} onRetry={onRetry} className="mt-4" />;
  return (
    <div
      className="mt-4 flex items-center justify-between gap-4 rounded-3xl bg-primary px-5 py-4 text-on-primary shadow-sm"
      data-testid="bookings-summary"
      aria-live="polite"
    >
      <div>
        <p className="text-sm font-medium opacity-90">Buchungen</p>
        <p className="text-2xl font-bold tabular-nums" data-testid="bookings-count">
          {loading && !totals ? '…' : (totals?.count ?? 0)}
        </p>
      </div>
      <div className="text-right">
        <p className="text-sm font-medium opacity-90">Summe</p>
        <p className="text-2xl font-bold tabular-nums" data-testid="bookings-total">
          {loading && !totals ? '…' : formatCents(totals?.totalCents ?? 0)}
        </p>
      </div>
    </div>
  );
}

function BookingList({
  filterKey,
  query,
  onCancel,
  canCancel,
}: {
  filterKey: string;
  query: ReturnType<typeof toBookingQuery>;
  onCancel: (booking: BookingRecord) => void;
  canCancel: (booking: BookingRecord) => boolean;
}) {
  const list = useBookingList(query);
  const [now] = useState(() => new Date());
  // Offset pages can overlap when bookings are added while the next page loads
  // (until the realtime refetch settles the list): show every booking once –
  // duplicate React keys would also leave a stale row in the DOM.
  const bookings = useMemo(() => {
    const seen = new Set<string>();
    return (list.data?.pages.flatMap((page) => page.items) ?? []).filter((booking) => {
      if (seen.has(booking.id)) return false;
      seen.add(booking.id);
      return true;
    });
  }, [list.data]);

  const days = useMemo(() => {
    const result: Array<{ key: number; heading: string; items: BookingRecord[] }> = [];
    for (const booking of bookings) {
      const created = parsePbDate(booking.created);
      const key = startOfLocalDay(created).getTime();
      let day = result.at(-1);
      if (!day || day.key !== key) {
        day = { key, heading: formatDayHeading(created, now), items: [] };
        result.push(day);
      }
      day.items.push(booking);
    }
    return result;
  }, [bookings, now]);

  if (list.isPending) return <PageSpinner />;
  if (list.isError) return <QueryError error={list.error} onRetry={() => void list.refetch()} />;
  if (bookings.length === 0) {
    return (
      <EmptyState icon={<ReceiptText className="size-7" aria-hidden />} title="Keine Buchungen">
        Für diesen Filter gibt es keine Buchungen.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-5" data-testid="bookings-list" data-filter={filterKey}>
      {days.map((day) => (
        <section key={day.key} aria-label={day.heading}>
          <h2 className="mb-2 px-1 text-sm font-bold tracking-wide text-muted uppercase">{day.heading}</h2>
          <ul className="divide-y divide-line overflow-hidden rounded-3xl border border-line bg-surface">
            {day.items.map((booking) => (
              <BookingItem
                key={booking.id}
                booking={booking}
                now={now}
                showPerson
                canCancel={canCancel(booking)}
                onCancel={onCancel}
              />
            ))}
          </ul>
        </section>
      ))}
      {list.hasNextPage ? (
        <Button block loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
          Weitere laden
        </Button>
      ) : null}
    </div>
  );
}

function PerPersonView({ totals, onSelect }: { totals: Totals | undefined; onSelect: (personId: string) => void }) {
  // natural order by number (2 before 10), like the person list
  const entries = useMemo(
    () => sortPersons((totals?.perPerson ?? []).map((entry) => ({ ...entry, id: entry.personId }))),
    [totals],
  );
  if (!totals) return <PageSpinner />;
  if (entries.length === 0) {
    return <EmptyState icon={<ReceiptText className="size-7" aria-hidden />} title="Keine Buchungen" />;
  }
  return (
    <ul
      className="divide-y divide-line overflow-hidden rounded-3xl border border-line bg-surface"
      data-testid="totals-per-person"
    >
      {entries.map((entry) => (
        <li key={entry.personId}>
          <button
            type="button"
            onClick={() => onSelect(entry.personId)}
            className="flex min-h-16 w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-surface-2 active:bg-surface-3"
            data-testid="totals-person-row"
            data-person-number={entry.number}
          >
            <NumberBadge number={entry.number} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold">{entry.name || 'Ohne Namen'}</span>
              <span className="block truncate text-sm text-muted">
                {entry.nickname ? `„${entry.nickname}“ · ` : ''}
                {entry.quantity}×
              </span>
            </span>
            <span className="shrink-0 font-bold tabular-nums">{formatCents(entry.totalCents)}</span>
            <ChevronRight className="size-5 shrink-0 text-muted" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

function PerOfferingView({ totals }: { totals: Totals | undefined }) {
  const groups = useMemo(() => {
    const result: Array<{ id: string; name: string; entries: TotalsPerOffering[]; totalCents: number }> = [];
    for (const entry of totals?.perOffering ?? []) {
      let group = result.find((g) => g.id === entry.groupId);
      if (!group) {
        group = { id: entry.groupId, name: entry.groupName, entries: [], totalCents: 0 };
        result.push(group);
      }
      group.entries.push(entry);
      group.totalCents += entry.totalCents;
    }
    return result;
  }, [totals]);

  if (!totals) return <PageSpinner />;
  if (groups.length === 0) {
    return <EmptyState icon={<ReceiptText className="size-7" aria-hidden />} title="Keine Buchungen" />;
  }
  return (
    <div className="space-y-5" data-testid="totals-per-offering">
      {groups.map((group) => (
        <section key={group.id} aria-label={group.name}>
          <h2 className="mb-2 flex justify-between px-1 text-sm font-bold tracking-wide text-muted uppercase">
            <span>{group.name}</span>
            <span className="tabular-nums">{formatCents(group.totalCents)}</span>
          </h2>
          <ul className="divide-y divide-line overflow-hidden rounded-3xl border border-line bg-surface">
            {group.entries.map((entry) => (
              <li
                key={entry.offeringId}
                className="flex min-h-14 items-center gap-3 px-4 py-2"
                data-testid="totals-offering-row"
                data-offering-name={entry.name}
              >
                <span className="min-w-0 flex-1 truncate font-semibold">{entry.name}</span>
                <span className="shrink-0 text-muted tabular-nums">{entry.quantity}×</span>
                <span className="w-24 shrink-0 text-right font-bold tabular-nums">{formatCents(entry.totalCents)}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

