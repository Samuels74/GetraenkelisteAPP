/// <reference path="../../.pb/dev-data/types.d.ts" />

// "groups", "offerings" and "persons" hooks – docs/ARCHITECTURE.md §4.
//
// The delete guards are model-level hooks, so they also protect deletes that
// don't go through the REST API (dashboard, other hooks). Thrown
// BadRequestErrors reach REST clients unchanged (HTTP 400 + German message).
// The same applies to the name uniqueness check and the normalization.
//
// Checks and writes run in one transaction (lib/rules.js
// runInWriteTransaction): a delete guard counts the references inside the
// delete's transaction, an offering's group and a group's or offering's name
// are checked inside the save's transaction – a booking or offering created,
// or a name taken, at the same moment cannot slip in between.

onRecordDelete((e) => {
  const rules = require(`${__hooks}/lib/rules.js`);
  // groups: still has offerings; offerings/persons: already booked
  rules.runInWriteTransaction(e, (txApp) => rules.assertDeletable(txApp, e.record));
}, "groups", "offerings", "persons");

// Names are stored normalized when a save sets or changes them (lib/rules.js
// normalizeName: no invisible characters, single spaces, trimmed, NFC);
// uniqueness (onRecordValidate below) and the offering's group are checked
// inside the transaction.
onRecordCreate((e) => {
  const rules = require(`${__hooks}/lib/rules.js`);
  rules.normalizeNames(e.record, ["name"], rules.normalizeName);
  rules.runInWriteTransaction(e);
}, "groups", "offerings");

onRecordUpdate((e) => {
  const rules = require(`${__hooks}/lib/rules.js`);
  rules.normalizeNames(e.record, ["name"], rules.normalizeName);
  rules.runInWriteTransaction(e);
}, "groups", "offerings");

// Unicode-aware name uniqueness (the NOCASE indexes only fold ASCII letters),
// checked when a name is set or changes (offerings: also the group).
onRecordValidate((e) => {
  const rules = require(`${__hooks}/lib/rules.js`);
  rules.assertUniqueName(e.app, e.record, "", {}, ["name"]);
  e.next();
}, "groups");

onRecordValidate((e) => {
  const rules = require(`${__hooks}/lib/rules.js`);
  const group = e.record.getString("group");
  if (group) {
    rules.assertUniqueName(e.app, e.record, "group = {:group}", { group }, ["group", "name"]);
  }
  e.next();
}, "offerings");

// persons: trimmed number; name and nickname normalized as display names when
// a save sets or changes them (lib/rules.js normalizeText: like the names
// above, but invisible format characters such as the zero-width joiner of
// emoji sequences are kept – not unique, no relations, no transaction needed)
onRecordCreate((e) => {
  const rules = require(`${__hooks}/lib/rules.js`);
  rules.normalizePersonNumber(e.record);
  rules.normalizeNames(e.record, ["name", "nickname"], rules.normalizeText);
  e.next();
}, "persons");

onRecordUpdate((e) => {
  const rules = require(`${__hooks}/lib/rules.js`);
  rules.normalizePersonNumber(e.record);
  rules.normalizeNames(e.record, ["name", "nickname"], rules.normalizeText);
  e.next();
}, "persons");
