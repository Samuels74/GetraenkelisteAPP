import { useState, type FormEvent } from 'react';
import { useCreatePerson, useUpdatePerson, type PersonInput } from '../../api/mutations';
import { usePersons } from '../../api/queries';
import { Button } from '../../components/ui/Button';
import { FormError, TextField } from '../../components/ui/Field';
import { changedFields, isEmptyPatch } from '../../lib/diff';
import { describeError } from '../../lib/errors';
import { findPersonByNumber, PERSON_NUMBER_PATTERN } from '../../lib/search';
import type { PersonRecord } from '../../lib/types';

interface PersonFormProps {
  /** Edit this person; create a new one when omitted. */
  person?: PersonRecord | null;
  initialNumber?: string;
  submitLabel?: string;
  onSaved: (person: PersonRecord) => void;
  onCancel: () => void;
}

type Errors = Partial<Record<'number' | 'name' | 'nickname', string>>;

export function PersonForm({ person, initialNumber = '', submitLabel, onSaved, onCancel }: PersonFormProps) {
  const persons = usePersons();
  const createPerson = useCreatePerson();
  const updatePerson = useUpdatePerson();
  // Values the form started with: updates send only what differs from them
  // (the live `person` may already contain changes from other devices).
  const [initial] = useState<PersonInput>(() => ({
    number: person?.number ?? initialNumber,
    name: person?.name ?? '',
    nickname: person?.nickname ?? '',
  }));
  const [number, setNumber] = useState(initial.number);
  const [name, setName] = useState(initial.name);
  const [nickname, setNickname] = useState(initial.nickname);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const busy = createPerson.isPending || updatePerson.isPending;

  function validate(input: { number: string; name: string; nickname: string }): Errors {
    const result: Errors = {};
    if (!input.number) result.number = 'Bitte eine Nummer eingeben.';
    else if (input.number.length > 20) result.number = 'Höchstens 20 Zeichen erlaubt.';
    else if (!PERSON_NUMBER_PATTERN.test(input.number))
      result.number = 'Nur Buchstaben, Ziffern, „-“ und „_“ erlaubt (keine Leerzeichen).';
    else {
      const existing = findPersonByNumber(persons.data ?? [], input.number);
      if (existing && existing.id !== person?.id) result.number = 'Diese Nummer ist bereits vergeben.';
    }
    if (input.name.length > 100) result.name = 'Höchstens 100 Zeichen erlaubt.';
    if (input.nickname.length > 100) result.nickname = 'Höchstens 100 Zeichen erlaubt.';
    return result;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = { number: number.trim(), name: name.trim(), nickname: nickname.trim() };
    const clientErrors = validate(input);
    setErrors(clientErrors);
    setFormError(null);
    if (Object.keys(clientErrors).length > 0) return;
    try {
      let saved: PersonRecord;
      if (person) {
        // only changed fields – never overwrite concurrent edits with stale values
        const patch = changedFields(initial, input);
        saved = isEmptyPatch(patch) ? person : await updatePerson.mutateAsync({ id: person.id, input: patch });
      } else {
        saved = await createPerson.mutateAsync(input);
      }
      onSaved(saved);
    } catch (error) {
      const info = describeError(error, 'persons');
      const known = (['number', 'name', 'nickname'] as const).filter((f) => info.fieldErrors[f]);
      setErrors(Object.fromEntries(known.map((f) => [f, info.fieldErrors[f]])));
      setFormError(known.length === Object.keys(info.fieldErrors).length && known.length > 0 ? null : info.message);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} noValidate className="space-y-4" data-testid="person-form">
      <TextField
        label="Nummer"
        name="number"
        value={number}
        onChange={(e) => setNumber(e.target.value)}
        error={errors.number}
        hint="Wird im QR-Code gespeichert, z. B. 001"
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        maxLength={20}
        enterKeyHint="next"
        dialogAutoFocus={!initialNumber}
        required
      />
      <TextField
        label="Name"
        name="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={errors.name}
        autoComplete="off"
        maxLength={100}
        enterKeyHint="next"
        dialogAutoFocus={Boolean(initialNumber)}
      />
      <TextField
        label="Nickname"
        name="nickname"
        value={nickname}
        onChange={(e) => setNickname(e.target.value)}
        error={errors.nickname}
        autoComplete="off"
        maxLength={100}
        enterKeyHint="done"
      />
      <FormError message={formError} />
      <div className="flex gap-3 pt-1">
        <Button block onClick={onCancel}>
          Abbrechen
        </Button>
        <Button type="submit" block variant="primary" loading={busy}>
          {submitLabel ?? (person ? 'Speichern' : 'Anlegen')}
        </Button>
      </div>
    </form>
  );
}
