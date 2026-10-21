/**
 * Buchungen – list (newest first, paginated), filters, summary, views per
 * person / per offering, CSV export of the current filter, cancel.
 */
import { FileDown, ReceiptText, Square, SquareCheck } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { fetchAllBookings, useBookingList, useTotals } from '../../api/queries';
import { useCurrentUser } from '../../auth/session';
import { ConnectionHint } from '../../components/ConnectionHint';
import { Button } from '../../components/ui/Button';
import { Card, EmptyState, QueryError } from '../../components/ui/Feedback';
import { cn } from '../../components/ui/cn';
import { TextField } from '../../components/ui/Field';
import { PageHeader } from '../../components/ui/PageHeader';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { PageSpinner, Spinner } from '../../components/ui/Spinner';
import { bookingsToCsv } from '../../lib/csv';
import { formatDayHeading, parsePbDate, PERIOD_LABELS, startOfLocalDay, type PeriodKey } from '../../lib/dates';
import { downloadText } from '../../lib/download';
import { errorMessage } from '../../lib/errors';
import { formatCents, formatCount } from '../../lib/money';
import { canCancelBooking } from '../../lib/permissions';
import type { BookingRecord, Totals, TotalsPart, TotalsPerOffering } from '../../lib/types';
import { useToday } from '../../lib/useToday';
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
import { PerPersonView } from './PerPersonView';
import { PersonFilter } from './PersonFilter';

const PERIOD_OPTIONS = (['today', '7d', '30d', 'all', 'custom'] as const).map((value: PeriodKey) => ({
  value,
  label: PERIOD_LABELS[value],
}));

const VIEW_OPTIONS: ReadonlyArray<{ value: BookingView; label: string }> = [
  { value: 'liste', label: 'Liste' },
  { value: 'personen', label: 'Pro Person' },
  { value: 'angebote', label: 'Pro Angebot' },
];

/** The totals parts each view shows (`parts=`; the per-person rows are the expensive part). */
const VIEW_TOTALS_PARTS: Record<BookingView, TotalsPart[]> = {
  liste: ['summary'],
  personen: ['summary', 'perPerson'],
  angebote: ['summary', 'perOffering'],
};

export function BookingsPage() {
  const user = useCurrentUser();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const filter = useMemo(() => parseFilterParams(params), [params]);
  const query = useMemo(() => toBookingQuery(filter, user?.id), [filter, user?.id]);
  const totals = useTotals(query, true, { keepPrevious: true, parts: VIEW_TOTALS_PARTS[filter.view] });
  // The previous filter's numbers while the new ones load: shown dimmed, never as the new result.
  const stale = totals.isPlaceholderData;
  const [exporting, setExporting] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<BookingRecord | null>(null);
  const rangeErrorId = useId();

  // Latest filter, also between a URL update and the next render (fast
  // successive changes must not overwrite each other).
  const latestFilter = useRef(filter);
  useEffect(() => {
    latestFilter.current = filter;
  }, [filter]);

  // Unknown or malformed parameters (`?zeitraum=HEUTE`, `?ansicht=bar`, an
  // invalid date) are shown as the defaults – and the URL says so, too.
  useEffect(() => {
    const canonical = filterToParams(filter);
    if (canonical.toString() !== params.toString()) setParams(canonical, { replace: true });
  }, [filter, params, setParams]);

  /**
   * Filter changes replace the history entry – except a drill-down to one
   * person (`push`): Back returns from that person's bookings to where the
   * person was picked (e.g. "Pro Person").
   */
  function update(patch: Partial<BookingFilterState>, { push = false } = {}) {
    const next = { ...latestFilter.current, ...patch };
    latestFilter.current = next;
    setParams(filterToParams(next), { replace: !push });
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
      toast.success(`${formatCount(bookings.length)} ${bookings.length === 1 ? 'Buchung' : 'Buchungen'} exportiert`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setExporting(false);
    }
  }

  // (`YYYY-MM-DD` compares like the dates)
  const reversedRange = filter.period === 'custom' && Boolean(filter.from && filter.to) && filter.from > filter.to;

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
              aria-invalid={reversedRange || undefined}
              aria-describedby={reversedRange ? rangeErrorId : undefined}
            />
            <TextField
              label="Bis"
              type="date"
              value={filter.to}
              min={filter.from || undefined}
              onChange={(e) => update({ to: e.target.value })}
              aria-invalid={reversedRange || undefined}
              aria-describedby={reversedRange ? rangeErrorId : undefined}
            />
            {reversedRange ? (
              <p id={rangeErrorId} role="alert" className="col-span-2 text-sm font-medium text-danger">
                „Von“ liegt nach „Bis“ – bitte den Zeitraum korrigieren.
              </p>
            ) : null}
          </div>
        ) : null}
        {/* "Nur meine" moves below the person field rather than squeezing it (narrow phones, large text) */}
        <div className="flex flex-wrap items-stretch gap-2">
          <PersonFilter
            personId={filter.personId}
            onChange={(personId) => update({ personId }, { push: Boolean(personId) })}
            className="flex-[1_1_10rem]"
          />
          <button
            type="button"
            aria-pressed={filter.mine}
            onClick={() => update({ mine: !filter.mine })}
            data-testid="only-mine"
            className={cn(
              'flex min-h-12 shrink-0 grow items-center gap-2 rounded-xl border px-3 text-sm font-semibold whitespace-nowrap shadow-sm transition-colors sm:grow-0',
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

      {/* a failed refresh keeps the numbers shown – this says they may be outdated */}
      <ConnectionHint className="mt-4" />

      <Summary
        totals={totals.data}
        loading={totals.isPending}
        stale={stale}
        error={totals.error}
        onRetry={() => void totals.refetch()}
      />

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
        <PerPersonView
          totals={totals.data}
          stale={stale}
          error={totals.error}
          onRetry={() => void totals.refetch()}
          onSelect={(personId) => update({ personId, view: 'liste' }, { push: true })}
          resetKey={params.toString()}
          entryKey={location.key}
        />
      ) : (
        <PerOfferingView
          totals={totals.data?.perOffering ? totals.data : undefined}
          stale={stale}
          error={totals.error}
          onRetry={() => void totals.refetch()}
        />
      )}

      <CancelBookingDialog booking={cancelTarget} onClose={() => setCancelTarget(null)} />
    </>
  );
}

function Summary({
  totals,
  loading,
  stale,
  error,
  onRetry,
}: {
  totals: Totals | undefined;
  loading: boolean;
  /** `totals` belong to the previous filter (the new ones are loading). */
  stale: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  if (error && !totals) return <QueryError error={error} onRetry={onRetry} className="mt-4" />;
  return (
    <div
      className={cn(
        'mt-4 flex items-center justify-between gap-4 rounded-3xl bg-primary px-5 py-4 text-on-primary shadow-sm transition-opacity',
        stale && 'opacity-60',
      )}
      data-testid="bookings-summary"
      aria-live="polite"
      aria-busy={stale || undefined}
    >
      <div>
        <p className="flex items-center gap-1.5 text-sm font-medium">
          Buchungen
          {stale ? <Spinner className="size-3.5" label="Wird geladen …" /> : null}
        </p>
        <p className="text-2xl font-bold tabular-nums" data-testid="bookings-count">
          {loading && !totals ? '…' : formatCount(totals?.count ?? 0)}
        </p>
      </div>
      <div className="text-right">
        <p className="text-sm font-medium">Summe</p>
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
  // "Heute" / "Gestern" and the time-only rows of today move on at midnight
  const now = useToday();
  // Keyset pages do not overlap (each page is older than the last row of the
  // previous one, see queries.ts); showing every booking once only guards the
  // rendering – duplicate React keys would leave a stale row in the DOM.
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

  const retry = () => void (list.isFetchNextPageError ? list.fetchNextPage() : list.refetch());
  if (list.isPending) return <PageSpinner />;
  // A failed refresh or "Weitere laden" keeps the loaded bookings (the error shows below them) –
  // but an empty list whose refresh failed says so: "Keine Buchungen" may be wrong (L4).
  if (list.isError && bookings.length === 0) return <QueryError error={list.error} onRetry={retry} />;
  // Every loaded booking can be gone (cancelled elsewhere) while older ones exist:
  // then "Weitere laden" stays (the list reloads itself, bookingSync.ts).
  if (bookings.length === 0 && !list.hasNextPage) {
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
      {list.isError && !list.isFetching ? (
        <QueryError error={list.error} onRetry={retry} />
      ) : list.hasNextPage ? (
        <Button
          block
          loading={list.isFetchingNextPage || (bookings.length === 0 && list.isFetching)}
          onClick={() => void list.fetchNextPage()}
        >
          Weitere laden
        </Button>
      ) : null}
    </div>
  );
}

function PerOfferingView({
  totals,
  stale,
  error,
  onRetry,
}: {
  totals: Totals | undefined;
  stale: boolean;
  /** The totals' error: without numbers the summary shows it; with none, it replaces "Keine Buchungen". */
  error: unknown;
  onRetry: () => void;
}) {
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

  if (!totals) return error ? null : <PageSpinner />;
  if (groups.length === 0) {
    if (error) return <QueryError error={error} onRetry={onRetry} />;
    return <EmptyState icon={<ReceiptText className="size-7" aria-hidden />} title="Keine Buchungen" />;
  }
  return (
    <div
      className={cn('space-y-5 transition-opacity', stale && 'opacity-50')}
      data-testid="totals-per-offering"
      aria-busy={stale || undefined}
    >
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
                <span className="shrink-0 text-muted tabular-nums">{formatCount(entry.quantity)}×</span>
                <span className="w-24 shrink-0 text-right font-bold tabular-nums">{formatCents(entry.totalCents)}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
