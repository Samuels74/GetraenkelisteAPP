import { ScanLine, Search, X } from 'lucide-react';
import type { Ref } from 'react';
import { Button, IconButton } from '../../components/ui/Button';
import { cn } from '../../components/ui/cn';
import { NumberBadge } from '../../components/ui/Feedback';
import { Spinner } from '../../components/ui/Spinner';
import { formatCents, formatCount } from '../../lib/money';
import { personLabel } from '../../lib/search';
import type { PersonRecord } from '../../lib/types';

interface PersonCardProps {
  person: PersonRecord | null;
  /** A person is selected (remembered) but not loaded yet – never shown as "Keine Person ausgewählt". */
  loading?: boolean;
  totalCents: number | null;
  bookingCount: number | null;
  onPick: () => void;
  onScan: () => void;
  onClear: () => void;
  /** The card's main button ("Person wählen" / "Person wechseln"): focus returns there after picking or clearing. */
  mainButtonRef?: Ref<HTMLButtonElement>;
}

/** Sticky "current person" card on the booking screen. */
export function PersonCard({
  person,
  loading = false,
  totalCents,
  bookingCount,
  onPick,
  onScan,
  onClear,
  mainButtonRef,
}: PersonCardProps) {
  if (!person) {
    return (
      <section
        aria-label="Ausgewählte Person"
        aria-busy={loading || undefined}
        data-testid="current-person"
        data-state={loading ? 'loading' : 'empty'}
        className="rounded-3xl border-2 border-dashed border-line-strong bg-surface p-2.5 shadow-sm"
      >
        <p
          className={cn('flex items-center gap-2 px-1 pb-2.5 text-sm font-medium text-muted', !loading && 'short:sr-only')}
          role="status"
        >
          {loading ? (
            <>
              <Spinner className="size-4" />
              Person wird geladen …
            </>
          ) : (
            // (landscape phones: the buttons say it – the line would cost tile space)
            'Keine Person ausgewählt'
          )}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Button
            ref={mainButtonRef}
            variant="primary"
            className="gap-1.5 px-2 text-[15px] whitespace-nowrap"
            icon={<Search className="size-5 max-[379px]:hidden" aria-hidden />}
            onClick={onPick}
          >
            Person wählen
          </Button>
          <Button
            variant="soft"
            className="gap-1.5 px-2 text-[15px] whitespace-nowrap"
            icon={<ScanLine className="size-5 max-[379px]:hidden" aria-hidden />}
            onClick={onScan}
          >
            QR scannen
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="Ausgewählte Person"
      data-testid="current-person"
      data-state="selected"
      data-person-id={person.id}
      data-person-number={person.number}
      className="flex items-stretch gap-1 rounded-3xl border border-line bg-surface p-1.5 shadow-sm"
    >
      <button
        ref={mainButtonRef}
        type="button"
        onClick={onPick}
        aria-label={`Person wechseln – ausgewählt: ${personLabel(person)}`}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl p-1.5 text-left transition-colors hover:bg-surface-2 active:bg-surface-3"
      >
        {/* (long numbers wrap instead of pushing the total out of the card) */}
        <NumberBadge number={person.number} size="lg" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-lg leading-tight font-semibold" data-testid="current-person-name">
            {person.name || 'Ohne Namen'}
          </span>
          {person.nickname ? (
            <span className="block truncate text-sm text-muted short:hidden">„{person.nickname}“</span>
          ) : null}
          <span className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
            <span className="text-xs font-medium tracking-wide text-muted uppercase">Gesamt</span>
            <span className="text-lg font-bold tabular-nums" data-testid="current-person-total">
              {totalCents === null ? '…' : formatCents(totalCents)}
            </span>
            {bookingCount !== null ? (
              <span className="truncate text-xs text-muted" data-testid="current-person-count">
                · {formatCount(bookingCount)} {bookingCount === 1 ? 'Buchung' : 'Buchungen'}
              </span>
            ) : null}
          </span>
        </span>
      </button>
      {/* side by side on landscape phones: the stacked buttons set the card's height */}
      <div className="flex flex-col justify-between short:flex-row short:items-center">
        <IconButton label="QR-Code scannen" onClick={onScan}>
          <ScanLine className="size-6" aria-hidden />
        </IconButton>
        <IconButton label="Auswahl aufheben" onClick={onClear} data-testid="clear-person">
          <X className="size-6" aria-hidden />
        </IconButton>
      </div>
    </section>
  );
}
