/**
 * Person filter of Buchungen: a field showing the selected person (or "Alle
 * Personen") that opens the person picker – search by number, name or
 * nickname, or scan the QR code, like on Buchen. "×" goes back to all
 * persons. It replaces a <select> with one <option> per person, which
 * rendered all 2000 persons on every render of the page and was hard to use
 * with that many entries (docs/LOADTEST-FINDINGS.md F5).
 */
import { ChevronDown, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { usePersons } from '../../api/queries';
import { cn } from '../../components/ui/cn';
import { personLabel } from '../../lib/search';
import { PersonPicker } from '../persons/PersonPicker';

export function PersonFilter({
  personId,
  onChange,
  className,
}: {
  /** Selected person id, '' = all persons. */
  personId: string;
  onChange: (personId: string) => void;
  className?: string;
}) {
  const persons = usePersons();
  const [picking, setPicking] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const person = useMemo(
    () => (personId ? persons.data?.find((p) => p.id === personId) : undefined),
    [persons.data, personId],
  );
  const label = !personId
    ? 'Alle Personen'
    : person
      ? personLabel(person)
      : persons.isPending
        ? '…'
        : 'Unbekannte Person';

  return (
    <div className={cn('relative min-w-0', className)}>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-label={`Person: ${label}`}
        onClick={() => setPicking(true)}
        data-testid="person-filter"
        data-person-id={personId}
        className={cn(
          'flex min-h-12 w-full items-center gap-2 rounded-xl border border-line-strong bg-surface pl-3.5 text-left text-base text-fg shadow-sm transition-colors hover:bg-surface-2 active:bg-surface-3',
          personId ? 'pr-12' : 'pr-3',
        )}
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {personId ? null : <ChevronDown className="size-5 shrink-0 text-muted" aria-hidden />}
      </button>
      {personId ? (
        <button
          type="button"
          aria-label="Alle Personen anzeigen"
          title="Alle Personen anzeigen"
          onClick={() => {
            onChange('');
            trigger.current?.focus();
          }}
          data-testid="person-filter-clear"
          className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-xl text-muted transition-colors hover:text-fg active:text-fg"
        >
          <X className="size-5" aria-hidden />
        </button>
      ) : null}
      <PersonPicker
        open={picking}
        onClose={() => setPicking(false)}
        onSelect={(selected) => {
          setPicking(false);
          onChange(selected.id);
        }}
        selectedPersonId={personId || null}
        allowCreate={false}
      />
    </div>
  );
}
