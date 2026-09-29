import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PersonRecord } from '../../lib/types';
import { PersonPicker } from './PersonPicker';

const base = { collectionId: 'c', collectionName: 'persons', created: '', updated: '' };
const persons: PersonRecord[] = [
  { ...base, id: 'p1', number: '001', name: 'Max Mustermann', nickname: 'Maxi' },
  { ...base, id: 'p2', number: '0010', name: 'Erika', nickname: '' },
  { ...base, id: 'p3', number: '7', name: 'Anna Anders', nickname: 'Anni' },
];

function renderPicker(props: Partial<Parameters<typeof PersonPicker>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(['persons'], persons);
  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <PersonPicker open onClose={onClose} onSelect={onSelect} {...props} />
    </QueryClientProvider>,
  );
  return { onSelect, onClose };
}

describe('PersonPicker', () => {
  it('is an accessible dialog with an autofocused search field', () => {
    renderPicker();
    expect(screen.getByRole('dialog', { name: 'Person wählen' })).toBeInTheDocument();
    expect(screen.getByTestId('person-search')).toHaveFocus();
    expect(screen.getAllByTestId('person-option')).toHaveLength(3);
  });

  it('selects the exact number on Enter even if other numbers match the prefix', async () => {
    const { onSelect } = renderPicker();
    await userEvent.type(screen.getByTestId('person-search'), '001{Enter}');
    expect(onSelect).toHaveBeenCalledWith(persons[0]);
  });

  it('selects the only search result on Enter', async () => {
    const { onSelect } = renderPicker();
    await userEvent.type(screen.getByTestId('person-search'), 'anni{Enter}');
    expect(onSelect).toHaveBeenCalledWith(persons[2]);
  });

  it('does nothing on Enter when the query is ambiguous', async () => {
    const { onSelect } = renderPicker();
    await userEvent.type(screen.getByTestId('person-search'), '00{Enter}');
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('person-option')).toHaveLength(2);
  });

  it('offers to create an unknown number and shows the pending offering', async () => {
    renderPicker({ pendingOfferingName: 'Bier/Wein' });
    expect(screen.getByTestId('pending-offering')).toHaveTextContent('Nach der Auswahl wird Bier/Wein gebucht.');
    await userEvent.type(screen.getByTestId('person-search'), '123');
    await userEvent.click(screen.getByRole('button', { name: 'Person 123 anlegen' }));
    expect(screen.getByRole('dialog', { name: 'Neue Person' })).toBeInTheDocument();
    expect(screen.getByLabelText('Nummer')).toHaveValue('123');
  });

  it('closes via the close button', async () => {
    const { onClose } = renderPicker();
    await userEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
