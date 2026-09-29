import { Check } from 'lucide-react';
import { formatCents } from '../../lib/money';
import type { OfferingRecord } from '../../lib/types';
import type { OfferingSection } from './offerings';
import { cn } from '../../components/ui/cn';

interface OfferingTileProps {
  offering: OfferingRecord;
  flashKey: number | null;
  onBook: (offering: OfferingRecord) => void;
}

export function OfferingTile({ offering, flashKey, onBook }: OfferingTileProps) {
  const price = formatCents(offering.priceCents);
  return (
    <button
      type="button"
      data-testid="offering-tile"
      data-offering-id={offering.id}
      data-offering-name={offering.name}
      aria-label={`${offering.name}, ${price}`}
      onClick={() => onBook(offering)}
      className={cn(
        'relative flex min-h-26 flex-col justify-between gap-2 rounded-3xl border border-line bg-surface p-4 text-left shadow-sm',
        'transition-[transform,background-color,border-color] duration-100 select-none',
        'hover:border-primary/50 active:scale-[0.97] active:border-primary active:bg-primary-soft',
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
      ) : null}
    </button>
  );
}

interface OfferingGridProps {
  sections: OfferingSection[];
  flash: { offeringId: string; key: number } | null;
  onBook: (offering: OfferingRecord) => void;
}

export function OfferingGrid({ sections, flash, onBook }: OfferingGridProps) {
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
                onBook={onBook}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
