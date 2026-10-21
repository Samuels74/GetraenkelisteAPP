import { Check } from 'lucide-react';
import { Spinner } from '../../components/ui/Spinner';
import { cn } from '../../components/ui/cn';
import { formatCents } from '../../lib/money';
import type { OfferingRecord } from '../../lib/types';
import type { OfferingSection } from './offerings';

interface OfferingTileProps {
  offering: OfferingRecord;
  flashKey: number | null;
  /**
   * A booking of this tile is on its way: a spinner shows the tap arrived (on
   * a slow network nothing happened for a moment). The tile stays tappable –
   * booking the same drink twice in a row is normal at a bar.
   */
  pending?: boolean;
  /** No booking possible right now (offline, the selected person is still loading). */
  disabled?: boolean;
  onBook: (offering: OfferingRecord) => void;
}

export function OfferingTile({ offering, flashKey, pending = false, disabled = false, onBook }: OfferingTileProps) {
  const price = formatCents(offering.priceCents);
  return (
    <button
      type="button"
      data-testid="offering-tile"
      data-offering-id={offering.id}
      data-offering-name={offering.name}
      aria-label={`${offering.name}, ${price}`}
      aria-busy={pending || undefined}
      disabled={disabled}
      onClick={() => onBook(offering)}
      className={cn(
        'relative flex min-h-26 flex-col justify-between gap-2 rounded-3xl border border-line bg-surface p-4 text-left shadow-sm',
        'transition-[transform,background-color,border-color,opacity] duration-100 select-none',
        'enabled:hover:border-primary/50 enabled:active:scale-[0.97] enabled:active:border-primary enabled:active:bg-primary-soft',
        'disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none',
      )}
    >
      <span className="text-[17px] leading-snug font-semibold break-words hyphens-auto min-[380px]:text-lg">
        {offering.name}
      </span>
      <span
        className={cn(
          'text-base font-semibold tabular-nums',
          offering.priceCents < 0 ? 'text-success' : 'text-primary',
        )}
      >
        {price}
      </span>
      {flashKey !== null ? (
        <span
          key={flashKey}
          aria-hidden
          className="absolute top-2.5 right-2.5 flex size-8 animate-pop items-center justify-center rounded-full bg-success text-white shadow"
        >
          <Check className="size-5" strokeWidth={3} />
        </span>
      ) : pending ? (
        <span aria-hidden className="absolute top-2.5 right-2.5 flex size-8 items-center justify-center text-primary">
          <Spinner className="size-5" />
        </span>
      ) : null}
    </button>
  );
}

interface OfferingGridProps {
  sections: OfferingSection[];
  flash: { offeringId: string; key: number } | null;
  /** Offerings with a booking on its way (id → number of requests). */
  pending?: ReadonlyMap<string, number>;
  disabled?: boolean;
  onBook: (offering: OfferingRecord) => void;
}

export function OfferingGrid({ sections, flash, pending, disabled = false, onBook }: OfferingGridProps) {
  const showHeadings = sections.length > 1;
  return (
    <div className="space-y-6">
      {sections.map(({ group, offerings }) => (
        <section
          key={group.id}
          id={`gruppe-${group.id}`}
          data-group-id={group.id}
          aria-labelledby={`gruppe-${group.id}-titel`}
          data-testid="offering-group"
        >
          <h2
            id={`gruppe-${group.id}-titel`}
            className={cn('mb-3 px-1 text-sm font-bold tracking-wide text-muted uppercase', !showHeadings && 'sr-only')}
          >
            {group.name}
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {offerings.map((offering) => (
              <OfferingTile
                key={offering.id}
                offering={offering}
                flashKey={flash?.offeringId === offering.id ? flash.key : null}
                pending={(pending?.get(offering.id) ?? 0) > 0}
                disabled={disabled}
                onBook={onBook}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
