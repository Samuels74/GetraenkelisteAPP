import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClientResponseError, type ListResult } from 'pocketbase';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { queryKeys } from '../../api/queries';
import type * as SessionModule from '../../auth/session';
import { pb } from '../../lib/pb';
import type { BookingRecord, GroupRecord, OfferingRecord, PersonRecord, UserRecord } from '../../lib/types';
import { BookPage } from './BookPage';
import { SELECTED_PERSON_KEY } from './selectedPerson';

vi.mock('../../auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionModule>()),
  // the session is valid (isPersonConfirmedGone checks it before dropping a selection)
  refreshSession: vi.fn(() => Promise.resolve('valid' as const)),
}));

const base = { collectionId: 'c', created: '2026-10-20 18:00:00.000Z', updated: '2026-10-20 18:00:00.000Z' };
const user: UserRecord = {
  ...base,
  collectionName: 'users',
  id: 'u1',
  username: 'ute',
  name: 'Ute',
  role: 'user',
  disabled: false,
  mustChangePassword: false,
};
const group: GroupRecord = { ...base, collectionName: 'groups', id: 'g1', name: 'Getränke', sortOrder: 10 };
const bier: OfferingRecord = {
  ...base,
  collectionName: 'offerings',
  id: 'o1',
  name: 'Bier',
  group: 'g1',
  priceCents: 350,
  active: true,
  sortOrder: 10,
};
const seven: PersonRecord = { ...base, collectionName: 'persons', id: 'p7', number: '7', name: 'Sieben', nickname: '' };

const noBookings: ListResult<BookingRecord> = { page: 1, perPage: 8, totalItems: -1, totalPages: -1, items: [] };

/** A promise the test settles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderBookPage({ persons }: { persons?: PersonRecord[] } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(queryKeys.groups, [group]);
  client.setQueryData(queryKeys.offerings, [bier]);
  if (persons) client.setQueryData(queryKeys.persons, persons);
  const router = createMemoryRouter([{ path: '/', element: <BookPage /> }], { initialEntries: ['/'] });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return client;
}

const card = () => screen.getByTestId('current-person');
const tile = () => screen.getByTestId('offering-tile');

beforeEach(() => {
  pb.authStore.save('token', user);
  vi.spyOn(pb, 'send').mockResolvedValue({ count: 2, quantity: 2, totalCents: 700 });
  vi.spyOn(pb.collection('bookings'), 'getList').mockResolvedValue(noBookings);
});
afterEach(() => {
  vi.restoreAllMocks();
  pb.authStore.clear();
  onlineManager.setOnline(true);
});

describe('BookPage – the remembered person at app start', () => {
  it('loads the person on its own: "Person wird geladen …", never "Keine Person ausgewählt", tiles wait', async () => {
    localStorage.setItem(SELECTED_PERSON_KEY, 'p7');
    // the whole list takes long (≈420 KB with thousands of persons)
    vi.spyOn(pb.collection('persons'), 'getFullList').mockReturnValue(new Promise(() => {}));
    const one = deferred<PersonRecord>();
    const getOne = vi.spyOn(pb.collection('persons'), 'getOne').mockReturnValue(one.promise);
    renderBookPage();

    expect(card()).toHaveAttribute('data-state', 'loading');
    expect(card()).toHaveTextContent('Person wird geladen …');
    expect(screen.queryByText('Keine Person ausgewählt')).not.toBeInTheDocument();
    expect(await screen.findByTestId('offering-tile')).toBeDisabled();
    expect(getOne).toHaveBeenCalledWith('p7');

    act(() => one.resolve(seven));
    await waitFor(() => expect(card()).toHaveAttribute('data-state', 'selected'));
    expect(card()).toHaveAttribute('data-person-number', '7');
    expect(tile()).toBeEnabled();
    expect(await screen.findByTestId('current-person-total')).toHaveTextContent('7,00');
  });

  it('drops a remembered person that no longer exists (empty card)', async () => {
    localStorage.setItem(SELECTED_PERSON_KEY, 'gone');
    vi.spyOn(pb.collection('persons'), 'getFullList').mockReturnValue(new Promise(() => {}));
    vi.spyOn(pb.collection('persons'), 'getOne').mockRejectedValue(
      new ClientResponseError({ status: 404, response: { status: 404, message: 'x', data: {} } }),
    );
    renderBookPage();

    await waitFor(() => expect(card()).toHaveAttribute('data-state', 'empty'));
    expect(card()).toHaveTextContent('Keine Person ausgewählt');
    expect(localStorage.getItem(SELECTED_PERSON_KEY)).toBeNull();
    expect(tile()).toBeEnabled();
  });

  it('needs no extra request when the list is there already', async () => {
    localStorage.setItem(SELECTED_PERSON_KEY, 'p7');
    const getOne = vi.spyOn(pb.collection('persons'), 'getOne');
    renderBookPage({ persons: [seven] });
    expect(card()).toHaveAttribute('data-state', 'selected');
    await screen.findByTestId('current-person-total');
    expect(getOne).not.toHaveBeenCalled();
  });
});

describe('BookPage – tiles', () => {
  it('are disabled while the browser is offline', () => {
    renderBookPage({ persons: [seven] });
    expect(tile()).toBeEnabled();
    act(() => onlineManager.setOnline(false));
    expect(tile()).toBeDisabled();
    act(() => onlineManager.setOnline(true));
    expect(tile()).toBeEnabled();
  });

  it('show a booking on its way and stay tappable for the next one', async () => {
    localStorage.setItem(SELECTED_PERSON_KEY, 'p7');
    const created = deferred<BookingRecord>();
    const create = vi.spyOn(pb.collection('bookings'), 'create').mockReturnValue(created.promise);
    renderBookPage({ persons: [seven] });

    await userEvent.click(tile());
    expect(tile()).toHaveAttribute('aria-busy', 'true');
    expect(tile()).toBeEnabled();
    await userEvent.click(tile());
    expect(create).toHaveBeenCalledTimes(2);

    act(() =>
      created.resolve({
        ...base,
        collectionName: 'bookings',
        id: 'b1',
        person: 'p7',
        offering: 'o1',
        quantity: 1,
        unitPriceCents: 350,
        createdBy: 'u1',
      }),
    );
    await waitFor(() => expect(tile()).not.toHaveAttribute('aria-busy'));
  });
});

describe('BookPage – focus', () => {
  it('returns to the card after picking a person and after clearing the selection', async () => {
    renderBookPage({ persons: [seven] });
    await userEvent.click(screen.getByRole('button', { name: 'Person wählen' }));
    await userEvent.click(await screen.findByTestId('person-option'));
    await waitFor(() => expect(card()).toHaveAttribute('data-state', 'selected'));
    expect(screen.getByRole('button', { name: /^Person wechseln/ })).toHaveFocus();

    await userEvent.click(screen.getByRole('button', { name: 'Auswahl aufheben' }));
    expect(card()).toHaveAttribute('data-state', 'empty');
    expect(screen.getByRole('button', { name: 'Person wählen' })).toHaveFocus();
  });
});

describe('BookPage – the server cannot be reached (L4/L5)', () => {
  const unreachable = () => new ClientResponseError({ status: 0, response: {} });

  it('an empty recent list whose refresh failed shows the error, not "Noch keine Buchungen."; the card says it may be outdated', async () => {
    localStorage.setItem(SELECTED_PERSON_KEY, 'p7');
    const client = renderBookPage({ persons: [seven] });
    expect(await screen.findByText('Noch keine Buchungen.')).toBeInTheDocument();
    expect(await screen.findByTestId('current-person-total')).toHaveTextContent('7,00');

    // another phone booked for the person while this one was hidden; now both refreshes fail
    vi.spyOn(pb, 'send').mockRejectedValue(unreachable());
    vi.spyOn(pb.collection('bookings'), 'getList').mockRejectedValue(unreachable());
    await act(() => client.invalidateQueries({ queryKey: ['bookings'] }));
    await act(() => client.invalidateQueries({ queryKey: ['totals'] }));
    const recent = screen.getByTestId('recent-bookings');
    expect(await within(recent).findByRole('alert')).toHaveTextContent('Keine Verbindung zum Server');
    expect(screen.queryByText('Noch keine Buchungen.')).not.toBeInTheDocument();
    // the card keeps its numbers – with the hint below it
    expect(screen.getByTestId('current-person-total')).toHaveTextContent('7,00');
    expect(await screen.findByTestId('connection-hint')).toHaveTextContent('Anzeige evtl. nicht aktuell');
  });
});
