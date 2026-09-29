import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OfferingRecord, PersonRecord } from '../../lib/types';
import { OfferingGrid } from './OfferingGrid';
import { PersonCard } from './PersonCard';

const base = { collectionId: 'c', created: '', updated: '' };
const bier: OfferingRecord = {
  ...base,
  collectionName: 'offerings',
  id: 'o1',
  name: 'Bier/Wein',
  group: 'g1',
  priceCents: 350,
  active: true,
  sortOrder: 10,
};
const pfand: OfferingRecord = { ...bier, id: 'o2', name: 'Pfand', priceCents: -200, sortOrder: 20 };
const max: PersonRecord = { ...base, collectionName: 'persons', id: 'p1', number: '001', name: 'Max', nickname: 'Maxi' };

describe('OfferingGrid', () => {
  it('renders big tiles with name and price and books on tap', async () => {
    const onBook = vi.fn();
    render(
      <OfferingGrid
        sections={[{ group: { id: 'g1', name: 'Getränke' }, offerings: [bier, pfand] }]}
        flash={null}
        onBook={onBook}
      />,
    );
    const tiles = screen.getAllByTestId('offering-tile');
    expect(tiles).toHaveLength(2);
    expect(screen.getByRole('button', { name: /^Bier\/Wein, €\s3,50$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Pfand, -€\s2,00$/ })).toBeInTheDocument();
    await userEvent.click(tiles[0]!);
    expect(onBook).toHaveBeenCalledWith(bier);
  });

  it('shows group headings only when there are several groups', () => {
    const { rerender } = render(
      <OfferingGrid sections={[{ group: { id: 'g1', name: 'Getränke' }, offerings: [bier] }]} flash={null} onBook={vi.fn()} />,
    );
    expect(screen.getByRole('heading', { name: 'Getränke' })).toHaveClass('sr-only');
    rerender(
      <OfferingGrid
        sections={[
          { group: { id: 'g1', name: 'Getränke' }, offerings: [bier] },
          { group: { id: 'g2', name: 'Snacks' }, offerings: [pfand] },
        ]}
        flash={null}
        onBook={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Snacks' })).not.toHaveClass('sr-only');
  });
});

describe('PersonCard', () => {
  it('offers picking and scanning when nobody is selected', async () => {
    const onPick = vi.fn();
    const onScan = vi.fn();
    render(<PersonCard person={null} totalCents={null} bookingCount={null} onPick={onPick} onScan={onScan} onClear={vi.fn()} />);
    expect(screen.getByTestId('current-person')).toHaveAttribute('data-state', 'empty');
    await userEvent.click(screen.getByRole('button', { name: 'Person wählen' }));
    await userEvent.click(screen.getByRole('button', { name: 'QR scannen' }));
    expect(onPick).toHaveBeenCalledOnce();
    expect(onScan).toHaveBeenCalledOnce();
  });

  it('shows the selected person with total and clear action', async () => {
    const onClear = vi.fn();
    render(<PersonCard person={max} totalCents={1250} bookingCount={4} onPick={vi.fn()} onScan={vi.fn()} onClear={onClear} />);
    expect(screen.getByTestId('current-person')).toHaveAttribute('data-person-number', '001');
    expect(screen.getByTestId('current-person-total')).toHaveTextContent('€ 12,50');
    expect(screen.getByTestId('current-person-count')).toHaveTextContent('4 Buchungen');
    expect(screen.getByText('„Maxi“')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Auswahl aufheben' }));
    expect(onClear).toHaveBeenCalledOnce();
  });
});
