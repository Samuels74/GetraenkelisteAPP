import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { pb } from '../../lib/pb';
import type { PersonRecord } from '../../lib/types';
import { PersonForm } from './PersonForm';

const created: PersonRecord = {
  collectionId: 'c',
  collectionName: 'persons',
  created: '',
  updated: '',
  id: 'p9',
  number: '9',
  name: 'Neun',
  nickname: '',
};

function renderForm() {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(['persons'], []);
  const onSaved = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <PersonForm onSaved={onSaved} onCancel={vi.fn()} />
    </QueryClientProvider>,
  );
  return { onSaved, unmount: view.unmount };
}

afterEach(() => vi.restoreAllMocks());

describe('PersonForm', () => {
  it('Enter in "Nummer" and "Name" moves to the next field; only the last field submits', async () => {
    const create = vi.spyOn(pb.collection('persons'), 'create').mockResolvedValue(created);
    const { onSaved } = renderForm();

    await userEvent.type(screen.getByLabelText('Nummer'), '9{Enter}');
    expect(screen.getByLabelText('Name')).toHaveFocus();
    await userEvent.type(screen.getByLabelText('Name'), 'Neun{Enter}');
    expect(screen.getByLabelText('Nickname')).toHaveFocus();
    expect(create).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText('Nickname'), '{Enter}');
    expect(create).toHaveBeenCalledWith({ number: '9', name: 'Neun', nickname: '' });
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith(created));
  });

  it('ignores a result that arrives after its dialog was closed (no late navigation or selection)', async () => {
    let finish = (_person: PersonRecord) => {};
    vi.spyOn(pb.collection('persons'), 'create').mockReturnValue(
      new Promise<PersonRecord>((resolve) => {
        finish = resolve;
      }),
    );
    const { onSaved, unmount } = renderForm();
    await userEvent.type(screen.getByLabelText('Nummer'), '9');
    await userEvent.click(screen.getByRole('button', { name: 'Anlegen' }));
    unmount(); // the dialog was closed while saving

    await act(async () => finish(created));
    expect(onSaved).not.toHaveBeenCalled();
  });
});
