/**
 * Buchen – the core flow: select person → tap tile → booked (1×).
 */
import { Beer, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ClientResponseError } from 'pocketbase';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { useCreateBooking, useDeleteBooking } from '../../api/mutations';
import { useGroups, useOfferings, usePersons, useRecentBookings, useTotals } from '../../api/queries';
import { isAdmin, useCurrentUser } from '../../auth/session';
import { ButtonLink } from '../../components/ui/Button';
import { cn } from '../../components/ui/cn';
import { EmptyState, QueryError } from '../../components/ui/Feedback';
import { PageSpinner } from '../../components/ui/Spinner';
import { errorMessage } from '../../lib/errors';
import { formatCents } from '../../lib/money';
import { createOnceGuard } from '../../lib/onceGuard';
import { canCancelBooking } from '../../lib/permissions';
import { useDocumentTitle } from '../../lib/useDocumentTitle';
import type { BookingRecord, OfferingRecord, PersonRecord } from '../../lib/types';
import { vibrate, VIBRATE_ERROR, VIBRATE_SUCCESS } from '../../lib/vibrate';
import { BookingItem } from '../bookings/BookingItem';
import { CancelBookingDialog } from '../bookings/CancelBookingDialog';
import { PersonPicker } from '../persons/PersonPicker';
import { OfferingGrid } from './OfferingGrid';
import { buildOfferingSections, type OfferingSection } from './offerings';
import { PersonCard } from './PersonCard';
import { isPersonConfirmedGone, setSelectedPersonId, useSelectedPersonId } from './selectedPerson';

/** One undo per booking (module level: survives re-renders and remounts). */
const undoGuard = createOnceGuard();
/** The undo result gets its own toast; reusing 'booking' made it vanish immediately. */
const UNDO_TOAST_ID = 'booking-undo';

interface PickerState {
  mode: 'search' | 'scan';
  pendingOffering: OfferingRecord | null;
}

export function BookPage() {
  useDocumentTitle('Buchen');
  const user = useCurrentUser();
  const persons = usePersons();
  const groups = useGroups();
  const offerings = useOfferings();
  const selectedId = useSelectedPersonId();
  const person = useMemo(
    () => (selectedId ? (persons.data?.find((p) => p.id === selectedId) ?? null) : null),
    [persons.data, selectedId],
  );
  const totals = useTotals({ period: 'all', personId: person?.id ?? null }, Boolean(person));
  const recent = useRecentBookings(person?.id, 8);
  const createBooking = useCreateBooking();
  const deleteBooking = useDeleteBooking();

  const [picker, setPicker] = useState<PickerState | null>(null);
  const [flash, setFlash] = useState<{ offeringId: string; key: number } | null>(null);
  const [cancelTarget, setCancelTarget] = useState<BookingRecord | null>(null);
  const [now, setNow] = useState(() => new Date());
  const flashTimer = useRef<number | undefined>(undefined);

  // A selected person missing from the list is dropped only when it is
  // confirmed deleted with a valid session (see isPersonConfirmedGone).
  const refetchPersons = persons.refetch;
  useEffect(() => {
    if (!persons.isSuccess || !selectedId || person) return;
    let cancelled = false;
    void isPersonConfirmedGone(selectedId).then((gone) => {
      if (cancelled) return;
      if (gone) setSelectedPersonId(null);
      else void refetchPersons();
    });
    return () => {
      cancelled = true;
    };
  }, [persons.isSuccess, selectedId, person, refetchPersons]);

  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  const sections = useMemo(
    () => buildOfferingSections(groups.data ?? [], offerings.data ?? []),
    [groups.data, offerings.data],
  );

  async function undo(booking: BookingRecord) {
    // A double tap on "Rückgängig" must not send a second DELETE.
    if (!undoGuard.tryBegin(booking.id)) return;
    toast.dismiss('booking');
    try {
      await deleteBooking.mutateAsync(booking);
      toast.success('Buchung rückgängig gemacht', { id: UNDO_TOAST_ID });
    } catch (error) {
      if (error instanceof ClientResponseError && error.status === 404) {
        // already gone (cancelled on another device) – the goal is reached
        toast.info('Die Buchung war bereits storniert.', { id: UNDO_TOAST_ID });
        return;
      }
      undoGuard.release(booking.id);
      vibrate(VIBRATE_ERROR);
      toast.error(errorMessage(error, 'bookings'), { id: UNDO_TOAST_ID });
    }
  }

  async function book(offering: OfferingRecord, target: PersonRecord) {
    window.clearTimeout(flashTimer.current);
    try {
      const booking = await createBooking.mutateAsync({ person: target, offering });
      vibrate(VIBRATE_SUCCESS);
      setNow(new Date());
      setFlash({ offeringId: offering.id, key: Date.now() });
      flashTimer.current = window.setTimeout(() => setFlash(null), 900);
      // Keep the screen calm at the bar: only the latest booking toast stays.
      for (const t of toast.getToasts()) if (t.id !== 'booking') toast.dismiss(t.id);
      toast.success(`${offering.name} gebucht · ${formatCents(booking.unitPriceCents)}`, {
        id: 'booking',
        description: `${target.number}${target.name ? ` · ${target.name}` : ''}`,
        duration: 6000,
        action: { label: 'Rückgängig', onClick: () => void undo(booking) },
      });
    } catch (error) {
      vibrate(VIBRATE_ERROR);
      toast.error(errorMessage(error, 'bookings'), { id: 'booking' });
    }
  }

  function handleTile(offering: OfferingRecord) {
    if (!person) {
      setPicker({ mode: 'search', pendingOffering: offering });
      return;
    }
    void book(offering, person);
  }

  function handlePicked(picked: PersonRecord) {
    const pending = picker?.pendingOffering ?? null;
    setSelectedPersonId(picked.id);
    setPicker(null);
    if (pending) void book(pending, picked);
  }

  const loading = groups.isPending || offerings.isPending;
  const loadError = groups.error ?? offerings.error;

  return (
    <div className="pt-2">
      <h1 className="sr-only">Buchen</h1>
      <StickyTop sections={sections}>
        <PersonCard
          person={person}
          totalCents={totals.data?.totalCents ?? null}
          bookingCount={totals.data?.count ?? null}
          onPick={() => setPicker({ mode: 'search', pendingOffering: null })}
          onScan={() => setPicker({ mode: 'scan', pendingOffering: null })}
          onClear={() => setSelectedPersonId(null)}
        />
      </StickyTop>

      <div className="mt-3">
        {loading ? (
          <PageSpinner />
        ) : loadError ? (
          <QueryError
            error={loadError}
            onRetry={() => {
              void groups.refetch();
              void offerings.refetch();
            }}
          />
        ) : sections.length === 0 ? (
          <EmptyState icon={<Beer className="size-7" aria-hidden />} title="Noch keine Angebote">
            {isAdmin(user) ? (
              <ButtonLink to="/verwaltung/angebote" variant="primary" className="mt-3">
                Angebote anlegen
              </ButtonLink>
            ) : (
              'Ein Admin muss zuerst Angebote anlegen.'
            )}
          </EmptyState>
        ) : (
          <OfferingGrid sections={sections} flash={flash} onBook={handleTile} />
        )}
      </div>

      {person ? (
        <section className="mt-8" aria-labelledby="recent-heading" data-testid="recent-bookings">
          <div className="mb-2 flex items-center justify-between gap-2 px-1">
            <h2 id="recent-heading" className="text-sm font-bold tracking-wide text-muted uppercase">
              Letzte Buchungen · {person.number}
            </h2>
            <Link
              to={`/buchungen?person=${encodeURIComponent(person.id)}`}
              className="-my-2 inline-flex min-h-12 items-center gap-1 px-1 text-sm font-semibold text-primary"
            >
              Alle <ChevronRight className="size-4" aria-hidden />
            </Link>
          </div>
          {recent.isError ? (
            <QueryError error={recent.error} onRetry={() => void recent.refetch()} />
          ) : recent.data && recent.data.length > 0 ? (
            <ul className="divide-y divide-line overflow-hidden rounded-3xl border border-line bg-surface">
              {recent.data.map((booking) => (
                <BookingItem
                  key={booking.id}
                  booking={booking}
                  now={now}
                  canCancel={canCancelBooking(user, booking)}
                  onCancel={setCancelTarget}
                />
              ))}
            </ul>
          ) : recent.isPending ? null : (
            <p className="rounded-3xl border border-dashed border-line-strong px-4 py-6 text-center text-muted">
              Noch keine Buchungen.
            </p>
          )}
        </section>
      ) : null}

      <PersonPicker
        open={picker !== null}
        initialMode={picker?.mode}
        pendingOfferingName={picker?.pendingOffering?.name}
        selectedPersonId={person?.id}
        onClose={() => setPicker(null)}
        onSelect={handlePicked}
      />
      <CancelBookingDialog booking={cancelTarget} onClose={() => setCancelTarget(null)} />
    </div>
  );
}

/** Sticky header with the person card and (for several groups) a chip bar. */
function StickyTop({ sections, children }: { sections: OfferingSection[]; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(null);
  const showChips = sections.length > 1;

  // Scroll spy: highlight the group whose section is at the top.
  useEffect(() => {
    if (!showChips) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const offset = (ref.current?.getBoundingClientRect().height ?? 0) + 24;
      let current: string | null = null;
      for (const section of sections) {
        const el = document.getElementById(`gruppe-${section.group.id}`);
        if (el && el.getBoundingClientRect().top <= offset) current = section.group.id;
      }
      setActive(current ?? sections[0]?.group.id ?? null);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [sections, showChips]);

  function jumpTo(groupId: string) {
    const el = document.getElementById(`gruppe-${groupId}`);
    if (!el) return;
    const offset = (ref.current?.getBoundingClientRect().height ?? 0) + 8;
    const top = el.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top, behavior: 'smooth' });
  }

  return (
    <div
      ref={ref}
      className="sticky top-0 z-20 -mx-4 bg-canvas/90 px-4 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2 backdrop-blur-md lg:-mx-8 lg:px-8"
    >
      {children}
      {showChips ? (
        <nav aria-label="Gruppen" className="-mx-4 mt-1 lg:-mx-8">
          <ul className="scrollbar-none flex gap-1 overflow-x-auto px-3 lg:px-7">
            {sections.map(({ group }) => {
              const isActive = active === group.id;
              return (
                <li key={group.id} className="shrink-0">
                  <button
                    type="button"
                    onClick={() => jumpTo(group.id)}
                    aria-current={isActive || undefined}
                    data-testid="group-chip"
                    className="flex h-12 items-center px-1"
                  >
                    <span
                      className={cn(
                        'rounded-full border px-4 py-1.5 text-sm font-semibold whitespace-nowrap transition-colors',
                        isActive
                          ? 'border-primary bg-primary text-on-primary'
                          : 'border-line bg-surface text-fg hover:bg-surface-2',
                      )}
                    >
                      {group.name}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}
    </div>
  );
}
