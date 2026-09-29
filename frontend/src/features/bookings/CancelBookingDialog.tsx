import { ClientResponseError } from 'pocketbase';
import { useState } from 'react';
import { toast } from 'sonner';
import { useDeleteBooking } from '../../api/mutations';
import { ConfirmDialog } from '../../components/ui/Dialog';
import { formatDateTime, parsePbDate } from '../../lib/dates';
import { errorMessage } from '../../lib/errors';
import { formatCents } from '../../lib/money';
import type { BookingRecord } from '../../lib/types';
import { vibrate, VIBRATE_SUCCESS } from '../../lib/vibrate';

export function CancelBookingDialog({ booking, onClose }: { booking: BookingRecord | null; onClose: () => void }) {
  const deleteBooking = useDeleteBooking();
  const [error, setError] = useState<string | null>(null);

  function close() {
    setError(null);
    onClose();
  }

  async function confirm() {
    if (!booking) return;
    setError(null);
    try {
      await deleteBooking.mutateAsync(booking);
      vibrate(VIBRATE_SUCCESS);
      toast.success('Buchung storniert');
      close();
    } catch (err) {
      if (err instanceof ClientResponseError && err.status === 404) {
        // cancelled meanwhile (another device / undo) – nothing left to do
        toast.info('Die Buchung war bereits storniert.');
        close();
        return;
      }
      setError(errorMessage(err, 'bookings'));
    }
  }

  const person = booking?.expand?.person;
  const offering = booking?.expand?.offering;
  return (
    <ConfirmDialog
      open={Boolean(booking)}
      title="Buchung stornieren?"
      confirmLabel="Stornieren"
      loading={deleteBooking.isPending}
      error={error}
      onConfirm={() => void confirm()}
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
