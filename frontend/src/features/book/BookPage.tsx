/**
 * Buchen – the core flow: select person → tap tile → booked (1×).
 */
import { Beer, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { useCreateBooking, useDeleteBooking } from '../../api/mutations';
import {
  personTotalsQuery,
  useGroups,
  useOfferings,
  usePersons,
  useRecentBookings,
  useTotals,
} from '../../api/queries';
import { isAdmin, useCurrentUser } from '../../auth/session';
import { ConnectionHint } from '../../components/ConnectionHint';
import { ButtonLink } from '../../components/ui/Button';
import { cn } from '../../components/ui/cn';
import { EmptyState, QueryError } from '../../components/ui/Feedback';
import { PageSpinner } from '../../components/ui/Spinner';
import { errorMessage, isPocketBaseNotFound } from '../../lib/errors';
import { formatCents } from '../../lib/money';
import { createOnceGuard } from '../../lib/onceGuard';
import { canCancelBooking } from '../../lib/permissions';
import { useDocumentTitle } from '../../lib/useDocumentTitle';
import { useOnline } from '../../lib/useOnline';
import { useToday } from '../../lib/useToday';
import type { BookingRecord, OfferingRecord, PersonRecord } from '../../lib/types';
import { vibrate, VIBRATE_ERROR, VIBRATE_SUCCESS } from '../../lib/vibrate';
import { BookingItem } from '../bookings/BookingItem';
import { CancelBookingDialog } from '../bookings/CancelBookingDialog';
import { PersonPicker } from '../persons/PersonPicker';
import { OfferingGrid } from './OfferingGrid';
import { buildOfferingSections, type OfferingSection } from './offerings';
import { PersonCard } from './PersonCard';
import {
  isNotFound,
  isPersonConfirmedGone,
  setSelectedPersonId,
  useRememberedPerson,
  useSelectedPersonId,
} from './selectedPerson';

/** One undo per booking (module level: survives re-renders and remounts). */
const undoGuard = createOnceGuard();
/** The undo result gets its own toast; reusing 'booking' made it vanish immediately. */
const UNDO_TOAST_ID = 'booking-undo';

interface PickerState {
  mode: 'search' | 'scan';
  pendingOffering: OfferingRecord | null;
}

/** Adds `delta` to the count of `id` (entries at 0 are removed). */
function addCount(counts: ReadonlyMap<string, number>, id: string, delta: number): ReadonlyMap<string, number> {
  const next = new Map(counts);
  const count = (next.get(id) ?? 0) + delta;
  if (count > 0) next.set(id, count);
  else next.delete(id);
  return next;
}

export function BookPage() {
  useDocumentTitle('Buchen');
  const user = useCurrentUser();
  const online = useOnline();
  const persons = usePersons();
  const groups = useGroups();
  const offerings = useOfferings();
  const selectedId = useSelectedPersonId();
  const listed = useMemo(
    () => (selectedId ? (persons.data?.find((p) => p.id === selectedId) ?? null) : null),
    [persons.data, selectedId],
  );
  // Until the person list is there (app start: seconds on a slow network) the
  // remembered person is loaded on its own, so the card shows it right away.
  const remembered = useRememberedPerson(selectedId, !persons.data);
  const person = listed ?? (persons.data ? null : (remembered.data ?? null));
  // Selected but not resolved yet: the card says "Person wird geladen …" (never
  // "Keine Person ausgewählt"), and the tiles wait – a tap must neither open
  // the picker nor book for anyone else.
  const personLoading = Boolean(selectedId) && !person;
  // the card shows count and sum only (parts=summary – shared with the person detail)
  const totals = useTotals(personTotalsQuery(person?.id ?? ''), Boolean(person), { parts: ['summary'] });
  const recent = useRecentBookings(person?.id, 8);
  const createBooking = useCreateBooking();
  const deleteBooking = useDeleteBooking();
  const now = useToday();

  const [picker, setPicker] = useState<PickerState | null>(null);
  const [flash, setFlash] = useState<{ offeringId: string; key: number } | null>(null);
  const [inFlight, setInFlight] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [cancelTarget, setCancelTarget] = useState<BookingRecord | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);

  // After picking or clearing, the focus goes to the card's main button – the
  // button it was on ("Person wählen" / "Person wechseln") is gone by then.
  const cardButton = useRef<HTMLButtonElement>(null);
  const [focusCard, setFocusCard] = useState(0);
  useEffect(() => {
    if (focusCard > 0) cardButton.current?.focus({ preventScroll: true });
  }, [focusCard]);

  // The selected person is missing – from the loaded list, or its own request
  // answered 404. It is dropped only when confirmed deleted with a valid
  // session (see isPersonConfirmedGone); otherwise the list is reloaded.
  const listLoaded = persons.isSuccess;
  const missing = Boolean(selectedId) && !listed && (listLoaded || isNotFound(remembered.error));
  const refetchPersons = persons.refetch;
  useEffect(() => {
    if (!missing || !selectedId) return;
    let cancelled = false;
    void isPersonConfirmedGone(selectedId).then((gone) => {
      if (cancelled) return;
      if (gone) setSelectedPersonId(null);
      else if (listLoaded) void refetchPersons();
    });
    return () => {
      cancelled = true;
    };
  }, [missing, selectedId, listLoaded, refetchPersons]);

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
      if (isPocketBaseNotFound(error)) {
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
    setInFlight((counts) => addCount(counts, offering.id, 1));
    try {
      const booking = await createBooking.mutateAsync({ person: target, offering });
      vibrate(VIBRATE_SUCCESS);
      window.clearTimeout(flashTimer.current);
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
    } finally {
      setInFlight((counts) => addCount(counts, offering.id, -1));
    }
  }

  function handleTile(offering: OfferingRecord) {
    if (personLoading) return; // (the tiles are disabled meanwhile)
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
    setFocusCard((n) => n + 1);
    if (pending) void book(pending, picked);
  }

  const loading = groups.isPending || offerings.isPending;
  // Errors replace the tiles only when there are none: a failed background
  // refresh (e.g. offline – requests fail at once) keeps the loaded ones (and
  // ConnectionHint says they may be outdated); "Noch keine Angebote" only
  // when that is the server's answer.
  const loadError = (groups.data?.length ? null : groups.error) ?? (offerings.data?.length ? null : offerings.error);

  return (
    <div className="pt-2">
      <h1 className="sr-only">Buchen</h1>
      <StickyTop sections={sections}>
        <PersonCard
          person={person}
          loading={personLoading}
          totalCents={totals.data?.totalCents ?? null}
          bookingCount={totals.data?.count ?? null}
          onPick={() => setPicker({ mode: 'search', pendingOffering: null })}
          onScan={() => setPicker({ mode: 'scan', pendingOffering: null })}
          onClear={() => {
            setSelectedPersonId(null);
            setFocusCard((n) => n + 1);
          }}
          mainButtonRef={cardButton}
        />
        {/* the card's numbers and the list below may be outdated (server unreachable) */}
        <ConnectionHint className="mt-2" />
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
          // Offline every booking would fail: the tiles wait (the banner at the top says why).
          <OfferingGrid
            sections={sections}
            flash={flash}
            pending={inFlight}
            disabled={!online || personLoading}
            onBook={handleTile}
          />
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
          {/* (a failed refresh of an empty list: "Noch keine Buchungen." may be wrong) */}
          {recent.isError && !recent.data?.length ? (
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

/** Margin between the sticky header and a group heading / the chip bar's edges. */
const CHIP_SCROLL_MARGIN = 12;

/**
 * Sticky header with the person card and (for several groups) a chip bar.
 * It sticks below the status bar and the offline banner (top-app); the
 * AppShell's TopBar covers the area above it.
 */
function StickyTop({ sections, children }: { sections: OfferingSection[]; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const chipBar = useRef<HTMLUListElement>(null);
  const [active, setActive] = useState<string | null>(null);
  // A tapped chip stays active until the user scrolls by hand: the last
  // groups often cannot scroll up to the top, so the scroll spy alone would
  // highlight an earlier group.
  const pinned = useRef<string | null>(null);
  const showChips = sections.length > 1;

  // Scroll spy: highlight the group whose section is at the top – at the end
  // of the page the last group (it may be too short to ever reach the top).
  useEffect(() => {
    if (!showChips) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      if (pinned.current) {
        setActive(pinned.current);
        return;
      }
      const offset = (ref.current?.getBoundingClientRect().height ?? 0) + 24;
      let current: string | null = null;
      for (const section of sections) {
        const el = document.getElementById(`gruppe-${section.group.id}`);
        if (el && el.getBoundingClientRect().top <= offset) current = section.group.id;
      }
      const root = document.documentElement;
      const atEnd = window.scrollY > 0 && window.scrollY + window.innerHeight >= root.scrollHeight - 2;
      if (atEnd) current = sections.at(-1)?.group.id ?? current;
      setActive(current ?? sections[0]?.group.id ?? null);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    const unpin = () => {
      pinned.current = null;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    for (const type of ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const) {
      window.addEventListener(type, unpin, { passive: true });
    }
    onScroll();
    return () => {
      window.removeEventListener('scroll', onScroll);
      for (const type of ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const) {
        window.removeEventListener(type, unpin);
      }
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [sections, showChips]);

  // Keep the active chip visible in the chip bar (it scrolls sideways only).
  useEffect(() => {
    const bar = chipBar.current;
    const chip = bar?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!bar || !chip || typeof bar.scrollBy !== 'function') return;
    const barBox = bar.getBoundingClientRect();
    const chipBox = chip.getBoundingClientRect();
    if (chipBox.left < barBox.left) {
      bar.scrollBy({ left: chipBox.left - barBox.left - CHIP_SCROLL_MARGIN, behavior: 'smooth' });
    } else if (chipBox.right > barBox.right) {
      bar.scrollBy({ left: chipBox.right - barBox.right + CHIP_SCROLL_MARGIN, behavior: 'smooth' });
    }
  }, [active]);

  function jumpTo(groupId: string) {
    const el = document.getElementById(`gruppe-${groupId}`);
    if (!el) return;
    pinned.current = groupId;
    setActive(groupId);
    const offset = (ref.current?.getBoundingClientRect().height ?? 0) + 8;
    const top = el.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top, behavior: 'smooth' });
  }

  return (
    <div
      ref={ref}
      className="sticky top-app z-20 -mx-4 bg-canvas/90 px-4 pt-2 pb-2 backdrop-blur-md lg:-mx-8 lg:px-8"
    >
      {children}
      {showChips ? (
        <nav aria-label="Gruppen" className="-mx-4 mt-1 lg:-mx-8">
          <ul ref={chipBar} className="scrollbar-none flex gap-1 overflow-x-auto px-3 lg:px-7">
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
