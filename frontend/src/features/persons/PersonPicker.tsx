/**
 * Full-screen person picker: search (number / name / nickname), QR scan or
 * create a new person. Used by the booking screen.
 */
import { useQueryClient } from '@tanstack/react-query';
import { Check, ScanLine, Search, UserPlus } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { queryKeys, usePersons } from '../../api/queries';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { EmptyState, NumberBadge, QueryError } from '../../components/ui/Feedback';
import { Spinner } from '../../components/ui/Spinner';
import { findPersonByNumber, isValidPersonNumber, searchPersons } from '../../lib/search';
import type { PersonRecord } from '../../lib/types';
import { vibrate, VIBRATE_ERROR, VIBRATE_SUCCESS } from '../../lib/vibrate';
import { PersonForm } from './PersonForm';

const QrScanner = lazy(() => import('../scanner/QrScanner'));

const MAX_RESULTS = 60;

export type PickerMode = 'search' | 'scan' | 'create';

interface PersonPickerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (person: PersonRecord) => void;
  initialMode?: 'search' | 'scan';
  /** Name of the offering that will be booked right after selecting. */
  pendingOfferingName?: string | null;
  selectedPersonId?: string | null;
}

export function PersonPicker(props: PersonPickerProps) {
  if (!props.open) return null;
  return <PersonPickerDialog {...props} />;
}

const TITLES: Record<PickerMode, string> = {
  search: 'Person wählen',
  scan: 'QR-Code scannen',
  create: 'Neue Person',
};

function PersonPickerDialog({
  onClose,
  onSelect,
  initialMode = 'search',
  pendingOfferingName,
  selectedPersonId,
}: PersonPickerProps) {
  const persons = usePersons();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<PickerMode>(initialMode);
  const [returnMode, setReturnMode] = useState<'search' | 'scan'>(initialMode);
  const [query, setQuery] = useState('');
  const [createNumber, setCreateNumber] = useState('');
  const [unknownCode, setUnknownCode] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);

  const all = useMemo(() => persons.data ?? [], [persons.data]);
  const results = useMemo(() => searchPersons(all, query), [all, query]);

  // Move focus to the new view when switching modes (initial focus is handled by the dialog).
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    bodyRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, [mode]);

  function select(person: PersonRecord) {
    vibrate(VIBRATE_SUCCESS);
    onSelect(person);
  }

  function startCreate(number: string, from: 'search' | 'scan') {
    setCreateNumber(number);
    setReturnMode(from);
    setMode('create');
  }

  function handleDetected(value: string) {
    const person = findPersonByNumber(all, value);
    if (person) {
      select(person);
      return;
    }
    vibrate(VIBRATE_ERROR);
    setUnknownCode(value);
    // Maybe the person was just created on another device.
    void queryClient.invalidateQueries({ queryKey: queryKeys.persons });
  }

  function handleEnter() {
    const exact = findPersonByNumber(all, query);
    const target = exact ?? (results.length === 1 ? results[0] : undefined);
    if (target) select(target);
  }

  const trimmedQuery = query.trim();
  const canCreateFromQuery = isValidPersonNumber(trimmedQuery) && !findPersonByNumber(all, trimmedQuery);

  return (
    <Dialog
      open
      onClose={onClose}
      title={TITLES[mode]}
      variant="fullscreen"
      testId="person-picker"
    >
      <div ref={bodyRef} className="space-y-4">
        {pendingOfferingName && mode !== 'create' ? (
          <p className="rounded-2xl bg-primary-soft px-4 py-3 text-sm text-on-primary-soft" data-testid="pending-offering">
            Nach der Auswahl wird <strong>{pendingOfferingName}</strong> gebucht.
          </p>
        ) : null}

        {mode === 'search' ? (
          <>
            <div className="sticky -top-4 z-10 -mx-4 -mt-4 space-y-3 bg-surface px-4 pt-4 pb-3">
              <label className="relative block">
                <span className="sr-only">Nummer, Name oder Nickname</span>
                <Search className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-muted" aria-hidden />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleEnter();
                    }
                  }}
                  placeholder="Nummer, Name oder Nickname"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  enterKeyHint="go"
                  data-autofocus=""
                  data-testid="person-search"
                  className="block h-14 w-full rounded-2xl border border-line-strong bg-surface pr-4 pl-11 text-lg shadow-sm focus:border-primary focus:outline-2 focus:outline-offset-0 focus:outline-primary/40"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="soft"
                  icon={<ScanLine className="size-5" aria-hidden />}
                  onClick={() => {
                    setUnknownCode(null);
                    setMode('scan');
                  }}
                >
                  QR scannen
                </Button>
                <Button
                  icon={<UserPlus className="size-5" aria-hidden />}
                  onClick={() => startCreate(isValidPersonNumber(trimmedQuery) ? trimmedQuery : '', 'search')}
                >
                  Neue Person
                </Button>
              </div>
            </div>

            {persons.isPending ? (
              <div className="flex justify-center py-8 text-primary">
                <Spinner label="Personen werden geladen …" />
              </div>
            ) : persons.isError ? (
              <QueryError error={persons.error} onRetry={() => void persons.refetch()} />
            ) : results.length === 0 ? (
              <EmptyState title={all.length === 0 ? 'Noch keine Personen' : 'Keine Person gefunden'}>
                {canCreateFromQuery ? (
                  <Button
                    variant="primary"
                    className="mt-2"
                    icon={<UserPlus className="size-5" aria-hidden />}
                    onClick={() => startCreate(trimmedQuery, 'search')}
                  >
                    Person {trimmedQuery} anlegen
                  </Button>
                ) : all.length === 0 ? (
                  'Lege die erste Person an.'
                ) : (
                  'Suche nach Nummer, Name oder Nickname.'
                )}
              </EmptyState>
            ) : (
              <ul aria-label="Personen" className="-mx-2 space-y-1">
                {results.slice(0, MAX_RESULTS).map((person) => {
                  const selected = person.id === selectedPersonId;
                  return (
                    <li key={person.id}>
                      <button
                        type="button"
                        data-testid="person-option"
                        data-person-number={person.number}
                        aria-current={selected || undefined}
                        onClick={() => select(person)}
                        className="flex min-h-14 w-full items-center gap-3 rounded-2xl px-2 py-2 text-left transition-colors hover:bg-surface-2 active:bg-surface-3"
                      >
                        <NumberBadge number={person.number} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-base font-semibold">
                            {person.name || <span className="text-muted">Ohne Namen</span>}
                          </span>
                          {person.nickname ? (
                            <span className="block truncate text-sm text-muted">„{person.nickname}“</span>
                          ) : null}
                        </span>
                        {selected ? <Check className="size-5 text-primary" aria-label="ausgewählt" /> : null}
                      </button>
                    </li>
                  );
                })}
                {results.length > MAX_RESULTS ? (
                  <li className="px-2 py-3 text-center text-sm text-muted">
                    … und {results.length - MAX_RESULTS} weitere – bitte die Suche verfeinern.
                  </li>
                ) : null}
              </ul>
            )}
          </>
        ) : null}

        {mode === 'scan' ? (
          <div className="space-y-4">
            <Suspense
              fallback={
                <div className="flex aspect-[3/4] max-h-[62dvh] w-full items-center justify-center rounded-3xl bg-black text-white sm:aspect-square">
                  <Spinner className="size-8" label="Scanner wird geladen …" />
                </div>
              }
            >
              <QrScanner
                onDetected={handleDetected}
                footer={
                  unknownCode ? (
                    <div
                      role="status"
                      data-testid="scan-unknown"
                      className="rounded-2xl bg-warning-soft p-4 text-on-warning-soft"
                    >
                      {isValidPersonNumber(unknownCode) ? (
                        <>
                          <p className="text-base font-semibold">
                            Nummer <strong>{unknownCode}</strong> nicht gefunden
                          </p>
                          <p className="mt-1 text-sm">Scanne einen anderen Code oder lege die Person an.</p>
                          <Button
                            variant="primary"
                            className="mt-3"
                            icon={<UserPlus className="size-5" aria-hidden />}
                            onClick={() => startCreate(unknownCode, 'scan')}
                          >
                            Person {unknownCode} anlegen
                          </Button>
                        </>
                      ) : (
                        <p className="text-base font-semibold">Dieser QR-Code enthält keine gültige Personennummer.</p>
                      )}
                    </div>
                  ) : (
                    <p className="text-center text-base text-muted" aria-live="polite">
                      Halte den QR-Code der Person in den Rahmen.
                    </p>
                  )
                }
              />
            </Suspense>
            <Button block icon={<Search className="size-5" aria-hidden />} onClick={() => setMode('search')}>
              Stattdessen suchen
            </Button>
          </div>
        ) : null}

        {mode === 'create' ? (
          <PersonForm
            initialNumber={createNumber}
            submitLabel="Anlegen und auswählen"
            onCancel={() => setMode(returnMode)}
            onSaved={select}
          />
        ) : null}
      </div>
    </Dialog>
  );
}
