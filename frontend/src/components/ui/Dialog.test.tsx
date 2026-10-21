import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { ConfirmDialog, Dialog } from './Dialog';

/** An edit dialog that opens a delete confirmation (like Angebote / Gruppen / Benutzer). */
function EditWithConfirm({ onCloseEdit, onCloseConfirm }: { onCloseEdit: () => void; onCloseConfirm: () => void }) {
  const [editOpen, setEditOpen] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(true);
  return (
    <Dialog
      open={editOpen}
      onClose={() => {
        onCloseEdit();
        setEditOpen(false);
      }}
      title="Angebot bearbeiten"
      testId="edit-dialog"
    >
      <input aria-label="Name" defaultValue="geändert, nicht gespeichert" />
      <ConfirmDialog
        open={confirmOpen}
        title="Angebot löschen?"
        message="Wird endgültig gelöscht."
        confirmLabel="Löschen"
        onConfirm={() => undefined}
        onClose={() => {
          onCloseConfirm();
          setConfirmOpen(false);
        }}
      />
    </Dialog>
  );
}

/** The `cancel` event Escape / Android's back gesture fire on the topmost modal dialog. */
function pressEscapeIn(dialog: HTMLElement) {
  fireEvent(dialog, new Event('cancel', { cancelable: true }));
}

describe('Dialog', () => {
  it('Escape in a confirmation opened from a dialog closes only the confirmation', () => {
    const onCloseEdit = vi.fn();
    const onCloseConfirm = vi.fn();
    render(<EditWithConfirm onCloseEdit={onCloseEdit} onCloseConfirm={onCloseConfirm} />);

    pressEscapeIn(screen.getByTestId('confirm-dialog'));
    expect(onCloseConfirm).toHaveBeenCalledOnce();
    expect(onCloseEdit).not.toHaveBeenCalled();
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('edit-dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('geändert, nicht gespeichert');

    // the edit dialog itself still closes on Escape
    pressEscapeIn(screen.getByTestId('edit-dialog'));
    expect(onCloseEdit).toHaveBeenCalledOnce();
  });

  it('keeps a non-dismissible dialog open on Escape, a backdrop click and "Schließen"', () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} title="Bitte warten" dismissible={false} testId="d" />);
    pressEscapeIn(screen.getByTestId('d'));
    fireEvent.click(screen.getByTestId('d'));
    expect(screen.getByRole('button', { name: 'Schließen' })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('ConfirmDialog', () => {
  it('focuses "Abbrechen" first for destructive actions (Enter right away does not confirm)', () => {
    render(
      <ConfirmDialog open title="Löschen?" message="x" confirmLabel="Löschen" onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Abbrechen' })).toHaveFocus();
  });

  it('runs the action once for a double click and shows it as busy until it settles', async () => {
    let finish = () => {};
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<ConfirmDialog open title="Stornieren?" message="x" confirmLabel="Stornieren" onConfirm={onConfirm} onClose={vi.fn()} />);
    const confirm = screen.getByRole('button', { name: 'Stornieren' });
    // two clicks in the same moment – before React re-renders the busy button
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    expect(confirm).toBeDisabled();

    finish();
    await vi.waitFor(() => expect(confirm).not.toBeDisabled());
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it('can be confirmed again after a failed action (it may be retried)', async () => {
    const onConfirm = vi.fn(() => Promise.reject(new Error('x')));
    render(<ConfirmDialog open title="Löschen?" message="x" confirmLabel="Löschen" onConfirm={onConfirm} onClose={vi.fn()} />);
    const confirm = screen.getByRole('button', { name: 'Löschen' });
    fireEvent.click(confirm);
    await vi.waitFor(() => expect(confirm).not.toBeDisabled());
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });
});
