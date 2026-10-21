import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import type { PersonRecord } from '../../lib/types';
import { FIRST_CARDS, QrSheetPage } from './QrSheetPage';

const base = { collectionId: 'c', collectionName: 'persons', created: '', updated: '' };
const makePersons = (n: number): PersonRecord[] =>
  Array.from({ length: n }, (_, i) => ({
    ...base,
    id: `p${i + 1}`,
    number: String(i + 1),
    name: `Gast ${i + 1}`,
    nickname: i === 0 ? 'Eins' : '',
  }));

function renderSheet(path: string, persons: PersonRecord[]) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(['persons'], persons);
  const router = createMemoryRouter(
    [
      { path: '/personen/qr-codes', element: <QrSheetPage /> },
      { path: '/personen', element: <p>Personen</p> },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { client };
}

const cards = () => screen.queryAllByTestId('qr-card');
const printButton = () => screen.getByRole('button', { name: 'Drucken' });

describe('QrSheetPage', () => {
  let print: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    print = vi.fn();
    vi.stubGlobal('print', print);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Runs the next scheduled timer (a step, or the print delay) and what it renders. */
  async function nextTimer() {
    await act(async () => {
      await vi.advanceTimersToNextTimerAsync();
    });
  }

  it('adds the cards step by step and prints (drucken=1) only when all are rendered', async () => {
    renderSheet('/personen/qr-codes?drucken=1', makePersons(450));
    expect(screen.getByText('450 Personen')).toBeInTheDocument();
    expect(cards()).toHaveLength(FIRST_CARDS);
    expect(printButton()).toBeDisabled();
    expect(printButton()).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('qr-sheet-progress')).toHaveTextContent('Weitere QR-Codes werden erstellt …');

    const seen: number[] = [];
    while (cards().length < 450) {
      await nextTimer();
      seen.push(cards().length);
      expect(print).not.toHaveBeenCalled();
    }
    expect(seen).toEqual([200, 400, 450]);
    // every card is complete: number, name, QR code with the number as payload
    const last = cards().at(-1)!;
    expect(last).toHaveAttribute('data-person-number', '450');
    expect(last).toHaveTextContent('450Gast 450');
    expect(screen.getAllByTestId('qr-code').at(-1)).toHaveAttribute('data-qr-value', '450');
    expect(screen.queryByTestId('qr-sheet-progress')).not.toBeInTheDocument();
    expect(printButton()).toBeEnabled();

    expect(print).not.toHaveBeenCalled();
    await nextTimer(); // the print delay
    expect(print).toHaveBeenCalledOnce();
  });

  it('prints only once per visit', async () => {
    const { client } = renderSheet('/personen/qr-codes?drucken=1', makePersons(3));
    await nextTimer();
    expect(print).toHaveBeenCalledOnce();
    // a person added on another device: the sheet grows, no second print dialog
    await act(async () => client.setQueryData(['persons'], makePersons(4)));
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(cards()).toHaveLength(4);
    expect(print).toHaveBeenCalledOnce();
  });

  it('drucken=1 opens no second dialog when the sheet was printed from the browser meanwhile', async () => {
    renderSheet('/personen/qr-codes?drucken=1', makePersons(450));
    // Ctrl+P while the cards are still being added: the rest is rendered, the browser prints
    act(() => {
      window.dispatchEvent(new Event('beforeprint'));
    });
    expect(cards()).toHaveLength(450);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(print).not.toHaveBeenCalled();
  });

  it('drucken=1 opens no second dialog after "Drucken" was used within the delay', async () => {
    // the browser fires beforeprint for window.print()
    print.mockImplementation(() => window.dispatchEvent(new Event('beforeprint')));
    renderSheet('/personen/qr-codes?drucken=1', makePersons(3));
    act(() => {
      printButton().click();
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(print).toHaveBeenCalledOnce();
  });

  it('renders all cards at once when printing starts from the browser', () => {
    renderSheet('/personen/qr-codes', makePersons(450));
    expect(cards()).toHaveLength(FIRST_CARDS);
    act(() => {
      window.dispatchEvent(new Event('beforeprint'));
    });
    expect(cards()).toHaveLength(450);
  });

  it('shows a selection of persons (?ids=)', () => {
    renderSheet('/personen/qr-codes?ids=p2,p5', makePersons(10));
    expect(cards().map((card) => card.dataset.personNumber)).toEqual(['2', '5']);
    expect(screen.getByText('2 Personen')).toBeInTheDocument();
    expect(printButton()).toBeEnabled();
  });
});

describe('QrSheetPage "Zurück"', () => {
  function renderFrom(entries: string[]) {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    client.setQueryData(['persons'], makePersons(2));
    const router = createMemoryRouter(
      [
        { path: '/personen/qr-codes', element: <QrSheetPage /> },
        { path: '/personen', element: <p>Personen</p> },
        { path: '/konto', element: <p>Konto</p> },
      ],
      { initialEntries: entries, initialIndex: entries.length - 1 },
    );
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    return router;
  }
  afterEach(() => window.history.replaceState(null, ''));

  it('goes back within the app when the sheet was opened from it', async () => {
    // (React Router numbers the browser's history entries of an app visit: idx 1 = one before)
    window.history.replaceState({ idx: 1 }, '');
    const router = renderFrom(['/konto', '/personen/qr-codes']);
    await act(async () => screen.getByRole('button', { name: 'Zurück' }).click());
    expect(router.state.location.pathname).toBe('/konto');
  });

  it('goes to the persons when the sheet is the first page of the visit (never out of the app)', async () => {
    window.history.replaceState({ idx: 0 }, '');
    const router = renderFrom(['/konto', '/personen/qr-codes']);
    await act(async () => screen.getByRole('button', { name: 'Zurück' }).click());
    expect(router.state.location.pathname).toBe('/personen');
  });

  it('shows long numbers smaller, so they stay on their card', () => {
    const long: PersonRecord = { ...base, id: 'l', number: '12345678901234567890', name: '', nickname: '' };
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    client.setQueryData(['persons'], [long, ...makePersons(1)]);
    const router = createMemoryRouter([{ path: '/personen/qr-codes', element: <QrSheetPage /> }], {
      initialEntries: ['/personen/qr-codes'],
    });
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(screen.getByText('12345678901234567890')).toHaveClass('text-base', 'wrap-anywhere');
    expect(screen.getByText('1', { selector: 'span' })).toHaveClass('text-2xl');
  });
});
