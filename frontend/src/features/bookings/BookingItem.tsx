import { Trash } from 'lucide-react';
import { IconButton } from '../../components/ui/Button';
import { formatDate, formatTime, parsePbDate, startOfLocalDay } from '../../lib/dates';
import { formatCents } from '../../lib/money';
import type { BookingRecord } from '../../lib/types';

interface BookingItemProps {
  booking: BookingRecord;
  now: Date;
  showPerson?: boolean;
  canCancel: boolean;
  onCancel: (booking: BookingRecord) => void;
}

function bookingWhen(booking: BookingRecord, now: Date): string {
  const created = parsePbDate(booking.created);
  const sameDay = startOfLocalDay(created).getTime() === startOfLocalDay(now).getTime();
  return sameDay ? formatTime(created) : `${formatDate(created).slice(0, 6)} ${formatTime(created)}`;
}

export function BookingItem({ booking, now, showPerson = false, canCancel, onCancel }: BookingItemProps) {
  const person = booking.expand?.person;
  const offering = booking.expand?.offering;
  const user = booking.expand?.createdBy;
  const total = booking.quantity * booking.unitPriceCents;
  return (
    <li
      className="flex min-h-16 items-center gap-3 py-2 pr-1 pl-4"
      data-testid="booking-item"
      data-booking-id={booking.id}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-base font-semibold">
            {booking.quantity > 1 ? `${booking.quantity}× ` : ''}
            {offering?.name ?? 'Unbekanntes Angebot'}
          </span>
          <span className="shrink-0 text-base font-semibold tabular-nums">{formatCents(total)}</span>
        </div>
        <p className="truncate text-sm text-muted">
          <time dateTime={parsePbDate(booking.created).toISOString()} className="tabular-nums">
            {bookingWhen(booking, now)}
          </time>
          {showPerson && person ? (
            <>
              {' · '}
              <span className="font-medium text-fg">{person.number}</span>
              {person.name ? ` ${person.name}` : ''}
            </>
          ) : null}
          {user ? ` · von ${user.name || user.username}` : ''}
        </p>
      </div>
      {canCancel ? (
        <IconButton label="Buchung stornieren" onClick={() => onCancel(booking)} className="text-muted hover:text-danger">
          <Trash className="size-5" aria-hidden />
        </IconButton>
      ) : (
        <span className="size-12 shrink-0" aria-hidden />
      )}
    </li>
  );
}
