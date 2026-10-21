import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PersonRecord } from '../../lib/types';
import { PersonFilter } from './PersonFilter';

const base = { collectionId: 'c', collectionName: 'persons', created: '', updated: '' };
const persons: PersonRecord[] = [
  { ...base, id: 'p1', number: '001', name: 'Max Mustermann', nickname: 'Maxi' },
  { ...base, id: 'p2', number: '0010', name: 'Erika', nickname: '' },
  { ...base, id: 'p3', number: '7', name: 'Anna Anders', nickname: 'Anni' },
];

function renderFilter(personId = '') {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(['persons'], persons);
  const onChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <PersonFilter personId={personId} onChange={onChange} />
    </QueryClientProvider>,
  );
  return { onChange };
}

const trigger = () => screen.getByTestId('person-filter');

describe('PersonFilter', () => {
  it('shows "Alle Personen" and picks a person with the person picker', async () => {
    const { onChange } = renderFilter();
    expect(trigger()).toHaveAccessibleName('Person: Alle Personen');
    expect(trigger()).toHaveAttribute('data-person-id', '');
    expect(trigger()).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.queryByTestId('person-filter-clear')).not.toBeInTheDocument();

    await userEvent.click(trigger());
    const picker = screen.getByRole('dialog', { name: 'Person wählen' });
    expect(picker).toBeInTheDocument();
    // a filter does not create persons; scanning a QR code works
    expect(screen.queryByRole('button', { name: 'Neue Person' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'QR scannen' })).toBeInTheDocument();
    await userEvent.type(screen.getByTestId('person-search'), 'anni');
    await userEvent.click(within(picker).getByRole('button', { name: /Anna Anders/ }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('p3');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the selected person and goes back to all persons', async () => {
    const { onChange } = renderFilter('p1');
    expect(trigger()).toHaveAccessibleName('Person: 001 · Max Mustermann („Maxi“)');
    expect(trigger()).toHaveAttribute('data-person-id', 'p1');
    await userEvent.click(screen.getByRole('button', { name: 'Alle Personen anzeigen' }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('');
    expect(trigger()).toHaveFocus();
  });

  it('marks the selected person in the picker', async () => {
    renderFilter('p2');
    await userEvent.click(trigger());
    const picker = screen.getByRole('dialog', { name: 'Person wählen' });
    expect(within(picker).getByRole('button', { name: /Erika/ })).toHaveAttribute('aria-current', 'true');
  });

  it('names a person that does not exist (any more)', () => {
    renderFilter('gone');
    expect(trigger()).toHaveTextContent('Unbekannte Person');
    expect(screen.getByRole('button', { name: 'Alle Personen anzeigen' })).toBeInTheDocument();
  });

  it('offers no "create" for an unknown number', async () => {
    renderFilter();
    await userEvent.click(trigger());
    await userEvent.type(screen.getByTestId('person-search'), '999');
    expect(screen.getByText('Keine Person gefunden')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Person 999 anlegen' })).not.toBeInTheDocument();
  });
});
