import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { useDeleteBooking } from '../../api/mutations';
import { ConfirmDialog } from '../../components/ui/Dialog';
import { formatDateTime, parsePbDate } from '../../lib/dates';
import { errorMessage, isPocketBaseNotFound } from '../../lib/errors';
import { formatCents } from '../../lib/money';
import type { BookingRecord } from '../../lib/types';
import { vibrate, VIBRATE_SUCCESS } from '../../lib/vibrate';

/**
 * Confirms and sends a cancellation. While the request is on its way the
 * dialog shows it and cannot be closed (ConfirmDialog): a sent request cannot
 * be recalled, so "Abbrechen" would only hide that the booking is cancelled
 * anyway. The outcome closes the dialog ("Buchung storniert", "bereits
 * storniert") or shows the error in it.
 */
export function CancelBookingDialog({ booking, onClose }: { booking: BookingRecord | null; onClose: () => void }) {
  const deleteBooking = useDeleteBooking();
  const [error, setError] = useState<string | null>(null);
  // The attempt the dialog still waits for (null: closed or nothing sent).
  const attempt = useRef<object | null>(null);

  function close() {
    attempt.current = null;
    setError(null);
    onClose();
  }

  async function confirm() {
    if (!booking) return;
    const current = {};
    attempt.current = current;
    setError(null);
    // Closed meanwhile – possible only after an unusually long wait
    // (CONFIRM_LOCKED_MAX_MS): the outcome is still reported, as a toast – it
    // may be another booking's dialog that is open by now.
    const open = () => attempt.current === current;
    try {
      await deleteBooking.mutateAsync(booking);
      if (open()) vibrate(VIBRATE_SUCCESS);
      toast.success('Buchung storniert');
      if (open()) close();
    } catch (err) {
      if (isPocketBaseNotFound(err)) {
        // cancelled meanwhile (another device / undo) – nothing left to do
        toast.info('Die Buchung war bereits storniert.');
        if (open()) close();
        return;
      }
      if (open()) setError(errorMessage(err, 'bookings'));
      else toast.error(errorMessage(err, 'bookings'));
    }
  }

  const person = booking?.expand?.person;
  const offering = booking?.expand?.offering;
  return (
    <ConfirmDialog
      open={Boolean(booking)}
      title="Buchung stornieren?"
      confirmLabel="Stornieren"
      error={error}
      onConfirm={confirm}
      onClose={close}
      testId="cancel-booking-dialog"
      message={
        booking ? (
          <p>
            <strong>{offering?.name ?? 'Buchung'}</strong> ({formatCents(booking.quantity * booking.unitPriceCents)})
            {person ? (
              <>
                {' '}
                für <strong>{person.number}</strong>
                {person.name ? ` ${person.name}` : ''}
              </>
            ) : null}{' '}
            vom {formatDateTime(parsePbDate(booking.created))} wird gelöscht.
          </p>
        ) : null
      }
    />
  );
}
