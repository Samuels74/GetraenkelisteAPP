import { ClientResponseError } from 'pocketbase';
import { describeError, errorMessage, isGenericEnglishMessage, isUnauthorized } from './errors';

function pbError(status: number, message: string, data: Record<string, unknown> = {}): ClientResponseError {
  return new ClientResponseError({ url: 'http://x/api', status, response: { status, message, data } });
}

describe('describeError', () => {
  it('passes German hook messages through', () => {
    const msg = 'Dieses Angebot hat bereits Buchungen und kann nicht gelöscht werden. Deaktiviere es stattdessen.';
    expect(errorMessage(pbError(400, msg), 'offerings')).toBe(msg);
  });

  it('maps validation_not_unique on persons.number', () => {
    const info = describeError(
      pbError(400, 'Failed to create record.', {
        number: { code: 'validation_not_unique', message: 'Value must be unique.' },
      }),
      'persons',
    );
    expect(info.fieldErrors).toEqual({ number: 'Diese Nummer ist bereits vergeben.' });
    expect(info.message).toBe('Diese Nummer ist bereits vergeben.');
    expect(info.status).toBe(400);
  });

  it('maps not-unique errors of other collections', () => {
    expect(
      errorMessage(pbError(400, 'Failed to create record.', { username: { code: 'validation_not_unique' } }), 'users'),
    ).toBe('Dieser Benutzername ist bereits vergeben.');
    expect(
      errorMessage(pbError(400, 'Failed to create record.', { name: { code: 'validation_not_unique' } }), 'groups'),
    ).toBe('Eine Gruppe mit diesem Namen gibt es bereits.');
  });

  it('deduplicates composite unique index errors', () => {
    const info = describeError(
      pbError(400, 'Failed to create record.', {
        name: { code: 'validation_not_unique', message: 'Value must be unique.' },
        group: { code: 'validation_not_unique', message: 'Value must be unique.' },
      }),
      'offerings',
    );
    expect(info.message).toBe('Ein Angebot mit diesem Namen gibt es in dieser Gruppe bereits.');
  });

  it('prefixes generic field messages with the field label', () => {
    const info = describeError(
      pbError(400, 'Failed to create record.', {
        name: { code: 'validation_max_text_constraint', message: 'Must be less than 100 character(s).', params: { max: 100 } },
        number: { code: 'validation_required', message: 'Cannot be blank.' },
      }),
      'persons',
    );
    expect(info.fieldErrors).toEqual({
      name: 'Höchstens 100 Zeichen erlaubt.',
      number: 'Dieses Feld ist erforderlich.',
    });
    expect(info.message).toBe('Name: Höchstens 100 Zeichen erlaubt. Nummer: Dieses Feld ist erforderlich.');
  });

  it('maps password errors', () => {
    const info = describeError(
      pbError(400, 'Failed to update record.', {
        password: { code: 'validation_min_text_constraint', message: 'Must be at least 8 character(s).', params: { min: 8 } },
        passwordConfirm: { code: 'validation_values_mismatch', message: "Values don't match." },
        oldPassword: { code: 'validation_invalid_old_password', message: 'Missing or invalid old password.' },
      }),
      'account',
    );
    expect(info.fieldErrors).toEqual({
      password: 'Das Passwort muss mindestens 8 Zeichen lang sein.',
      passwordConfirm: 'Die Passwörter stimmen nicht überein.',
      oldPassword: 'Das aktuelle Passwort ist falsch.',
    });
  });

  it('maps invalid formats with context', () => {
    expect(
      describeError(
        pbError(400, 'Failed to create record.', { number: { code: 'validation_invalid_format', message: 'Invalid value format.' } }),
        'persons',
      ).fieldErrors.number,
    ).toContain('Nur Buchstaben, Ziffern');
  });

  it('keeps German messages of unknown field codes but hides English ones', () => {
    expect(
      describeError(pbError(400, 'Failed', { x: { code: 'custom', message: 'Bitte eine Zahl eingeben.' } })).fieldErrors.x,
    ).toBe('Bitte eine Zahl eingeben.');
    expect(describeError(pbError(400, 'Failed', { x: { code: 'custom', message: 'Must be foo.' } })).fieldErrors.x).toBe(
      'Ungültiger Wert.',
    );
  });

  it('replaces generic English messages by status', () => {
    expect(errorMessage(pbError(403, 'The authorized record is not allowed to perform this action.'))).toBe(
      'Dafür fehlt dir die Berechtigung.',
    );
    expect(errorMessage(pbError(404, "The requested resource wasn't found."))).toContain('Nicht gefunden');
    expect(errorMessage(pbError(401, 'The request requires valid record authorization token.'))).toContain(
      'Sitzung ist abgelaufen',
    );
    expect(errorMessage(pbError(500, 'Something went wrong while processing your request.'))).toBe(
      'Serverfehler. Bitte versuche es später erneut.',
    );
    expect(errorMessage(pbError(429, 'Too Many Requests.'))).toBe('Zu viele Anfragen – bitte kurz warten.');
  });

  it('explains relation reference errors on delete', () => {
    expect(
      errorMessage(
        pbError(400, 'Failed to delete record. Make sure that the record is not part of a required relation reference.'),
      ),
    ).toBe('Der Eintrag wird noch verwendet und kann nicht gelöscht werden.');
  });

  it('uses a login specific message for failed authentication', () => {
    expect(errorMessage(pbError(400, 'Failed to authenticate.'), 'auth')).toBe(
      'Anmeldung fehlgeschlagen: Benutzername oder Passwort ist falsch.',
    );
  });

  it('maps rate limiting (429) – login specific and generic', () => {
    expect(errorMessage(pbError(429, 'Too Many Requests.'), 'auth')).toBe(
      'Zu viele Anmeldeversuche. Bitte warte eine Minute und versuche es erneut.',
    );
    expect(errorMessage(pbError(429, 'Too Many Requests.'), 'bookings')).toBe('Zu viele Anfragen – bitte kurz warten.');
    // even if the server sends some other (non-generic) text
    expect(errorMessage(pbError(429, 'Rate limit exceeded'), 'account')).toBe('Zu viele Anfragen – bitte kurz warten.');
    expect(errorMessage(pbError(429, ''), 'auth')).toContain('Zu viele Anmeldeversuche');
  });

  it('reports disabled accounts on login', () => {
    expect(
      errorMessage(
        pbError(403, "The request doesn't satisfy the collection requirements to authenticate."),
        'auth',
      ),
    ).toBe('Dieses Konto ist deaktiviert. Bitte wende dich an die Verwaltung.');
  });

  it('explains rule denials (400 without field errors on create, 404 on update/delete)', () => {
    expect(errorMessage(pbError(400, 'Failed to create record.'), 'bookings')).toContain('Berechtigung');
    expect(errorMessage(pbError(404, "The requested resource wasn't found."), 'bookings')).toContain(
      'keine Berechtigung',
    );
    expect(errorMessage(pbError(403, 'Only superusers can perform this action.'))).toBe(
      'Dafür fehlt dir die Berechtigung.',
    );
  });

  it('reports network errors', () => {
    const err = new ClientResponseError({ url: 'http://x', status: 0, response: {} });
    expect(errorMessage(err)).toContain('Keine Verbindung');
  });

  it('handles aborted requests and non-PocketBase errors', () => {
    expect(errorMessage(new ClientResponseError({ isAbort: true }))).toBe('Die Anfrage wurde abgebrochen.');
    expect(errorMessage(new Error('boom'))).toBe('Unerwarteter Fehler. Bitte versuche es erneut.');
  });
});

describe('helpers', () => {
  it('detects generic English messages', () => {
    expect(isGenericEnglishMessage('Failed to create record.')).toBe(true);
    expect(isGenericEnglishMessage('Dieses Angebot ist nicht aktiv.')).toBe(false);
  });

  it('detects 401 errors', () => {
    expect(isUnauthorized(pbError(401, 'x'))).toBe(true);
    expect(isUnauthorized(pbError(403, 'x'))).toBe(false);
    expect(isUnauthorized(new Error('x'))).toBe(false);
  });
});
