/// <reference path="../../.pb/dev-data/types.d.ts" />

// "users" hooks – docs/ARCHITECTURE.md §4 "users".
//
// Model-level hooks (run for every save/delete: REST API, dashboard,
// migrations, other hooks) handle normalization and data integrity.
// Request-level hooks handle everything that depends on who is asking.
//
// At least one enabled admin always remains for everything done through the
// REST API – the app and the dashboard –, also when two admins act at the
// same moment: the "last active admin" check and the re-check of the acting
// admin run at request level inside the write transaction (lib/rules.js
// runInWriteTransaction). Migrations and other hooks are trusted code and not
// bound by it: the seed migration's down step deletes the seeded admin.

// ------------------------------------------------------------ model level

onRecordCreate((e) => {
  const rules = require(`${__hooks}/lib/rules.js`);
  rules.normalizeUsername(e.record);
  rules.normalizeNames(e.record, ["name"], rules.normalizeText); // display name: set or changed
  if (!e.record.getString("role")) {
    e.record.set("role", "user");
  }
  e.next();
}, "users");

onRecordUpdate((e) => {
  const rules = require(`${__hooks}/lib/rules.js`);
  rules.normalizeUsername(e.record);
  rules.normalizeNames(e.record, ["name"], rules.normalizeText); // display name: set or changed

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
  // users that created bookings – counted inside the delete's transaction
  rules.runInWriteTransaction(e, (txApp) => rules.assertDeletable(txApp, e.record));
}, "users");

// The email field is a system field that is not used by the app. PocketBase
// does not allow hiding it via the field options, so it is stripped from
// every API response to app users (records, auth responses, realtime events)
// here. Superusers (dashboard) still see it: PocketBase unhides all fields
// for them after the enrich hooks.
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

  if (isSelf) {
    // changing the own password always requires the current one (admins too);
    // admins/superusers resetting SOMEONE ELSE's password don't need it
    rules.assertOldPasswordForOwnChange(e.app, record.id, body);
    // the own mustChangePassword flag ends only with a new, different password
    rules.assertRealOwnPasswordChange(record, body);
  }

  const password = body["password"];
  if (password !== undefined && password !== null && password !== "") {
    // own change clears the flag; a (re)set by an admin/superuser requires a change
    record.set("mustChangePassword", !isSelf);
  }

  // checked and written in one transaction (the password checks above stay
  // outside: bcrypt must not hold the write connection)
  rules.runInWriteTransaction(e, (txApp) => {
    if (rules.isAppUser(e.auth) && !isSelf) {
      // an admin changing another user: still an admin when it is written
      rules.assertActorStillAdmin(txApp, e.auth.id);
    }
    rules.assertActiveAdminRemains(txApp, record, false);
  });
}, "users");

onRecordDeleteRequest((e) => {
  const rules = require(`${__hooks}/lib/rules.js`);
  rules.runInWriteTransaction(e, (txApp) => {
    // app users can only delete others (rule): still an admin when it is written
    if (rules.isAppUser(e.auth)) {
      rules.assertActorStillAdmin(txApp, e.auth.id);
    }
    rules.assertActiveAdminRemains(txApp, e.record, true);
  });
}, "users");
