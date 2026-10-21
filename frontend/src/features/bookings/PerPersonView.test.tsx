import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NumberBadge } from '../../components/ui/Feedback';
import type * as FeedbackModule from '../../components/ui/Feedback';
import type { Totals, TotalsPerPerson } from '../../lib/types';
import { PerPersonView } from './PerPersonView';

// The real badge, wrapped in a spy: every call = one rendered row.
vi.mock('../../components/ui/Feedback', async (importOriginal) => {
  const actual = await importOriginal<typeof FeedbackModule>();
  return { ...actual, NumberBadge: vi.fn(actual.NumberBadge) };
});

/** 150 persons with bookings, in the server's order (numbers sorted as text: 1, 10, 100, …). */
function entries(change: (entry: TotalsPerPerson) => TotalsPerPerson = (entry) => ({ ...entry })): TotalsPerPerson[] {
  return Array.from({ length: 150 }, (_, i) => ({
    personId: `p${i + 1}`,
    number: String(i + 1),
    name: i === 1 ? '' : `Gast ${i + 1}`,
    nickname: i === 0 ? 'Eins' : '',
    count: 1,
    quantity: 2,
    totalCents: (i + 1) * 100,
  }))
    .sort((a, b) => a.number.localeCompare(b.number))
    .map(change);
}

const totals = (perPerson: TotalsPerPerson[]): Totals => ({ count: 150, quantity: 300, totalCents: 0, perPerson });
const rows = () => screen.getAllByTestId('totals-person-row');

beforeEach(() => {
  vi.mocked(NumberBadge).mockClear();
});

describe('PerPersonView without rows', () => {
  it('says "Keine Buchungen" – unless the refresh failed: then the error with a retry (L4)', async () => {
    const onRetry = vi.fn();
    const { rerender } = render(<PerPersonView totals={totals([])} onSelect={vi.fn()} resetKey="x" />);
    expect(screen.getByText('Keine Buchungen')).toBeInTheDocument();
    const error = new Error('x');
    rerender(<PerPersonView totals={totals([])} error={error} onRetry={onRetry} onSelect={vi.fn()} resetKey="x" />);
    expect(screen.queryByText('Keine Buchungen')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(onRetry).toHaveBeenCalledOnce();
    // no numbers at all: the summary above shows the error – no spinner forever here
    rerender(<PerPersonView totals={undefined} error={error} onRetry={onRetry} onSelect={vi.fn()} resetKey="x" />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('PerPersonView', () => {
  it('renders the first 100 persons in natural order and 100 more per tap', async () => {
    render(<PerPersonView totals={totals(entries())} onSelect={vi.fn()} resetKey="ansicht=personen" />);
    expect(rows()).toHaveLength(100);
    expect(rows().slice(0, 3).map((row) => row.dataset.personNumber)).toEqual(['1', '2', '3']);
    expect(rows()[0]).toHaveTextContent(/„Eins“ · 2×.*€\s1,00/);
    expect(rows()[1]).toHaveTextContent('Ohne Namen');
    expect(screen.getByText('100 von 150 Personen angezeigt')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Weitere 50 anzeigen' }));
    expect(rows()).toHaveLength(150);
    expect(rows()[149]).toHaveAttribute('data-person-number', '150');
    expect(screen.queryByTestId('totals-per-person-more')).not.toBeInTheDocument();
    expect(rows()[100]).toHaveFocus(); // the button is gone: focus continues at the first new row
  });

  it('shows the first 100 again for another filter', async () => {
    const { rerender } = render(<PerPersonView totals={totals(entries())} onSelect={vi.fn()} resetKey="a" />);
    await userEvent.click(screen.getByRole('button', { name: 'Weitere 50 anzeigen' }));
    expect(rows()).toHaveLength(150);
    rerender(<PerPersonView totals={totals(entries())} onSelect={vi.fn()} resetKey="b" />);
    expect(rows()).toHaveLength(100);
  });

  it('re-renders only rows that changed and calls the latest onSelect', async () => {
    const first = vi.fn();
    const { rerender } = render(<PerPersonView totals={totals(entries())} onSelect={first} resetKey="a" />);
    vi.mocked(NumberBadge).mockClear();
    const latest = vi.fn();
    // new objects for every person (a refetch or a patched cache entry), only person 7 changed
    const changed = entries((entry) =>
      entry.number === '7' ? { ...entry, quantity: 3, totalCents: 1050 } : { ...entry },
    );
    rerender(<PerPersonView totals={totals(changed)} onSelect={latest} resetKey="a" />);
    expect(vi.mocked(NumberBadge).mock.calls.map(([props]) => props.number)).toEqual(['7']);
    expect(rows()[6]).toHaveTextContent(/3×.*€\s10,50/);

    await userEvent.click(rows()[6]!);
    expect(latest).toHaveBeenCalledExactlyOnceWith('p7');
    expect(first).not.toHaveBeenCalled();
  });

  it('waits for the per-person part and says when there are no bookings', () => {
    // only the summary (e.g. the list view's totals as placeholder data)
    const summaryOnly = { count: 3, quantity: 3, totalCents: 900 };
    const { rerender } = render(<PerPersonView totals={summaryOnly} onSelect={vi.fn()} resetKey="a" />);
    expect(screen.getByRole('status', { name: 'Wird geladen …' })).toBeInTheDocument();
    rerender(<PerPersonView totals={undefined} onSelect={vi.fn()} resetKey="a" />);
    expect(screen.getByRole('status', { name: 'Wird geladen …' })).toBeInTheDocument();
    rerender(<PerPersonView totals={totals([])} onSelect={vi.fn()} resetKey="a" />);
    expect(screen.getByText('Keine Buchungen')).toBeInTheDocument();
  });
});
