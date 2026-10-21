import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClientResponseError } from 'pocketbase';
import { useState } from 'react';
import { toast } from 'sonner';
import { CONFIRM_LOCKED_MAX_MS } from '../../components/ui/Dialog';
import { pb } from '../../lib/pb';
import type { BookingRecord } from '../../lib/types';
import { CancelBookingDialog } from './CancelBookingDialog';

const booking: BookingRecord = {
  collectionId: 'c',
  collectionName: 'bookings',
  id: 'b1',
  created: '2026-10-20 18:00:00.000Z',
  updated: '2026-10-20 18:00:00.000Z',
  person: 'p1',
  offering: 'o1',
  quantity: 1,
  unitPriceCents: 350,
  createdBy: 'u1',
};

function Screen() {
  const [target, setTarget] = useState<BookingRecord | null>(booking);
  return <CancelBookingDialog booking={target} onClose={() => setTarget(null)} />;
}

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Screen />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('CancelBookingDialog', () => {
  it('cancels and says so', async () => {
    const remove = vi.spyOn(pb.collection('bookings'), 'delete').mockResolvedValue(true);
    const success = vi.spyOn(toast, 'success');
    renderDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Stornieren' }));
    expect(remove).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(success).toHaveBeenCalledWith('Buchung storniert'));
    expect(screen.queryByTestId('cancel-booking-dialog')).not.toBeInTheDocument();
  });

  it('sends one request for a double click', async () => {
    const remove = vi.spyOn(pb.collection('bookings'), 'delete').mockReturnValue(new Promise(() => {}));
    renderDialog();
    const confirm = screen.getByRole('button', { name: 'Stornieren' });
    // both clicks before React re-renders the busy button
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await vi.waitFor(() => expect(remove).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(remove).toHaveBeenCalledOnce();
  });

  it('while the cancellation is on its way it cannot be called off – the answer closes the dialog (L9)', async () => {
    let finish = (_ok: boolean) => {};
    vi.spyOn(pb.collection('bookings'), 'delete').mockReturnValue(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    const success = vi.spyOn(toast, 'success');
    renderDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Stornieren' }));
    const dialog = screen.getByTestId('cancel-booking-dialog');
    // the request was sent and cannot be recalled: "Abbrechen" would only hide the outcome
    expect(screen.getByRole('button', { name: 'Abbrechen' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Schließen' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stornieren' })).toHaveAttribute('aria-busy', 'true');
    fireEvent(dialog, new Event('cancel', { cancelable: true })); // Escape / back gesture
    fireEvent.click(dialog); // backdrop
    expect(screen.getByTestId('cancel-booking-dialog')).toBeInTheDocument();

    await act(async () => finish(true));
    expect(success).toHaveBeenCalledWith('Buchung storniert');
    expect(screen.queryByTestId('cancel-booking-dialog')).not.toBeInTheDocument();
  });

  it('a failure keeps the dialog open with the message – then it can be closed again', async () => {
    vi.spyOn(pb.collection('bookings'), 'delete').mockRejectedValue(new ClientResponseError({ status: 0, response: {} }));
    renderDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Stornieren' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Keine Verbindung zum Server');
    expect(screen.getByRole('button', { name: 'Abbrechen' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(screen.queryByTestId('cancel-booking-dialog')).not.toBeInTheDocument();
  });

  it('an answer that takes unusually long: closing is possible again, and the outcome still comes as a toast', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let finish = (_ok: boolean) => {};
      vi.spyOn(pb.collection('bookings'), 'delete').mockReturnValue(
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
      );
      const success = vi.spyOn(toast, 'success');
      renderDialog();
      fireEvent.click(screen.getByRole('button', { name: 'Stornieren' }));
      await act(() => vi.advanceTimersByTimeAsync(CONFIRM_LOCKED_MAX_MS - 1));
      expect(screen.getByRole('button', { name: 'Abbrechen' })).toBeDisabled();
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(screen.getByRole('button', { name: 'Abbrechen' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
      expect(screen.queryByTestId('cancel-booking-dialog')).not.toBeInTheDocument();

      await act(async () => finish(true));
      expect(success).toHaveBeenCalledWith('Buchung storniert');
    } finally {
      vi.useRealTimers();
    }
  });
});
