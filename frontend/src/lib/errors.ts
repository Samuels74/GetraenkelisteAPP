/**
 * Maps PocketBase errors (ClientResponseError) to German, user-facing text.
 *
 * - German messages returned by our server hooks (ARCHITECTURE.md §4) are
 *   shown as-is.
 * - Generic English PocketBase messages are replaced by German text based on
 *   the HTTP status.
 * - Field validation errors (`response.data`) are mapped per error code, with
 *   friendly texts for `validation_not_unique` etc.
 */
import { ClientResponseError } from 'pocketbase';

export type ErrorContext = 'persons' | 'users' | 'groups' | 'offerings' | 'bookings' | 'auth' | 'account';

export interface ErrorInfo {
  status: number;
  /** One German message suitable for a toast or a form-level alert. */
  message: string;
  /** German message per field name (without the field label). */
  fieldErrors: Record<string, string>;
}

interface PbFieldError {
  code?: string;
  message?: string;
  params?: Record<string, unknown>;
}

const FIELD_LABELS: Record<string, string> = {
  number: 'Nummer',
  name: 'Name',
  nickname: 'Nickname',
  username: 'Benutzername',
  password: 'Passwort',
  passwordConfirm: 'Passwort-Bestätigung',
  oldPassword: 'Aktuelles Passwort',
  role: 'Rolle',
  disabled: 'Deaktiviert',
  group: 'Gruppe',
  priceCents: 'Preis',
  active: 'Aktiv',
  sortOrder: 'Reihenfolge',
  person: 'Person',
  offering: 'Angebot',
  quantity: 'Anzahl',
  createdBy: 'Gebucht von',
  email: 'E-Mail',
};

const NOT_UNIQUE: Record<string, string> = {
  'persons.number': 'Diese Nummer ist bereits vergeben.',
  'users.username': 'Dieser Benutzername ist bereits vergeben.',
  'groups.name': 'Eine Gruppe mit diesem Namen gibt es bereits.',
  'offerings.name': 'Ein Angebot mit diesem Namen gibt es in dieser Gruppe bereits.',
  'offerings.group': 'Ein Angebot mit diesem Namen gibt es in dieser Gruppe bereits.',
};

const INVALID_FORMAT: Record<string, string> = {
  'persons.number': 'Nur Buchstaben, Ziffern, „-“ und „_“ erlaubt (keine Leerzeichen).',
  'users.username': 'Nur Kleinbuchstaben, Ziffern, „.“, „_“ und „-“ erlaubt.',
};

const STATUS_MESSAGES: Record<number, string> = {
  0: 'Keine Verbindung zum Server. Bitte prüfe die Netzwerkverbindung.',
  // PocketBase answers denied creates with 400 and no field errors.
  400: 'Das ist nicht möglich – dafür fehlt dir die Berechtigung oder die Eingaben sind ungültig.',
  401: 'Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.',
  403: 'Dafür fehlt dir die Berechtigung.',
  // PocketBase answers denied updates/deletes with 404.
  404: 'Nicht gefunden oder keine Berechtigung – vielleicht wurde der Eintrag inzwischen gelöscht.',
  409: 'Der Eintrag wurde inzwischen geändert. Bitte versuche es erneut.',
  413: 'Die Anfrage ist zu groß.',
  429: 'Zu viele Anfragen – bitte kurz warten.',
};

const LOGIN_FAILED = 'Anmeldung fehlgeschlagen: Benutzername oder Passwort ist falsch.';
const ACCOUNT_DISABLED = 'Dieses Konto ist deaktiviert. Bitte wende dich an die Verwaltung.';
const LOGIN_RATE_LIMITED = 'Zu viele Anmeldeversuche. Bitte warte eine Minute und versuche es erneut.';

const RELATION_IN_USE = 'Der Eintrag wird noch verwendet und kann nicht gelöscht werden.';

/** Generic (English) PocketBase messages that must not be shown to users. */
const GENERIC_ENGLISH = [
  /^failed to /i,
  /^something went wrong/i,
  /^the request/i,
  /^the requested/i,
  /^the authorized record/i,
  /^only superusers/i,
  /^missing /i,
  /^invalid /i,
  /^an error occurred/i,
  /^you are not allowed/i,
  /^too many requests/i,
  /^unauthorized/i,
  /^forbidden/i,
  /^not found/i,
  /^bad request/i,
  /^internal server error/i,
  /^record not found/i,
  /^sql: /i,
  /^the request doesn't satisfy/i,
];

/** Typical English texts of PocketBase / ozzo-validation field errors. */
const ENGLISH_VALIDATOR_TEXT = /^(must|cannot|value|values|invalid|the|failed|only|missing|should|expected|unknown)\b/i;

export function isGenericEnglishMessage(message: string): boolean {
  return GENERIC_ENGLISH.some((pattern) => pattern.test(message.trim()));
}

function numberParam(params: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = params?.[key];
  return typeof value === 'number' ? value : undefined;
}

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

/** German text for one field error (without the field label). */
export function fieldErrorMessage(context: ErrorContext | undefined, field: string, error: PbFieldError): string {
  const key = `${context ?? ''}.${field}`;
  const min = numberParam(error.params, 'min');
  const max = numberParam(error.params, 'max');
  switch (error.code) {
    case 'validation_not_unique':
      return NOT_UNIQUE[key] ?? 'Dieser Wert ist bereits vergeben.';
    case 'validation_required':
    case 'validation_nil_or_not_empty_required':
      return 'Dieses Feld ist erforderlich.';
    case 'validation_min_text_constraint':
    case 'validation_length_too_short':
      if (field === 'password') {
        return `Das Passwort muss mindestens ${min ?? 8} Zeichen lang sein.`;
      }
      return min !== undefined ? `Mindestens ${min} Zeichen erforderlich.` : 'Der Wert ist zu kurz.';
    case 'validation_max_text_constraint':
    case 'validation_length_too_long':
      return max ? `Höchstens ${max} Zeichen erlaubt.` : 'Der Wert ist zu lang.';
    case 'validation_length_out_of_range':
    case 'validation_length_invalid':
      return 'Die Länge ist ungültig.';
    case 'validation_invalid_format':
    case 'validation_match_invalid':
      return INVALID_FORMAT[key] ?? 'Ungültiges Format.';
    case 'validation_min_number_constraint':
      return field === 'priceCents'
        ? 'Der Preis ist zu niedrig (mindestens -1.000,00 €).'
        : `Der Wert muss mindestens ${min ?? ''} sein.`;
    case 'validation_max_number_constraint':
      return field === 'priceCents'
        ? 'Der Preis ist zu hoch (höchstens 1.000,00 €).'
        : `Der Wert darf höchstens ${max ?? ''} sein.`;
    case 'validation_only_int_constraint':
      return 'Nur ganze Zahlen erlaubt.';
    case 'validation_values_mismatch':
      return 'Die Passwörter stimmen nicht überein.';
    case 'validation_invalid_old_password':
      return 'Das aktuelle Passwort ist falsch.';
    case 'validation_missing_rel_records':
      return 'Der verknüpfte Eintrag existiert nicht (mehr).';
    case 'validation_invalid_value':
    case 'validation_in_invalid':
      return 'Ungültiger Wert.';
    default: {
      // Unknown code: hooks may send German field messages – show those,
      // replace typical English validator texts.
      const message = error.message?.trim();
      if (message && !isGenericEnglishMessage(message) && !ENGLISH_VALIDATOR_TEXT.test(message)) {
        return message;
      }
      return 'Ungültiger Wert.';
    }
  }
}

function isSelfContained(context: ErrorContext | undefined, field: string, error: PbFieldError): boolean {
  return (
    error.code === 'validation_not_unique' ||
    error.code === 'validation_values_mismatch' ||
    error.code === 'validation_invalid_old_password' ||
    (error.code === 'validation_min_text_constraint' && field === 'password') ||
    (error.code === 'validation_min_number_constraint' && field === 'priceCents') ||
    (error.code === 'validation_max_number_constraint' && field === 'priceCents') ||
    (context !== undefined && error.code === 'validation_invalid_format' && `${context}.${field}` in INVALID_FORMAT)
  );
}

function asFieldErrors(data: unknown): Record<string, PbFieldError> {
  if (!data || typeof data !== 'object') return {};
  const result: Record<string, PbFieldError> = {};
  for (const [field, value] of Object.entries(data as Record<string, unknown>)) {
    if (value && typeof value === 'object' && ('code' in value || 'message' in value)) {
      result[field] = value as PbFieldError;
    }
  }
  return result;
}

/** Detailed German description of any error thrown by the SDK (or elsewhere). */
export function describeError(error: unknown, context?: ErrorContext): ErrorInfo {
  if (!(error instanceof ClientResponseError)) {
    return {
      status: -1,
      message: 'Unerwarteter Fehler. Bitte versuche es erneut.',
      fieldErrors: {},
    };
  }
  if (error.isAbort) {
    return { status: 0, message: 'Die Anfrage wurde abgebrochen.', fieldErrors: {} };
  }

  const status = error.status;
  const response = (error.response ?? {}) as { message?: unknown; data?: unknown };
  const serverMessage = typeof response.message === 'string' ? response.message.trim() : '';
  const rawFieldErrors = asFieldErrors(response.data);

  const fieldErrors: Record<string, string> = {};
  const details: string[] = [];
  for (const [field, fieldError] of Object.entries(rawFieldErrors)) {
    const text = fieldErrorMessage(context, field, fieldError);
    fieldErrors[field] = text;
    const detail = isSelfContained(context, field, fieldError) ? text : `${fieldLabel(field)}: ${text}`;
    if (!details.includes(detail)) details.push(detail);
  }

  let message: string;
  if (status === 0) {
    message = STATUS_MESSAGES[0]!;
  } else if (status === 429) {
    // rate limit (e.g. login attempts) – never show the server's English text
    message = context === 'auth' ? LOGIN_RATE_LIMITED : STATUS_MESSAGES[429]!;
  } else if (context === 'auth' && status === 403) {
    // authRule `disabled = false` not satisfied
    message = ACCOUNT_DISABLED;
  } else if (context === 'auth' && (status === 400 || status === 401) && details.length === 0) {
    message = LOGIN_FAILED;
  } else if (serverMessage && !isGenericEnglishMessage(serverMessage)) {
    message = details.length ? `${serverMessage} ${details.join(' ')}` : serverMessage;
  } else if (details.length) {
    message = details.join(' ');
  } else if (/required relation reference/i.test(serverMessage)) {
    message = RELATION_IN_USE;
  } else if (status >= 500) {
    message = 'Serverfehler. Bitte versuche es später erneut.';
  } else {
    message = STATUS_MESSAGES[status] ?? `Unbekannter Fehler (Status ${status}).`;
  }

  return { status, message, fieldErrors };
}

/** Short form: the German message for toasts / alerts. */
export function errorMessage(error: unknown, context?: ErrorContext): string {
  return describeError(error, context).message;
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ClientResponseError && error.status === 401;
}
