import { KeyRound, Trash, UserPlus } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { useCreateUser, useDeleteUser, useUpdateUser, type UpdateUserInput } from '../../api/mutations';
import { useReferenceTotals, useUsers } from '../../api/queries';
import { normalizeUsername, useCurrentUser } from '../../auth/session';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog, Dialog } from '../../components/ui/Dialog';
import { Badge, EmptyState, QueryError } from '../../components/ui/Feedback';
import { FormError, SelectField, SwitchField, TextField } from '../../components/ui/Field';
import { PageSpinner } from '../../components/ui/Spinner';
import { changedFields, isEmptyPatch } from '../../lib/diff';
import { describeError, errorMessage } from '../../lib/errors';
import type { Role, UserRecord } from '../../lib/types';

const USERNAME_PATTERN = /^[a-z0-9._-]+$/;
const MIN_PASSWORD = 8;

const ROLE_LABELS: Record<Role, string> = { admin: 'Admin', user: 'Benutzer' };

type EditState = { mode: 'create' } | { mode: 'edit'; user: UserRecord };

export function UsersAdmin() {
  const me = useCurrentUser();
  const users = useUsers();
  const references = useReferenceTotals();
  const [edit, setEdit] = useState<EditState | null>(null);
  const withBookings = useMemo(
    () => new Set((references.data?.perUser ?? []).map((entry) => entry.userId)),
    [references.data],
  );

  if (users.isPending) return <PageSpinner />;
  if (users.isError) return <QueryError error={users.error} onRetry={() => void users.refetch()} />;

  const editedUser = edit?.mode === 'edit' ? (users.data.find((u) => u.id === edit.user.id) ?? edit.user) : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">Benutzer können buchen und Personen verwalten.</p>
        <Button
          variant="primary"
          icon={<UserPlus className="size-5" aria-hidden />}
          onClick={() => setEdit({ mode: 'create' })}
          className="shrink-0"
        >
          Neuer Benutzer
        </Button>
      </div>

      {users.data.length === 0 ? (
        <EmptyState title="Keine Benutzer" />
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-3xl border border-line bg-surface">
          {users.data.map((user) => (
            <li key={user.id} data-testid="user-row" data-username={user.username}>
              <button
                type="button"
                onClick={() => setEdit({ mode: 'edit', user })}
                aria-label={`${user.username} bearbeiten`}
                className="flex min-h-16 w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-surface-2"
              >
                <span
                  aria-hidden
                  className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-base font-bold text-on-primary-soft uppercase"
                >
                  {(user.name || user.username).slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block truncate font-semibold ${user.disabled ? 'text-muted line-through' : ''}`}>
                    {user.username}
                  </span>
                  {user.name ? <span className="block truncate text-sm text-muted">{user.name}</span> : null}
                </span>
                <span className="flex max-w-[45%] flex-wrap justify-end gap-1">
                  {user.id === me?.id ? <Badge tone="success">Du</Badge> : null}
                  {user.role === 'admin' ? <Badge tone="primary">Admin</Badge> : null}
                  {user.disabled ? <Badge tone="danger">Deaktiviert</Badge> : null}
                  {user.mustChangePassword ? <Badge tone="warning">Passwort ändern</Badge> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={edit !== null}
        onClose={() => setEdit(null)}
        title={editedUser ? `Benutzer ${editedUser.username}` : 'Neuer Benutzer'}
        testId="user-dialog"
      >
        {edit?.mode === 'create' ? (
          <CreateUserForm users={users.data} onDone={() => setEdit(null)} />
        ) : editedUser ? (
          <EditUserForm
            key={editedUser.id}
            user={editedUser}
            isSelf={editedUser.id === me?.id}
            hasBookings={withBookings.has(editedUser.id)}
            referencesLoaded={references.isSuccess}
            onDone={() => setEdit(null)}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

function CreateUserForm({ users, onDone }: { users: UserRecord[]; onDone: () => void }) {
  const createUser = useCreateUser();
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [role, setRole] = useState<Role>('user');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = normalizeUsername(username);
    const next: Record<string, string | undefined> = {};
    if (normalized.length < 3 || normalized.length > 32) next.username = 'Der Benutzername muss 3–32 Zeichen lang sein.';
    else if (!USERNAME_PATTERN.test(normalized)) next.username = 'Nur Kleinbuchstaben, Ziffern, „.“, „_“ und „-“ erlaubt.';
    else if (users.some((u) => u.username === normalized)) next.username = 'Dieser Benutzername ist bereits vergeben.';
    if (name.trim().length > 100) next.name = 'Höchstens 100 Zeichen erlaubt.';
    if (password.length < MIN_PASSWORD) next.password = `Das Passwort muss mindestens ${MIN_PASSWORD} Zeichen lang sein.`;
    if (password !== passwordConfirm) next.passwordConfirm = 'Die Passwörter stimmen nicht überein.';
    setErrors(next);
    setFormError(null);
    if (Object.values(next).some(Boolean)) return;
    try {
      await createUser.mutateAsync({ username: normalized, name: name.trim(), password, passwordConfirm, role });
      toast.success(`Benutzer ${normalized} angelegt`);
      onDone();
    } catch (error) {
      const info = describeError(error, 'users');
      setErrors(info.fieldErrors);
      setFormError(info.message);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} noValidate className="space-y-4">
      <TextField
        label="Benutzername"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        error={errors.username}
        hint="3–32 Zeichen: Kleinbuchstaben, Ziffern, . _ -"
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        maxLength={32}
        dialogAutoFocus
        required
      />
      <TextField
        label="Name (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={errors.name}
        autoComplete="off"
        maxLength={100}
      />
      <TextField
        label="Startpasswort"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={errors.password}
        hint="Mindestens 8 Zeichen. Muss beim ersten Login geändert werden."
        autoComplete="new-password"
        required
      />
      <TextField
        label="Passwort wiederholen"
        type="password"
        value={passwordConfirm}
        onChange={(e) => setPasswordConfirm(e.target.value)}
        error={errors.passwordConfirm}
        autoComplete="new-password"
        required
      />
      <SelectField label="Rolle" value={role} onChange={(e) => setRole(e.target.value as Role)} error={errors.role}>
        <option value="user">{ROLE_LABELS.user}</option>
        <option value="admin">{ROLE_LABELS.admin}</option>
      </SelectField>
      <FormError message={formError} />
      <div className="flex gap-3 pt-1">
        <Button block onClick={onDone}>
          Abbrechen
        </Button>
        <Button type="submit" block variant="primary" loading={createUser.isPending}>
          Anlegen
        </Button>
      </div>
    </form>
  );
}

function EditUserForm({
  user,
  isSelf,
  hasBookings,
  referencesLoaded,
  onDone,
}: {
  user: UserRecord;
  isSelf: boolean;
  hasBookings: boolean;
  referencesLoaded: boolean;
  onDone: () => void;
}) {
  const updateUser = useUpdateUser();
  const deleteUser = useDeleteUser();
  // Values the form started with (the live `user` may change meanwhile).
  const [initial] = useState(() => ({ name: user.name, role: user.role, disabled: user.disabled }));
  const [name, setName] = useState(initial.name);
  const [role, setRole] = useState<Role>(initial.role);
  const [active, setActive] = useState(!initial.disabled);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [passwordErrors, setPasswordErrors] = useState<Record<string, string | undefined>>({});
  const [passwordFormError, setPasswordFormError] = useState<string | null>(null);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    if (name.trim().length > 100) {
      setErrors({ name: 'Höchstens 100 Zeichen erlaubt.' });
      return;
    }
    setErrors({});
    // only changed fields (own role/deactivation can't be changed anyway)
    const input: UpdateUserInput = isSelf
      ? changedFields({ name: initial.name }, { name: name.trim() })
      : changedFields(initial, { name: name.trim(), role, disabled: !active });
    try {
      if (!isEmptyPatch(input)) await updateUser.mutateAsync({ id: user.id, input });
      toast.success('Benutzer gespeichert');
      onDone();
    } catch (error) {
      const info = describeError(error, 'users');
      setErrors(info.fieldErrors);
      setFormError(info.message);
    }
  }

  async function handlePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordFormError(null);
    const next: Record<string, string | undefined> = {};
    if (password.length < MIN_PASSWORD) next.password = `Das Passwort muss mindestens ${MIN_PASSWORD} Zeichen lang sein.`;
    if (password !== passwordConfirm) next.passwordConfirm = 'Die Passwörter stimmen nicht überein.';
    setPasswordErrors(next);
    if (Object.values(next).some(Boolean)) return;
    setPasswordBusy(true);
    try {
      await updateUser.mutateAsync({ id: user.id, input: { password, passwordConfirm } });
      toast.success(`Passwort für ${user.username} gesetzt`, {
        description: 'Muss beim nächsten Login geändert werden.',
      });
      setPassword('');
      setPasswordConfirm('');
    } catch (error) {
      const info = describeError(error, 'users');
      setPasswordErrors(info.fieldErrors);
      setPasswordFormError(info.message);
    } finally {
      setPasswordBusy(false);
    }
  }

  async function handleDelete() {
    setDeleteError(null);
    try {
      await deleteUser.mutateAsync(user.id);
      toast.success(`Benutzer ${user.username} gelöscht`);
      setConfirmDelete(false);
      onDone();
    } catch (error) {
      setDeleteError(errorMessage(error, 'users'));
    }
  }

  const deleteBlockedReason = isSelf
    ? 'Du kannst dich nicht selbst löschen.'
    : hasBookings
      ? 'Hat Buchungen erfasst – stattdessen deaktivieren.'
      : null;

  return (
    <div className="space-y-6">
      <form onSubmit={(e) => void handleSave(e)} noValidate className="space-y-4">
        <TextField
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={errors.name}
          autoComplete="off"
          maxLength={100}
        />
        <SelectField
          label="Rolle"
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          disabled={isSelf}
          error={errors.role}
          hint={isSelf ? 'Du kannst deine eigene Rolle nicht ändern.' : undefined}
        >
          <option value="user">{ROLE_LABELS.user}</option>
          <option value="admin">{ROLE_LABELS.admin}</option>
        </SelectField>
        <SwitchField
          label="Konto aktiv"
          description={
            isSelf
              ? 'Du kannst dein eigenes Konto nicht deaktivieren.'
              : 'Deaktivierte Benutzer können sich nicht mehr anmelden.'
          }
          checked={active}
          onChange={setActive}
          disabled={isSelf}
        />
        <FormError message={formError} />
        <div className="flex gap-3">
          <Button block onClick={onDone}>
            Abbrechen
          </Button>
          <Button type="submit" block variant="primary" loading={updateUser.isPending && !passwordBusy}>
            Speichern
          </Button>
        </div>
      </form>

      {isSelf ? (
        <p className="border-t border-line pt-5 text-sm text-muted">
          Dein eigenes Passwort änderst du unter{' '}
          <Link to="/konto#passwort" className="font-semibold text-primary underline underline-offset-4">
            Konto
          </Link>
          .
        </p>
      ) : (
        <form
          onSubmit={(e) => void handlePassword(e)}
          noValidate
          className="space-y-4 border-t border-line pt-5"
          aria-labelledby="reset-password-heading"
        >
          <h3 id="reset-password-heading" className="font-semibold">
            Passwort zurücksetzen
          </h3>
          <TextField
            label="Neues Passwort"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={passwordErrors.password}
            hint="Mindestens 8 Zeichen."
            autoComplete="new-password"
          />
          <TextField
            label="Neues Passwort wiederholen"
            type="password"
            value={passwordConfirm}
            onChange={(e) => setPasswordConfirm(e.target.value)}
            error={passwordErrors.passwordConfirm}
            autoComplete="new-password"
          />
          <FormError message={passwordFormError} />
          <Button type="submit" icon={<KeyRound className="size-5" aria-hidden />} loading={passwordBusy}>
            Passwort setzen
          </Button>
        </form>
      )}

      <div className="border-t border-line pt-5">
        <Button
          variant="danger-soft"
          icon={<Trash className="size-5" aria-hidden />}
          disabled={Boolean(deleteBlockedReason) || !referencesLoaded}
          onClick={() => setConfirmDelete(true)}
        >
          Benutzer löschen
        </Button>
        {deleteBlockedReason ? (
          <p className="mt-2 text-sm text-muted" data-testid="delete-hint">
            {deleteBlockedReason}
          </p>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Benutzer löschen?"
        message={
          <p>
            <strong>{user.username}</strong> wird endgültig gelöscht.
          </p>
        }
        confirmLabel="Löschen"
        loading={deleteUser.isPending}
        error={deleteError}
        onConfirm={() => void handleDelete()}
        onClose={() => {
          setConfirmDelete(false);
          setDeleteError(null);
        }}
      />
    </div>
  );
}
