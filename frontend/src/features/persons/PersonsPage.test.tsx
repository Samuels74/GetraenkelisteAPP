import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { NumberBadge } from '../../components/ui/Feedback';
import type * as FeedbackModule from '../../components/ui/Feedback';
import type { PersonRecord, Totals, TotalsPerPerson } from '../../lib/types';
import { PersonsPage } from './PersonsPage';

// The real badge, wrapped in a spy: every call = one rendered row.
vi.mock('../../components/ui/Feedback', async (importOriginal) => {
  const actual = await importOriginal<typeof FeedbackModule>();
  return { ...actual, NumberBadge: vi.fn(actual.NumberBadge) };
});

const NAMES = ['Anna Berger', 'Bernd Maier', 'Clara Huber', 'David Wolf', 'Eva Lang'];
const base = { collectionId: 'c', collectionName: 'persons', created: '', updated: '' };
/** Persons 1 … 250 (no digits in names: a number search matches numbers only); every 10th is "Anni". */
const persons: PersonRecord[] = Array.from({ length: 250 }, (_, i) => ({
  ...base,
  id: `p${i + 1}`,
  number: String(i + 1),
  name: NAMES[i % NAMES.length]!,
  nickname: (i + 1) % 10 === 0 ? 'Anni' : '',
}));

/** Every person whose number is not divisible by 3 has bookings: count = n % 3, total = n € . */
function perPerson(change: (entry: TotalsPerPerson) => TotalsPerPerson = (entry) => entry): TotalsPerPerson[] {
  return persons
    .filter((person) => Number(person.number) % 3 !== 0)
    .map((person) => {
      const n = Number(person.number);
      const { id: personId, number, name, nickname } = person;
      return change({ personId, number, name, nickname, count: n % 3, quantity: n % 3, totalCents: n * 100 });
    });
}

function totalsOf(entries: TotalsPerPerson[]): Totals {
  const sum = (key: 'count' | 'quantity' | 'totalCents') => entries.reduce((total, entry) => total + entry[key], 0);
  return {
    count: sum('count'),
    quantity: sum('quantity'),
    totalCents: sum('totalCents'),
    perPerson: entries,
    perOffering: [],
    perUser: [],
  };
}

let totalsResponse: Totals;

beforeEach(() => {
  totalsResponse = totalsOf(perPerson());
  vi.mocked(NumberBadge).mockClear();
  // The totals come from the API (whatever hook / query key the page uses).
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/api/app/totals')) return Response.json(totalsResponse);
    return Response.json({ message: `unexpected request ${url}` }, { status: 404 });
  });
});

afterEach(() => vi.restoreAllMocks());

function renderPage(path = '/personen') {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(['persons'], persons);
  const router = createMemoryRouter(
    [
      { path: '/personen', element: <PersonsPage /> },
      { path: '/personen/:personId', element: <p>Detailseite</p> },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { client, router };
}

const rows = () => screen.getAllByTestId('person-row');
const row = (number: string) => rows().find((element) => element.dataset.personNumber === number)!;

describe('PersonsPage', () => {
  it('renders the first 100 persons and 100 more per tap', async () => {
    renderPage();
    expect(await screen.findAllByTestId('person-row')).toHaveLength(100);
    expect(rows()[0]).toHaveAttribute('data-person-number', '1');
    expect(rows()[99]).toHaveAttribute('data-person-number', '100');
    // the list holds the rows only; the footer is below it
    expect(within(screen.getByRole('list', { name: 'Personen' })).getAllByRole('listitem')).toHaveLength(100);
    expect(screen.getByText('100 von 250 Personen angezeigt')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Weitere 100 anzeigen' }));
    expect(rows()).toHaveLength(200);
    expect(screen.getByText('200 von 250 Personen angezeigt')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Weitere 50 anzeigen' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Weitere 50 anzeigen' }));
    expect(rows()).toHaveLength(250);
    expect(screen.queryByTestId('persons-more')).not.toBeInTheDocument();
    // the button is gone: focus continues at the first new row
    expect(rows()[200]).toHaveFocus();
  });

  it('starts with 100 rows again for a new search', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Weitere 100 anzeigen' }));
    expect(rows()).toHaveLength(200);
    await userEvent.type(screen.getByTestId('persons-search'), '1');
    const matches = persons.filter((person) => person.number.includes('1')).length;
    expect(matches).toBeGreaterThan(100);
    expect(await screen.findByText(`100 von ${matches} Personen angezeigt`)).toBeInTheDocument();
    expect(rows()).toHaveLength(100);
    expect(rows()[0]).toHaveAttribute('data-person-number', '1');
  });

  it('shows each total and re-renders only the rows whose totals changed', async () => {
    const { client } = renderPage();
    await waitFor(() => expect(row('2')).toHaveTextContent(/€\s2,00\s*2 Buchungen/));
    expect(row('1')).toHaveTextContent(/€\s1,00\s*1 Buchung$/);
    expect(row('3')).not.toHaveTextContent('€'); // no bookings

    // new objects for every person (like a refetch), but only person 2 changed
    vi.mocked(NumberBadge).mockClear();
    totalsResponse = totalsOf(
      perPerson((entry) => (entry.number === '2' ? { ...entry, count: 3, totalCents: 550 } : { ...entry })),
    );
    await act(() => client.invalidateQueries({ queryKey: ['totals'] }));
    await waitFor(() => expect(row('2')).toHaveTextContent(/€\s5,50\s*3 Buchungen/));
    expect(vi.mocked(NumberBadge).mock.calls.map(([props]) => props.number)).toEqual(['2']);
  });

  it('takes the search from ?q= and keeps it in the URL', async () => {
    const { router } = renderPage('/personen?q=anni');
    const search = screen.getByTestId('persons-search');
    expect(search).toHaveValue('anni');
    expect(rows()).toHaveLength(persons.filter((person) => person.nickname === 'Anni').length);

    await userEvent.clear(search);
    await userEvent.type(search, 'clara');
    expect(search).toHaveValue('clara');
    await waitFor(() => expect(router.state.location.search).toBe('?q=clara'), { timeout: 2_000 });
    expect(router.state.historyAction).toBe('REPLACE');
    expect(rows().every((element) => element.textContent?.includes('Clara Huber'))).toBe(true);
  });

  it('opens the person on tap', async () => {
    const { router } = renderPage();
    await userEvent.click((await screen.findAllByTestId('person-row'))[4]!);
    expect(router.state.location.pathname).toBe('/personen/p5');
  });

  it('keeps a search typed right before opening a person: Back returns to it', async () => {
    const { router } = renderPage();
    await userEvent.type(await screen.findByTestId('persons-search'), 'clara');
    await waitFor(() => expect(rows().every((element) => element.textContent?.includes('Clara Huber'))).toBe(true));
    expect(router.state.location.search).toBe(''); // still within the delay
    await userEvent.click(row('3'));
    expect(router.state.location.pathname).toBe('/personen/p3');
    await act(() => router.navigate(-1));
    expect(router.state.location.search).toBe('?q=clara');
    expect(screen.getByTestId('persons-search')).toHaveValue('clara');
  });
});
