/// <reference path="../../../.pb/dev-data/types.d.ts" />

// Shared helpers for the *.pb.js hooks.
//
// PocketBase runs every hook/route handler in its own isolated JS runtime, so
// top-level declarations of a *.pb.js file are NOT visible inside a handler.
// Handlers therefore load this module with
//   const rules = require(`${__hooks}/lib/rules.js`);
// (files without the ".pb.js" suffix are not auto-loaded as hooks).

// German messages returned as HTTP 400 – docs/ARCHITECTURE.md §4 "Error messages".
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
};

// collection -> which referencing records block its deletion
const DELETE_GUARDS = {
  offerings: { collection: "bookings", field: "offering", message: MESSAGES.offeringHasBookings },
  persons: { collection: "bookings", field: "person", message: MESSAGES.personHasBookings },
  users: { collection: "bookings", field: "createdBy", message: MESSAGES.userHasBookings },
  groups: { collection: "offerings", field: "group", message: MESSAGES.groupHasOfferings },
};

/**
 * Throws a 400 BadRequestError (German message) if the record is still
 * referenced and therefore must not be deleted.
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

/**
 * Case-insensitive uniqueness of the "name" field with full Unicode case
 * folding. The unique indexes use SQLite's COLLATE NOCASE, which only folds
 * ASCII letters – "Getränke" and "GETRÄNKE" would both be accepted.
 * Reports the same validation error as PocketBase's unique indexes.
 *
 * @param {core.App} app
 * @param {core.Record} record  group or offering being saved
 * @param {string} scopeFilter  filter selecting the records that must not share the name
 * @param {Object<string, any>} params  filter params
 * @param {string[]} fields  fields to flag (like PocketBase does for the index columns)
 */
function assertUniqueName(app, record, scopeFilter, params, fields) {
  const name = record.getString("name").toLowerCase();
  if (!name) {
    return; // "required" is reported by the regular validation
  }
  const candidates = app.findRecordsByFilter(record.collection().name, scopeFilter, "", 0, 0, params);
  for (const other of candidates) {
    if (other.id !== record.id && other.getString("name").toLowerCase() === name) {
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
  const str = (value) => (value === undefined || value === null ? "" : String(value));
  const password = str(body["password"]);
  const passwordConfirm = str(body["passwordConfirm"]);
  const oldPassword = str(body["oldPassword"]);

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

/** Whether the request is authenticated with a record of the "users" collection. */
function isAppUser(auth) {
  return !!auth && auth.collection().name === "users";
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
  assertDeletable,
  assertOldPasswordForOwnChange,
  assertUniqueName,
  isAppUser,
  normalizeUsername,
  normalizePersonNumber,
  applyOfferingToBooking,
};
