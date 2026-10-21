/// <reference path="../../../.pb/dev-data/types.d.ts" />

// Shared helpers for the *.pb.js hooks.
//
// PocketBase runs every hook/route handler in its own isolated JS runtime, so
// top-level declarations of a *.pb.js file are NOT visible inside a handler.
// Handlers therefore load this module with
//   const rules = require(`${__hooks}/lib/rules.js`);
// (files without the ".pb.js" suffix are not auto-loaded as hooks).

// German messages of the hooks – docs/ARCHITECTURE.md §4 "Error messages".
// All are returned as HTTP 400, except noLongerAdmin (403).
const MESSAGES = {
  offeringHasBookings:
    "Dieses Angebot hat bereits Buchungen und kann nicht gelöscht werden. Deaktiviere es stattdessen.",
  groupHasOfferings: "Diese Gruppe enthält noch Angebote und kann nicht gelöscht werden.",
  personHasBookings: "Diese Person hat bereits Buchungen und kann nicht gelöscht werden.",
  userHasBookings:
    "Dieser Benutzer hat bereits Buchungen erfasst und kann nicht gelöscht werden. Deaktiviere das Konto stattdessen.",
  offeringInactive: "Dieses Angebot ist nicht aktiv.",
  ownRoleOrDisabled:
    "Du kannst deine eigene Rolle nicht ändern und dein eigenes Konto nicht deaktivieren.",
  ownMustChangePassword:
    "Du kannst die Pflicht zur Passwortänderung für dein eigenes Konto nicht selbst ändern – sie endet, sobald du dein Passwort änderst.",
  samePassword: "Das neue Passwort muss sich vom bisherigen unterscheiden.",
  lastActiveAdmin: "Mindestens ein aktiver Admin muss bleiben.",
  noLongerAdmin: "Dafür fehlt dir inzwischen die Berechtigung.",
};

// collection -> which referencing records block its deletion
const DELETE_GUARDS = {
  offerings: { collection: "bookings", field: "offering", message: MESSAGES.offeringHasBookings },
  persons: { collection: "bookings", field: "person", message: MESSAGES.personHasBookings },
  users: { collection: "bookings", field: "createdBy", message: MESSAGES.userHasBookings },
  groups: { collection: "offerings", field: "group", message: MESSAGES.groupHasOfferings },
};

/**
 * Runs the rest of a hook – check(txApp) and e.next() – in ONE database
 * transaction, so that nothing another request commits can come between
 * what the check and PocketBase's validation read and the write itself.
 *
 * Why: PocketBase validates a record (that its relation targets exist, the
 * uniqueness and delete checks of these hooks) on the read connections and
 * writes it afterwards on the single write connection, with no transaction
 * around both steps. A person deleted in between left a booking pointing to
 * the deleted person; a delete guard that counted the bookings just before
 * a booking was written let the delete through (bug hunt M1). Inside a
 * transaction every read and the write go through the write connection,
 * which serves one transaction at a time: concurrent writes run one after
 * the other, each sees everything committed before it, and the loser fails
 * with the regular error (validation_missing_rel_records, a German delete
 * guard message, validation_not_unique, ...). Cost: the write connection is
 * also held while the checks read – ≈ 0.15 ms more per write (dev machine,
 * booking creates: alone unchanged at ≈ 0.9 ms; 8 writers at once 2,800
 * instead of 4,500 per second). The load test's write scenario A4 measures
 * it under the app's load.
 *
 * e.app is switched to the transaction for the rest of the hook chain and
 * restored afterwards: PocketBase hands e.app on to the after-success hooks
 * (the realtime broadcast reads the database with it) – a finished
 * transaction there silently drops the realtime create/update events.
 * Nested calls (a model hook below a request hook that already runs in a
 * transaction, a save inside runInTransaction) join the outer transaction.
 *
 * @param {core.RecordEvent | core.RecordRequestEvent} e
 * @param {(txApp: core.App) => void} [check]  reads (and throws) inside the transaction
 */
function runInWriteTransaction(e, check) {
  const app = e.app;
  try {
    app.runInTransaction((txApp) => {
      e.app = txApp;
      if (check) {
        check(txApp);
      }
      e.next();
    });
  } finally {
    e.app = app;
  }
}

/**
 * Throws a 400 BadRequestError (German message) if the record is still
 * referenced and therefore must not be deleted. Call it inside the delete's
 * transaction (runInWriteTransaction).
 *
 * @param {core.App} app  use the event's app (transaction aware)
 * @param {core.Record} record
 */
function assertDeletable(app, record) {
  const guard = DELETE_GUARDS[record.collection().name];
  if (!guard) {
    return;
  }
  const references = app.countRecords(
    guard.collection,
    $dbx.hashExp({ [guard.field]: record.id }),
  );
  if (references > 0) {
    throw new BadRequestError(guard.message);
  }
}

// Control characters other than whitespace (C0 without tab, line feed,
// vertical tab, form feed and carriage return; DEL; C1). Never part of a name.
const CONTROL = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g;

// Characters that are invisible in a name and only make two names look
// alike: the control characters above and the format characters (Unicode
// category Cf, Unicode 17 – soft hyphen U+00AD, zero-width space, joiners
// and direction marks U+200B–U+200F, bidi controls U+202A–U+202E and
// U+2066–U+206F, word joiner and invisible operators U+2060–U+2064, byte
// order mark U+FEFF, tag characters U+E0001 and U+E0020–U+E007F, …).
// Listed explicitly: PocketBase's JS engine silently ignores \p{Cf}.
const INVISIBLE =
  /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u00ad\u0600-\u0605\u061c\u06dd\u070f\u0890\u0891\u08e2\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb\u{110bd}\u{110cd}\u{13430}-\u{1343f}\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0001}\u{e0020}-\u{e007f}]/gu;

/**
 * The stored form of a display name that need not be unique (persons.name
 * and nickname, users.name): control characters (see CONTROL) removed, every
 * run of whitespace (also non-breaking and other Unicode spaces, tabs, line
 * breaks; the byte order mark counts as whitespace in JavaScript) turned into
 * one space, trimmed, Unicode NFC (an "ä" typed as "a" + combining diaeresis
 * becomes the single character "ä"). Format characters are kept: the
 * zero-width joiner holds emoji sequences together (woman + ZWJ + frying pan
 * = woman cook, the rainbow flag), tag characters form the flags of England
 * or Scotland – and without a uniqueness check, removing them protects
 * nothing.
 *
 * @param {string} value
 * @returns {string}
 */
function normalizeText(value) {
  return String(value).replace(CONTROL, "").replace(/\s+/g, " ").trim().normalize("NFC");
}

/**
 * The stored form of a unique name (groups.name, offerings.name): like
 * normalizeText, and the invisible characters (see INVISIBLE) are removed
 * as well – before the whitespace runs are collapsed. Trade-off: an emoji
 * sequence joined by a zero-width joiner falls apart into its emoji (the
 * woman cook becomes a woman and a frying pan).
 *
 * @param {string} value
 * @returns {string}
 */
function normalizeName(value) {
  return normalizeText(String(value).replace(INVISIBLE, ""));
}

/**
 * Comparison key of the uniqueness checks: the normalized name (normalizeName),
 * case-folded ("Säfte" = "SÄFTE"; "Straße" = "STRAẞE" = "STRASSE").
 * Lower → upper → lower: toUpperCase() applies the special casings ("ß" →
 * "SS", "ﬁ" → "FI"), lowercasing first also folds the capital "ẞ", which
 * toUpperCase() keeps. Locale-independent, so the dotless "ı" folds into
 * "i" as well ("Bıer" = "Bier"). NFC again: a case mapping may decompose.
 *
 * @param {string} value
 * @returns {string}
 */
function nameKey(value) {
  return normalizeName(value).toLowerCase().toUpperCase().toLowerCase().normalize("NFC");
}

/**
 * Normalizes the given text fields of a record in place – only those the
 * save sets or changes (on a new record: all of them). Runs before the
 * validation: a required name that is empty afterwards fails "required".
 * A value the save leaves as it is stays as stored: names saved before the
 * normalization existed are not rewritten by an unrelated update (a number,
 * price or order change, a password reset), and an older blank or
 * look-alike name cannot make such an update fail.
 *
 * @param {core.Record} record
 * @param {string[]} fields
 * @param {(value: string) => string} normalize  normalizeName (unique names) or normalizeText
 */
function normalizeNames(record, fields, normalize) {
  const original = record.isNew() ? null : record.original();
  for (const field of fields) {
    const value = record.getString(field);
    if (original && value === original.getString(field)) {
      continue; // unchanged
    }
    const normalized = normalize(value);
    if (normalized !== value) {
      record.set(field, normalized);
    }
  }
}

/**
 * Case-insensitive uniqueness of the "name" field with Unicode case folding,
 * comparing normalized names (nameKey – also names stored before the
 * normalization existed). The unique indexes use SQLite's COLLATE NOCASE,
 * which only folds ASCII letters – "Getränke" and "GETRÄNKE" would both be
 * accepted. Reports the same validation error as PocketBase's unique
 * indexes. Checked only when the save creates the record or changes one of
 * the fields (the name by its key): an unrelated update – a reorder, a price
 * change – of a record that already has an older look-alike is not blocked,
 * and a new look-alike is never created. Atomic only inside the save's
 * transaction (runInWriteTransaction): two names created at the same moment.
 *
 * @param {core.App} app
 * @param {core.Record} record  group or offering being saved
 * @param {string} scopeFilter  filter selecting the records that must not share the name
 * @param {Object<string, any>} params  filter params
 * @param {string[]} fields  the fields of the uniqueness ("name" and the scope fields, like
 *   the columns of a unique index): flagged in the error, checked when one of them changes
 */
function assertUniqueName(app, record, scopeFilter, params, fields) {
  const key = nameKey(record.getString("name"));
  if (!key) {
    return; // "required" is reported by the regular validation
  }
  if (!record.isNew()) {
    const original = record.original();
    const changed = fields.some((field) =>
      field === "name"
        ? nameKey(original.getString(field)) !== key
        : record.getString(field) !== original.getString(field),
    );
    if (!changed) {
      return;
    }
  }
  const candidates = app.findRecordsByFilter(record.collection().name, scopeFilter, "", 0, 0, params);
  for (const other of candidates) {
    if (other.id !== record.id && nameKey(other.getString("name")) === key) {
      const data = {};
      for (const field of fields) {
        data[field] = new ValidationError("validation_not_unique", "Value must be unique.");
      }
      throw new BadRequestError(
        record.isNew() ? "Failed to create record." : "Failed to update record.",
        data,
      );
    }
  }
}

/**
 * Own password change: requires the current password from EVERYONE. PocketBase
 * skips this check for requests with manage access (admins, via manageRule),
 * so it is enforced here. The error mirrors PocketBase's own response for
 * regular users, including the password/passwordConfirm errors it reports in
 * the same response.
 *
 * @param {core.App} app
 * @param {string} userId  the own users record
 * @param {Object<string, any>} body  request body
 */
function assertOldPasswordForOwnChange(app, userId, body) {
  const password = bodyString(body, "password");
  const passwordConfirm = bodyString(body, "passwordConfirm");
  const oldPassword = bodyString(body, "oldPassword");

  if (password === "" && passwordConfirm === "") {
    return; // no password change
  }

  let oldPasswordError = null;
  if (oldPassword === "") {
    oldPasswordError = new ValidationError("validation_required", "Cannot be blank.");
  } else if (!app.findRecordById("users", userId).validatePassword(oldPassword)) {
    oldPasswordError = new ValidationError(
      "validation_invalid_old_password",
      "Missing or invalid old password.",
    );
  }
  if (!oldPasswordError) {
    return;
  }

  const data = { oldPassword: oldPasswordError };
  if (password === "") {
    data.password = new ValidationError("validation_required", "Cannot be blank.");
  }
  if (passwordConfirm === "") {
    data.passwordConfirm = new ValidationError("validation_required", "Cannot be blank.");
  } else if (passwordConfirm !== password) {
    data.passwordConfirm = new ValidationError("validation_values_mismatch", "Values don't match.");
  }
  throw new BadRequestError("Failed to update record.", data);
}

/**
 * The own "mustChangePassword" flag ends only with a real password change:
 * - a change of the flag without a new password is rejected (admins could
 *   otherwise clear it on their own record – the update rule lets them write
 *   the field; for regular users the rule already refuses it);
 * - a "new" password equal to the current one is rejected (it would clear
 *   the flag and keep the password the admin chose, or the seeded default).
 * Call it after assertOldPasswordForOwnChange: the same-password answer is
 * given only to somebody who proved the current password.
 *
 * @param {core.Record} record  the own users record with the submitted changes
 * @param {Object<string, any>} body  request body
 */
function assertRealOwnPasswordChange(record, body) {
  const original = record.original();
  const password = bodyString(body, "password");
  if (password === "") {
    if (record.getBool("mustChangePassword") !== original.getBool("mustChangePassword")) {
      throw new BadRequestError(MESSAGES.ownMustChangePassword);
    }
    return;
  }
  if (password === bodyString(body, "oldPassword") || original.validatePassword(password)) {
    throw new BadRequestError(MESSAGES.samePassword);
  }
}

/** A request body value as string ("" when missing) – like PocketBase reads the password fields. */
function bodyString(body, key) {
  const value = body[key];
  return value === undefined || value === null ? "" : String(value);
}

/** Whether the request is authenticated with a record of the "users" collection. */
function isAppUser(auth) {
  return !!auth && auth.collection().name === "users";
}

/** Whether the users record is an enabled admin. */
function isActiveAdmin(user) {
  return user.getString("role") === "admin" && !user.getBool("disabled");
}

/**
 * At least one enabled admin must remain: rejects demoting, disabling or
 * deleting the last one. Called by the request-level hooks, so it binds
 * everything done through the REST API – the app and the dashboard –, not
 * migrations or other hooks (trusted code: the seed migration's down step
 * deletes the seeded admin, maybe the last one). Compares with the stored
 * state, so only a change that takes the status away is checked (nothing
 * else is blocked if there is no active admin at all). Atomic inside the
 * write transaction (runInWriteTransaction): of two admins demoting each
 * other at the same moment, the second one fails.
 *
 * @param {core.App} app  the write transaction
 * @param {core.Record} user  users record being saved (with its new values) or deleted
 * @param {boolean} deleting
 */
function assertActiveAdminRemains(app, user, deleting) {
  if (!deleting && isActiveAdmin(user)) {
    return;
  }
  let stored;
  try {
    stored = app.findRecordById("users", user.id);
  } catch (_) {
    return; // not stored (anymore)
  }
  if (!isActiveAdmin(stored)) {
    return;
  }
  const others = app.countRecords(
    "users",
    $dbx.hashExp({ role: "admin", disabled: false }),
    $dbx.not($dbx.hashExp({ id: user.id })),
  );
  if (others === 0) {
    throw new BadRequestError(MESSAGES.lastActiveAdmin);
  }
}

/**
 * The acting app user must still be an enabled admin when a change to
 * another user is written. The API rules (@request.auth.role = "admin") are
 * checked when the request starts, with the account as it was then: two
 * admins demoting (or disabling, deleting) each other at the same moment
 * both passed and both changes were written. Re-checked inside the write
 * transaction (runInWriteTransaction), the second one fails with 403.
 *
 * @param {core.App} app  the write transaction
 * @param {string} actorId  e.auth.id
 */
function assertActorStillAdmin(app, actorId) {
  let actor = null;
  try {
    actor = app.findRecordById("users", actorId);
  } catch (_) {
    // deleted meanwhile
  }
  if (!actor || !isActiveAdmin(actor)) {
    throw new ForbiddenError(MESSAGES.noLongerAdmin);
  }
}

/**
 * Lowercases + trims the username (applied on every save, before validation).
 *
 * @param {core.Record} record users record
 */
function normalizeUsername(record) {
  const username = record.getString("username");
  const normalized = username.trim().toLowerCase();
  if (normalized !== username) {
    record.set("username", normalized);
  }
}

/** Trims the person number (applied on every save, before validation). */
function normalizePersonNumber(record) {
  const number = record.getString("number");
  const trimmed = number.trim();
  if (trimmed !== number) {
    record.set("number", trimmed);
  }
}

/**
 * Snapshots the offering price into a new booking and rejects inactive
 * offerings. A missing/unknown offering is left to the regular validation
 * (required / relation checks).
 *
 * @param {core.App} app
 * @param {core.Record} booking
 */
function applyOfferingToBooking(app, booking) {
  const offeringId = booking.getString("offering");
  if (!offeringId) {
    return;
  }
  let offering;
  try {
    offering = app.findRecordById("offerings", offeringId);
  } catch (_) {
    return;
  }
  if (!offering.getBool("active")) {
    throw new BadRequestError(MESSAGES.offeringInactive);
  }
  booking.set("unitPriceCents", offering.getInt("priceCents"));
}

module.exports = {
  MESSAGES,
  applyOfferingToBooking,
  assertActiveAdminRemains,
  assertActorStillAdmin,
  assertDeletable,
  assertOldPasswordForOwnChange,
  assertRealOwnPasswordChange,
  assertUniqueName,
  isAppUser,
  nameKey,
  normalizeName,
  normalizeNames,
  normalizePersonNumber,
  normalizeText,
  normalizeUsername,
  runInWriteTransaction,
};
