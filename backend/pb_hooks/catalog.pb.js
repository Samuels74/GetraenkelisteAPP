/// <reference path="../../.pb/dev-data/types.d.ts" />

// "groups", "offerings" and "persons" hooks – docs/ARCHITECTURE.md §4.
//
// The delete guards are model-level hooks, so they also protect deletes that
// don't go through the REST API (dashboard, other hooks). Thrown
// BadRequestErrors reach REST clients unchanged (HTTP 400 + German message).
// The same applies to the name uniqueness check and the number trimming.

onRecordDelete((e) => {
  const rules = require(`${__hooks}/lib/rules.js`);
  // groups: still has offerings; offerings/persons: already booked
  rules.assertDeletable(e.app, e.record);
  e.next();
}, "groups", "offerings", "persons");

// Unicode-aware name uniqueness (the NOCASE indexes only fold ASCII letters).
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

onRecordCreate((e) => {
  const rules = require(`${__hooks}/lib/rules.js`);
  rules.normalizePersonNumber(e.record);
  e.next();
}, "persons");

onRecordUpdate((e) => {
  const rules = require(`${__hooks}/lib/rules.js`);
  rules.normalizePersonNumber(e.record);
  e.next();
}, "persons");
