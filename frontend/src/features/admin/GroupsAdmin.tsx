import { Plus, Trash } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { computeReorder, useDeleteGroup, useReorderGroups, useSaveGroup } from '../../api/mutations';
import { useGroups, useOfferings } from '../../api/queries';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog, Dialog } from '../../components/ui/Dialog';
import { EmptyState, QueryError } from '../../components/ui/Feedback';
import { FormError, TextField } from '../../components/ui/Field';
import { PageSpinner } from '../../components/ui/Spinner';
import { describeError, errorMessage } from '../../lib/errors';
import type { GroupRecord } from '../../lib/types';
import { ReorderButtons } from './ReorderButtons';

const bySort = (a: GroupRecord, b: GroupRecord) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'de');

type EditState = { mode: 'create' } | { mode: 'edit'; group: GroupRecord };

export function GroupsAdmin() {
  const groups = useGroups();
  const offerings = useOfferings();
  const reorder = useReorderGroups();
  const [edit, setEdit] = useState<EditState | null>(null);

  const sorted = useMemo(() => [...(groups.data ?? [])].sort(bySort), [groups.data]);
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const offering of offerings.data ?? []) map.set(offering.group, (map.get(offering.group) ?? 0) + 1);
    return map;
  }, [offerings.data]);

  if (groups.isPending || offerings.isPending) return <PageSpinner />;
  const loadError = groups.error ?? offerings.error;
  if (loadError) {
    return (
      <QueryError
        error={loadError}
        onRetry={() => {
          void groups.refetch();
          void offerings.refetch();
        }}
      />
    );
  }

  function move(index: number, delta: -1 | 1) {
    const updates = computeReorder(sorted, index, delta);
    if (updates.length === 0) return;
    reorder.mutate(updates, { onError: (error) => toast.error(errorMessage(error, 'groups')) });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">Gruppen ordnen die Angebote beim Buchen.</p>
        <Button
          variant="primary"
          icon={<Plus className="size-5" aria-hidden />}
          onClick={() => setEdit({ mode: 'create' })}
          className="shrink-0"
        >
          Neue Gruppe
        </Button>
      </div>

      {sorted.length === 0 ? (
        <EmptyState title="Noch keine Gruppen" />
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-3xl border border-line bg-surface">
          {sorted.map((group, index) => {
            const count = counts.get(group.id) ?? 0;
            return (
              <li key={group.id} className="flex items-center gap-1 p-1" data-testid="group-row" data-group-name={group.name}>
                <button
                  type="button"
                  onClick={() => setEdit({ mode: 'edit', group })}
                  aria-label={`${group.name} bearbeiten`}
                  className="flex min-h-14 min-w-0 flex-1 flex-col justify-center rounded-2xl px-3 py-1.5 text-left transition-colors hover:bg-surface-2"
                >
                  <span className="block truncate font-semibold">{group.name}</span>
                  <span className="block text-sm text-muted">
                    {count} {count === 1 ? 'Angebot' : 'Angebote'}
                  </span>
                </button>
                <ReorderButtons
                  name={group.name}
                  isFirst={index === 0}
                  isLast={index === sorted.length - 1}
                  disabled={reorder.isPending}
                  onMove={(delta) => move(index, delta)}
                />
              </li>
            );
          })}
        </ul>
      )}

      <Dialog
        open={edit !== null}
        onClose={() => setEdit(null)}
        title={edit?.mode === 'edit' ? 'Gruppe bearbeiten' : 'Neue Gruppe'}
        testId="group-dialog"
      >
        {edit ? (
          <GroupForm
            key={edit.mode === 'edit' ? edit.group.id : 'new'}
            group={edit.mode === 'edit' ? edit.group : null}
            groups={sorted}
            offeringCount={edit.mode === 'edit' ? (counts.get(edit.group.id) ?? 0) : 0}
            onDone={() => setEdit(null)}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

function GroupForm({
  group,
  groups,
  offeringCount,
  onDone,
}: {
  group: GroupRecord | null;
  groups: GroupRecord[];
  offeringCount: number;
  onDone: () => void;
}) {
  const save = useSaveGroup();
  const remove = useDeleteGroup();
  const [name, setName] = useState(group?.name ?? '');
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    setFormError(null);
    if (!trimmed) return setError('Bitte einen Namen eingeben.');
    if (trimmed.length > 50) return setError('Höchstens 50 Zeichen erlaubt.');
    if (groups.some((g) => g.id !== group?.id && g.name.toLowerCase() === trimmed.toLowerCase())) {
      return setError('Eine Gruppe mit diesem Namen gibt es bereits.');
    }
    setError(null);
    try {
      if (group) {
        if (trimmed !== group.name) await save.mutateAsync({ id: group.id, input: { name: trimmed } });
        toast.success('Gruppe gespeichert');
      } else {
        const sortOrder = Math.max(0, ...groups.map((g) => g.sortOrder)) + 10;
        await save.mutateAsync({ input: { name: trimmed, sortOrder } });
        toast.success(`Gruppe „${trimmed}“ angelegt`);
      }
      onDone();
    } catch (err) {
      const info = describeError(err, 'groups');
      setError(info.fieldErrors.name ?? null);
      setFormError(info.fieldErrors.name ? null : info.message);
    }
  }

  async function handleDelete() {
    if (!group) return;
    setDeleteError(null);
    try {
      await remove.mutateAsync(group.id);
      toast.success(`Gruppe „${group.name}“ gelöscht`);
      setConfirmDelete(false);
      onDone();
    } catch (err) {
      setDeleteError(errorMessage(err, 'groups'));
    }
  }

  return (
    <>
      <form onSubmit={(e) => void handleSubmit(e)} noValidate className="space-y-4">
        <TextField
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={error}
          maxLength={50}
          autoComplete="off"
          dialogAutoFocus
          required
        />
        <FormError message={formError} />
        <div className="flex gap-3 pt-1">
          <Button block onClick={onDone}>
            Abbrechen
          </Button>
          <Button type="submit" block variant="primary" loading={save.isPending}>
            {group ? 'Speichern' : 'Anlegen'}
          </Button>
        </div>
      </form>
      {group ? (
        <div className="mt-6 border-t border-line pt-4">
          <Button
            variant="danger-soft"
            icon={<Trash className="size-5" aria-hidden />}
            disabled={offeringCount > 0}
            onClick={() => setConfirmDelete(true)}
          >
            Gruppe löschen
          </Button>
          {offeringCount > 0 ? (
            <p className="mt-2 text-sm text-muted" data-testid="delete-hint">
              Enthält noch {offeringCount} {offeringCount === 1 ? 'Angebot' : 'Angebote'} – kann nicht gelöscht werden.
            </p>
          ) : null}
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmDelete}
        title="Gruppe löschen?"
        message={
          <p>
            <strong>{group?.name}</strong> wird endgültig gelöscht.
          </p>
        }
        confirmLabel="Löschen"
        loading={remove.isPending}
        error={deleteError}
        onConfirm={() => void handleDelete()}
        onClose={() => {
          setConfirmDelete(false);
          setDeleteError(null);
        }}
      />
    </>
  );
}
