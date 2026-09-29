import { Plus, Trash } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import {
  computeReorder,
  useDeleteOffering,
  useReorderOfferings,
  useSaveOffering,
  type OfferingInput,
} from '../../api/mutations';
import { useGroups, useOfferings, useReferenceTotals } from '../../api/queries';
import { Button, ButtonLink } from '../../components/ui/Button';
import { ConfirmDialog, Dialog } from '../../components/ui/Dialog';
import { Badge, EmptyState, QueryError } from '../../components/ui/Feedback';
import { FormError, SelectField, SwitchField, TextField } from '../../components/ui/Field';
import { PageSpinner } from '../../components/ui/Spinner';
import { changedFields, isEmptyPatch } from '../../lib/diff';
import { describeError, errorMessage } from '../../lib/errors';
import { formatCents, formatCentsPlain, MAX_PRICE_CENTS, parseMoneyToCents } from '../../lib/money';
import type { GroupRecord, OfferingRecord } from '../../lib/types';
import { ReorderButtons } from './ReorderButtons';

const bySort = <T extends { sortOrder: number; name: string }>(a: T, b: T) =>
  a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'de');

type EditState = { mode: 'create'; groupId: string } | { mode: 'edit'; offering: OfferingRecord };

export function OfferingsAdmin() {
  const groups = useGroups();
  const offerings = useOfferings();
  const references = useReferenceTotals();
  const reorder = useReorderOfferings();
  const [edit, setEdit] = useState<EditState | null>(null);

  const sortedGroups = useMemo(() => [...(groups.data ?? [])].sort(bySort), [groups.data]);
  const booked = useMemo(
    () => new Set((references.data?.perOffering ?? []).map((entry) => entry.offeringId)),
    [references.data],
  );

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

  function move(list: OfferingRecord[], index: number, delta: -1 | 1) {
    const updates = computeReorder(list, index, delta);
    if (updates.length === 0) return;
    reorder.mutate(updates, { onError: (error) => toast.error(errorMessage(error, 'offerings')) });
  }

  if (sortedGroups.length === 0) {
    return (
      <EmptyState title="Noch keine Gruppen">
        <p>Angebote gehören immer zu einer Gruppe (z. B. „Getränke“).</p>
        <ButtonLink to="/verwaltung/gruppen" variant="primary" className="mt-4">
          Gruppe anlegen
        </ButtonLink>
      </EmptyState>
    );
  }

  const all = offerings.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">Inaktive Angebote werden beim Buchen nicht angezeigt.</p>
        <Button
          variant="primary"
          icon={<Plus className="size-5" aria-hidden />}
          onClick={() => setEdit({ mode: 'create', groupId: sortedGroups[0]!.id })}
          className="shrink-0"
        >
          Neues Angebot
        </Button>
      </div>

      {sortedGroups.map((group) => {
        const items = all.filter((o) => o.group === group.id).sort(bySort);
        return (
          <section key={group.id} aria-labelledby={`admin-group-${group.id}`}>
            <h2 id={`admin-group-${group.id}`} className="mb-2 px-1 text-sm font-bold tracking-wide text-muted uppercase">
              {group.name}
            </h2>
            {items.length === 0 ? (
              <p className="rounded-3xl border border-dashed border-line-strong px-4 py-4 text-sm text-muted">
                Keine Angebote in dieser Gruppe.
              </p>
            ) : (
              <ul className="divide-y divide-line overflow-hidden rounded-3xl border border-line bg-surface">
                {items.map((offering, index) => (
                  <li
                    key={offering.id}
                    className="flex items-center gap-1 py-1 pr-1 pl-1"
                    data-testid="offering-row"
                    data-offering-name={offering.name}
                  >
                    <button
                      type="button"
                      onClick={() => setEdit({ mode: 'edit', offering })}
                      aria-label={`${offering.name} bearbeiten`}
                      className="flex min-h-14 min-w-0 flex-1 items-center gap-2 rounded-2xl px-3 py-1.5 text-left transition-colors hover:bg-surface-2"
                    >
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate font-semibold ${offering.active ? '' : 'text-muted line-through'}`}>
                          {offering.name}
                        </span>
                        <span className="block text-sm text-muted tabular-nums">{formatCents(offering.priceCents)}</span>
                      </span>
                      <span className="flex flex-col items-end gap-1">
                        {!offering.active ? <Badge tone="warning">Inaktiv</Badge> : null}
                        {booked.has(offering.id) ? <Badge>Gebucht</Badge> : null}
                      </span>
                    </button>
                    <ReorderButtons
                      name={offering.name}
                      isFirst={index === 0}
                      isLast={index === items.length - 1}
                      disabled={reorder.isPending}
                      onMove={(delta) => move(items, index, delta)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}

      <Dialog
        open={edit !== null}
        onClose={() => setEdit(null)}
        title={edit?.mode === 'edit' ? 'Angebot bearbeiten' : 'Neues Angebot'}
        testId="offering-dialog"
      >
        {edit ? (
          <OfferingForm
            key={edit.mode === 'edit' ? edit.offering.id : 'new'}
            offering={edit.mode === 'edit' ? edit.offering : null}
            defaultGroupId={edit.mode === 'create' ? edit.groupId : edit.offering.group}
            groups={sortedGroups}
            offerings={all}
            hasBookings={edit.mode === 'edit' && booked.has(edit.offering.id)}
            referencesLoaded={references.isSuccess}
            onDone={() => setEdit(null)}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

interface OfferingFormProps {
  offering: OfferingRecord | null;
  defaultGroupId: string;
  groups: GroupRecord[];
  offerings: OfferingRecord[];
  hasBookings: boolean;
  referencesLoaded: boolean;
  onDone: () => void;
}

type Errors = Partial<Record<'name' | 'group' | 'priceCents', string>>;

function OfferingForm({ offering, defaultGroupId, groups, offerings, hasBookings, referencesLoaded, onDone }: OfferingFormProps) {
  const save = useSaveOffering();
  const remove = useDeleteOffering();
  // Values the dialog started with: updates send only what differs from them.
  const [initial] = useState(() =>
    offering
      ? { name: offering.name, group: offering.group, priceCents: offering.priceCents, active: offering.active }
      : null,
  );
  const [name, setName] = useState(offering?.name ?? '');
  const [groupId, setGroupId] = useState(offering?.group ?? defaultGroupId);
  const [price, setPrice] = useState(offering ? formatCentsPlain(offering.priceCents) : '');
  const [active, setActive] = useState(offering?.active ?? true);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function nextSortOrder(targetGroup: string): number {
    const max = Math.max(0, ...offerings.filter((o) => o.group === targetGroup).map((o) => o.sortOrder));
    return max + 10;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    const cents = price.trim() === '' ? 0 : parseMoneyToCents(price);
    const nextErrors: Errors = {};
    if (!trimmed) nextErrors.name = 'Bitte einen Namen eingeben.';
    else if (trimmed.length > 50) nextErrors.name = 'Höchstens 50 Zeichen erlaubt.';
    else if (
      offerings.some(
        (o) => o.id !== offering?.id && o.group === groupId && o.name.toLowerCase() === trimmed.toLowerCase(),
      )
    ) {
      nextErrors.name = 'Ein Angebot mit diesem Namen gibt es in dieser Gruppe bereits.';
    }
    if (!groupId) nextErrors.group = 'Bitte eine Gruppe wählen.';
    if (cents === null) nextErrors.priceCents = 'Bitte einen gültigen Preis eingeben, z. B. 3,50.';
    else if (Math.abs(cents) > MAX_PRICE_CENTS) nextErrors.priceCents = 'Der Preis muss zwischen -1.000,00 € und 1.000,00 € liegen.';
    setErrors(nextErrors);
    setFormError(null);
    if (Object.keys(nextErrors).length > 0 || cents === null) return;

    const input: OfferingInput = { name: trimmed, group: groupId, priceCents: cents, active };
    try {
      if (offering && initial) {
        // Only the fields changed in this dialog are sent: another admin may
        // have changed e.g. `active` since the dialog was opened.
        const patch: Partial<OfferingInput> = changedFields(initial, input);
        if (patch.group !== undefined) patch.sortOrder = nextSortOrder(groupId);
        if (!isEmptyPatch(patch)) await save.mutateAsync({ id: offering.id, input: patch });
        toast.success('Angebot gespeichert');
      } else {
        await save.mutateAsync({ input: { ...input, sortOrder: nextSortOrder(groupId) } });
        toast.success(`Angebot „${trimmed}“ angelegt`);
      }
      onDone();
    } catch (error) {
      const info = describeError(error, 'offerings');
      setErrors({ name: info.fieldErrors.name, group: info.fieldErrors.group, priceCents: info.fieldErrors.priceCents });
      setFormError(info.message);
    }
  }

  async function handleDelete() {
    if (!offering) return;
    setDeleteError(null);
    try {
      await remove.mutateAsync(offering.id);
      toast.success(`Angebot „${offering.name}“ gelöscht`);
      setConfirmDelete(false);
      onDone();
    } catch (error) {
      setDeleteError(errorMessage(error, 'offerings'));
    }
  }

  return (
    <>
      <form onSubmit={(e) => void handleSubmit(e)} noValidate className="space-y-4">
        <TextField
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={errors.name}
          maxLength={50}
          autoComplete="off"
          dialogAutoFocus
          required
        />
        <SelectField label="Gruppe" value={groupId} onChange={(e) => setGroupId(e.target.value)} error={errors.group}>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Preis in €"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          error={errors.priceCents}
          hint="z. B. 3,50 – negativ für Rückgaben (Pfand), leer = 0,00"
          inputMode="decimal"
          placeholder="0,00"
          autoComplete="off"
        />
        <SwitchField
          label="Aktiv"
          description="Wird beim Buchen angezeigt"
          checked={active}
          onChange={setActive}
        />
        <FormError message={formError} />
        <div className="flex gap-3 pt-1">
          <Button block onClick={onDone}>
            Abbrechen
          </Button>
          <Button type="submit" block variant="primary" loading={save.isPending}>
            {offering ? 'Speichern' : 'Anlegen'}
          </Button>
        </div>
      </form>

      {offering ? (
        <div className="mt-6 border-t border-line pt-4">
          <Button
            variant="danger-soft"
            icon={<Trash className="size-5" aria-hidden />}
            disabled={hasBookings || !referencesLoaded}
            onClick={() => setConfirmDelete(true)}
          >
            Angebot löschen
          </Button>
          {hasBookings ? (
            <p className="mt-2 text-sm text-muted" data-testid="delete-hint">
              Hat Buchungen – stattdessen deaktivieren.
            </p>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        title="Angebot löschen?"
        message={
          <p>
            <strong>{offering?.name}</strong> wird endgültig gelöscht.
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
