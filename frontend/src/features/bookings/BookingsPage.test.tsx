import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClientResponseError, type ListResult } from 'pocketbase';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { keysetFilter } from '../../api/keyset';
import { BOOKINGS_PAGE_SIZE, queryKeys, type BookingListData } from '../../api/queries';
import { pb } from '../../lib/pb';
import type { BookingRecord } from '../../lib/types';
import { BookingsPage } from './BookingsPage';
import { parseFilterParams, toBookingQuery } from './filters';

const booking = (id: string, created: string): BookingRecord => ({
  id,
  collectionId: 'c',
  collectionName: 'bookings',
  created,
  updated: created,
  person: 'p1',
  offering: 'o1',
  quantity: 1,
  unitPriceCents: 250,
  createdBy: 'u1',
});

/** The default filter (Alle, list view) of a visitor without "nur meine". */
const query = toBookingQuery(parseFilterParams(new URLSearchParams()), null);

function renderPage(list: BookingListData, summary = { count: 1, quantity: 1, totalCents: 250 }) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(['persons'], []);
  client.setQueryData(queryKeys.totalsFor(query, ['summary']), summary);
  client.setQueryData(queryKeys.bookingList(query), list);
  const router = createMemoryRouter([{ path: '/buchungen', element: <BookingsPage /> }], {
    initialEntries: ['/buchungen'],
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return client;
}

/** No usable answer: the network, or a proxy's page while the app container restarts. */
const unreachable = () => new ClientResponseError({ status: 502, data: {} });

afterEach(() => vi.restoreAllMocks());

describe('BookingsPage list', () => {
  it('keeps "Weitere laden" when every loaded booking is gone but older ones exist', async () => {
    // e.g. all shown bookings were cancelled on other devices
    const cursor = { created: '2026-10-20 17:00:02.000Z', id: 'b2' };
    renderPage({ pages: [{ items: [], next: cursor, base: '' }], pageParams: [null] });
    expect(screen.queryByText('Keine Buchungen')).not.toBeInTheDocument();

    const older = booking('b1', '2026-10-20 17:00:01.000Z');
    const page: ListResult<BookingRecord> = { page: 1, perPage: BOOKINGS_PAGE_SIZE, totalItems: -1, totalPages: -1, items: [older] };
    const getList = vi.spyOn(pb.collection('bookings'), 'getList').mockResolvedValue(page);
    await userEvent.click(screen.getByRole('button', { name: 'Weitere laden' }));
    expect(await screen.findByTestId('booking-item')).toHaveAttribute('data-booking-id', 'b1');
    expect(getList.mock.calls[0]![2]).toMatchObject({ filter: keysetFilter('', cursor) });
  });

  it('says "Keine Buchungen" when there are no older bookings either', () => {
    renderPage({ pages: [{ items: [], next: null, base: '' }], pageParams: [null] });
    expect(screen.getByText('Keine Buchungen')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Weitere laden' })).not.toBeInTheDocument();
  });

  it('an empty list whose refresh failed shows the error with a retry – never a bare "Keine Buchungen" (L4)', async () => {
    const client = renderPage({ pages: [{ items: [], next: null, base: '' }], pageParams: [null] });
    vi.spyOn(pb, 'send').mockRejectedValue(unreachable());
    const getList = vi.spyOn(pb.collection('bookings'), 'getList').mockRejectedValue(unreachable());
    // e.g. a booking event arrived while the screen was hidden: summary and list are refetched – and fail
    await act(() => client.invalidateQueries());
    expect(await screen.findByText('Der Server ist gerade nicht erreichbar. Bitte versuche es gleich noch einmal.')).toBeInTheDocument();
    expect(screen.queryByText('Keine Buchungen')).not.toBeInTheDocument();
    // the kept summary says it may be outdated
    expect(screen.getByTestId('connection-hint')).toHaveTextContent('Anzeige evtl. nicht aktuell');
    expect(screen.getByTestId('bookings-count')).toHaveTextContent('1');

    const page: ListResult<BookingRecord> = {
      page: 1,
      perPage: BOOKINGS_PAGE_SIZE,
      totalItems: -1,
      totalPages: -1,
      items: [booking('b1', '2026-10-20 17:00:01.000Z')],
    };
    getList.mockResolvedValue(page);
    await userEvent.click(screen.getAllByRole('button', { name: 'Erneut versuchen' }).at(-1)!);
    expect(await screen.findByTestId('booking-item')).toHaveAttribute('data-booking-id', 'b1');
  });

  it('rows whose refresh failed stay, with the hint that they may be outdated (L5)', async () => {
    const client = renderPage({ pages: [{ items: [booking('b1', '2026-10-20 17:00:01.000Z')], next: null, base: '' }], pageParams: [null] });
    vi.spyOn(pb, 'send').mockRejectedValue(unreachable());
    vi.spyOn(pb.collection('bookings'), 'getList').mockRejectedValue(unreachable());
    await act(() => client.invalidateQueries());
    expect(await screen.findByTestId('connection-hint')).toHaveTextContent(
      'Verbindung zum Server unterbrochen – Anzeige evtl. nicht aktuell.',
    );
    expect(screen.getByTestId('booking-item')).toHaveAttribute('data-booking-id', 'b1');
    expect(screen.getByTestId('bookings-count')).toHaveTextContent('1');
  });
});

/** The page at `url` (other filters load through the spied API: no bookings). */
function renderAt(url: string, prefill?: (client: QueryClient) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(['persons'], []);
  prefill?.(client);
  vi.spyOn(pb, 'send').mockResolvedValue({ count: 0, quantity: 0, totalCents: 0, perPerson: [], perOffering: [] });
  const empty: ListResult<BookingRecord> = { page: 1, perPage: BOOKINGS_PAGE_SIZE, totalItems: -1, totalPages: -1, items: [] };
  vi.spyOn(pb.collection('bookings'), 'getList').mockResolvedValue(empty);
  const router = createMemoryRouter([{ path: '/buchungen', element: <BookingsPage /> }], { initialEntries: [url] });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { client, router };
}

describe('BookingsPage URL', () => {
  it('shows invalid parameters as the defaults – and the URL says so too', async () => {
    const { router } = renderAt('/buchungen?zeitraum=HEUTE&ansicht=bar&meine=ja');
    await vi.waitFor(() => expect(router.state.location.search).toBe(''));
    expect(router.state.historyAction).toBe('REPLACE');
    expect(screen.getByRole('radio', { name: 'Alle' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Liste' })).toBeChecked();
  });

  it('keeps a valid URL as it is', async () => {
    const { router } = renderAt('/buchungen?zeitraum=zeitraum&von=2026-10-01&bis=2026-10-10&meine=1&ansicht=angebote');
    await screen.findByTestId('bookings-summary');
    expect(router.state.location.search).toBe('?zeitraum=zeitraum&von=2026-10-01&bis=2026-10-10&meine=1&ansicht=angebote');
    expect(router.state.historyAction).toBe('POP');
  });

  it('says when "Von" is after "Bis"', async () => {
    renderAt('/buchungen?zeitraum=zeitraum&von=2026-10-10&bis=2026-10-01');
    expect(await screen.findByRole('alert')).toHaveTextContent('„Von“ liegt nach „Bis“');
    expect(screen.getByLabelText('Von')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Bis')).toHaveAttribute('aria-invalid', 'true');
  });

  it('a person row of "Pro Person" opens a new history entry: Back returns to the list of persons', async () => {
    const personsQuery = toBookingQuery(parseFilterParams(new URLSearchParams('ansicht=personen')), null);
    const { router } = renderAt('/buchungen?ansicht=personen', (client) =>
      client.setQueryData(queryKeys.totalsFor(personsQuery, ['summary', 'perPerson']), {
        count: 1,
        quantity: 1,
        totalCents: 250,
        perPerson: [{ personId: 'p1', number: '1', name: 'Eins', nickname: '', count: 1, quantity: 1, totalCents: 250 }],
      }),
    );
    await userEvent.click(await screen.findByTestId('totals-person-row'));
    expect(router.state.location.search).toBe('?person=p1');
    expect(router.state.historyAction).toBe('PUSH');

    await act(() => router.navigate(-1));
    expect(router.state.location.search).toBe('?ansicht=personen');
    expect(await screen.findByTestId('totals-person-row')).toBeInTheDocument();
  });
});
