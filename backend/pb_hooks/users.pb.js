/// <reference path="../../.pb/dev-data/types.d.ts" />

// "users" hooks – docs/ARCHITECTURE.md §4 "users".
//
// Model-level hooks (run for every save/delete: REST API, dashboard,
// migrations, other hooks) handle normalization and data integrity.
// Request-level hooks handle everything that depends on who is asking.

// ------------------------------------------------------------ model level

onRecordCreate((e) => {
  const rules = require(`${__hooks}/lib/rules.js`);
  rules.normalizeUsername(e.record);
  if (!e.record.getString("role")) {
    e.record.set("role", "user");
  }
  e.next();
}, "users");

onRecordUpdate((e) => {
  const rules = require(`${__hooks}/lib/rules.js`);
  rules.normalizeUsername(e.record);

  // Disabling an account logs it out everywhere: all issued tokens are signed
  // with the old tokenKey and become invalid (PocketBase then also stops
  // delivering realtime events to that account's open connections).
  if (e.record.getBool("disabled") && !e.record.original().getBool("disabled")) {
    e.record.refreshTokenKey();
  }
  e.next();
}, "users");

onRecordDelete((e) => {
  const rules = require(`${__hooks}/lib/rules.js`);
  rules.assertDeletable(e.app, e.record); // users that created bookings
  e.next();
}, "users");

// The email field is a system field that is not used by the app. PocketBase
// does not allow hiding it via the field options, so it is stripped from every
// API response (records, auth responses, realtime events) here.
onRecordEnrich((e) => {
  e.record.hide("email");
  e.next();
}, "users");

// ---------------------------------------------------------- request level

onRecordCreateRequest((e) => {
  // there is no public signup: every account is created by somebody else
  // (admin or superuser) who chose the initial password
  e.record.set("mustChangePassword", true);
  e.next();
}, "users");

onRecordUpdateRequest((e) => {
  const rules = require(`${__hooks}/lib/rules.js`);
  const record = e.record; // already contains the submitted changes
  const original = record.original();
  const isSelf = rules.isAppUser(e.auth) && e.auth.id === record.id;

  if (
    isSelf &&
    (record.getString("role") !== original.getString("role") ||
      record.getBool("disabled") !== original.getBool("disabled"))
  ) {
    throw new BadRequestError(rules.MESSAGES.ownRoleOrDisabled);
  }

  const body = e.requestInfo().body;

  // changing the own password always requires the current one (admins too);
  // admins/superusers resetting SOMEONE ELSE's password don't need it
  if (isSelf) {
    rules.assertOldPasswordForOwnChange(e.app, record.id, body);
  }

  const password = body["password"];
  if (password !== undefined && password !== null && password !== "") {
    // own change clears the flag; a (re)set by an admin/superuser requires a change
    record.set("mustChangePassword", !isSelf);
  }

  e.next();
}, "users");
