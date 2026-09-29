import { ArrowLeft, Beer, ChevronRight, Download, Pencil, Printer, Trash, UserX } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { useDeletePerson } from '../../api/mutations';
import { usePersons, useRecentBookings, useTotals } from '../../api/queries';
import { useCurrentUser } from '../../auth/session';
import { QrCode } from '../../components/QrCode';
import { Button, ButtonLink, IconButton } from '../../components/ui/Button';
import { ConfirmDialog, Dialog } from '../../components/ui/Dialog';
import { Card, EmptyState, QueryError } from '../../components/ui/Feedback';
import { PageHeader } from '../../components/ui/PageHeader';
import { PageSpinner } from '../../components/ui/Spinner';
import { downloadBlob } from '../../lib/download';
import { errorMessage } from '../../lib/errors';
import { formatCents } from '../../lib/money';
import { canCancelBooking, canDeletePersons } from '../../lib/permissions';
import { qrCardPngBlob, qrFileName } from '../../lib/qr';
import { useDocumentTitle } from '../../lib/useDocumentTitle';
import type { BookingRecord, PersonRecord } from '../../lib/types';
import { setSelectedPersonId } from '../book/selectedPerson';
import { BookingItem } from '../bookings/BookingItem';
import { CancelBookingDialog } from '../bookings/CancelBookingDialog';
import { PersonForm } from './PersonForm';

export function PersonDetailPage() {
  const { personId = '' } = useParams();
  const persons = usePersons();
  const person = persons.data?.find((p) => p.id === personId);

  if (persons.isPending) return <PageSpinner />;
  if (persons.isError) return <QueryError error={persons.error} onRetry={() => void persons.refetch()} className="mt-6" />;
  if (!person) {
    return (
      <EmptyState icon={<UserX className="size-7" aria-hidden />} title="Person nicht gefunden" className="pt-16">
        <p>Vielleicht wurde sie gelöscht.</p>
        <ButtonLink to="/personen" className="mt-4">
          Zu den Personen
        </ButtonLink>
      </EmptyState>
    );
  }
  return <PersonDetail key={person.id} person={person} />;
}

function PersonDetail({ person }: { person: PersonRecord }) {
  useDocumentTitle(`Person ${person.number}`);
  const user = useCurrentUser();
  const navigate = useNavigate();
  const location = useLocation();
  const justCreated = (location.state as { created?: boolean } | null)?.created === true;
  const totals = useTotals({ period: 'all', personId: person.id });
  const recent = useRecentBookings(person.id, 20);
  const deletePerson = useDeletePerson();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<BookingRecord | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [now] = useState(() => new Date());

  const hasBookings = (totals.data?.count ?? 0) > 0;
  const subtitle = [person.name, person.nickname ? `„${person.nickname}“` : ''].filter(Boolean).join(' ');

  async function downloadPng() {
    setDownloading(true);
    try {
      const blob = await qrCardPngBlob({
        value: person.number,
        title: person.number,
        subtitle: [person.name, person.nickname ? `„${person.nickname}“` : ''].filter(Boolean).join(' '),
      });
      downloadBlob(blob, qrFileName(person.number));
    } catch {
      toast.error('Das Bild konnte nicht erstellt werden.');
    } finally {
      setDownloading(false);
    }
  }

  async function handleDelete() {
    setDeleteError(null);
    try {
      await deletePerson.mutateAsync(person.id);
      setConfirmDelete(false);
      toast.success(`Person ${person.number} gelöscht`);
      void navigate('/personen', { replace: true });
    } catch (error) {
      setDeleteError(errorMessage(error, 'persons'));
    }
  }

  return (
    <div className="space-y-4 pb-4">
      <PageHeader
        back={
          <IconButton label="Zurück zu den Personen" onClick={() => void navigate('/personen')} className="-ml-3">
            <ArrowLeft className="size-6" aria-hidden />
          </IconButton>
        }
        title={<span data-testid="person-number">Person {person.number}</span>}
        subtitle={subtitle || undefined}
        actions={
          <Button icon={<Pencil className="size-5" aria-hidden />} onClick={() => setEditing(true)}>
            Bearbeiten
          </Button>
        }
      />

      {justCreated ? (
        <p role="status" className="rounded-2xl bg-success-soft px-4 py-3 text-sm font-medium text-on-success-soft">
          Person angelegt. Du kannst den QR-Code jetzt herunterladen oder ausdrucken.
        </p>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="flex flex-col items-center gap-4 p-4">
          <div className="rounded-2xl bg-white p-3 ring-1 ring-black/10">
            <QrCode value={person.number} margin={1} className="size-52 sm:size-60" />
          </div>
          <div className="grid w-full grid-cols-2 gap-2">
            <Button
              icon={<Download className="size-5" aria-hidden />}
              loading={downloading}
              onClick={() => void downloadPng()}
            >
              PNG
            </Button>
            <ButtonLink
              to={`/personen/qr-codes?ids=${encodeURIComponent(person.id)}&drucken=1`}
              icon={<Printer className="size-5" aria-hidden />}
            >
              Drucken
            </ButtonLink>
          </div>
        </Card>

        <div className="space-y-4">
          <Button
            variant="primary"
            size="lg"
            block
            icon={<Beer className="size-6" aria-hidden />}
            onClick={() => {
              setSelectedPersonId(person.id);
              void navigate('/');
            }}
          >
            Für diese Person buchen
          </Button>

          <Card className="p-4">
            <p className="text-sm font-medium text-muted">Gesamt (alle Buchungen)</p>
            <p className="text-3xl font-bold tabular-nums" data-testid="person-total">
              {totals.data ? formatCents(totals.data.totalCents) : '…'}
            </p>
            {totals.data ? (
              <p className="text-sm text-muted">
                {totals.data.count} {totals.data.count === 1 ? 'Buchung' : 'Buchungen'}
              </p>
            ) : null}
          </Card>
        </div>
      </div>

      <section aria-labelledby="person-bookings-heading">
        <div className="mb-2 flex items-center justify-between px-1">
          <h2 id="person-bookings-heading" className="text-sm font-bold tracking-wide text-muted uppercase">
            Letzte Buchungen
          </h2>
          <Link
            to={`/buchungen?person=${encodeURIComponent(person.id)}`}
            className="-my-2 inline-flex min-h-12 items-center gap-1 px-1 text-sm font-semibold text-primary"
          >
            Alle anzeigen <ChevronRight className="size-4" aria-hidden />
          </Link>
        </div>
        {recent.isError ? (
          <QueryError error={recent.error} onRetry={() => void recent.refetch()} />
        ) : recent.data && recent.data.length > 0 ? (
          <ul className="divide-y divide-line overflow-hidden rounded-3xl border border-line bg-surface">
            {recent.data.map((booking) => (
              <BookingItem
                key={booking.id}
                booking={booking}
                now={now}
                canCancel={canCancelBooking(user, booking)}
                onCancel={setCancelTarget}
              />
            ))}
          </ul>
        ) : recent.isPending ? null : (
          <p className="rounded-3xl border border-dashed border-line-strong px-4 py-6 text-center text-muted">
            Noch keine Buchungen.
          </p>
        )}
      </section>

      {canDeletePersons(user) ? (
        <section className="rounded-3xl border border-line p-4" aria-labelledby="delete-person-heading">
          <h2 id="delete-person-heading" className="font-semibold">
            Person löschen
          </h2>
          <p className="mt-1 text-sm text-muted" data-testid="delete-person-hint">
            {hasBookings
              ? 'Diese Person hat Buchungen und kann nicht gelöscht werden.'
              : 'Nur möglich, solange die Person keine Buchungen hat.'}
          </p>
          <Button
            variant="danger-soft"
            className="mt-3"
            icon={<Trash className="size-5" aria-hidden />}
            disabled={hasBookings || !totals.data}
            onClick={() => setConfirmDelete(true)}
          >
            Löschen
          </Button>
        </section>
      ) : null}

      <Dialog open={editing} onClose={() => setEditing(false)} title="Person bearbeiten" testId="person-dialog">
        <PersonForm
          person={person}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            toast.success('Gespeichert');
          }}
        />
      </Dialog>
      <ConfirmDialog
        open={confirmDelete}
        title="Person löschen?"
        message={
          <p>
            <strong>{person.number}</strong> {subtitle} wird endgültig gelöscht. Gedruckte QR-Codes funktionieren dann nicht
            mehr.
          </p>
        }
        confirmLabel="Löschen"
        loading={deletePerson.isPending}
        error={deleteError}
        onConfirm={() => void handleDelete()}
        onClose={() => {
          setConfirmDelete(false);
          setDeleteError(null);
        }}
      />
      <CancelBookingDialog booking={cancelTarget} onClose={() => setCancelTarget(null)} />
    </div>
  );
}
