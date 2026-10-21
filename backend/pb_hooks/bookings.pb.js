/// <reference path="../../.pb/dev-data/types.d.ts" />

// "bookings" hooks – docs/ARCHITECTURE.md §4 "bookings".
//
// - createdBy is always the authenticated user (request level, client value ignored)
// - unitPriceCents is always the offering's current priceCents (model level,
//   client value ignored), so later price changes never alter old bookings
// - inactive offerings cannot be booked (model level)
// - every save validates its relations (person, offering, createdBy) and
//   writes in one transaction (lib/rules.js runInWriteTransaction): a person,
//   offering or user deleted at the same moment either blocks the booking
//   (validation_missing_rel_records) or is blocked by it (delete guard) –
//   never a booking that points to a deleted record. The write connection is
//   held ≈ 0.15 ms longer per booking (see runInWriteTransaction; the load
//   test's write scenario A4 measures it).

onRecordCreateRequest((e) => {
  const rules = require(`${__hooks}/lib/rules.js`);
  // superusers (dashboard) have no "users" record and must pick createdBy themselves
  if (rules.isAppUser(e.auth)) {
    e.record.set("createdBy", e.auth.id);
  }
  e.next();
}, "bookings");

onRecordCreate((e) => {
  const rules = require(`${__hooks}/lib/rules.js`);
  rules.runInWriteTransaction(e, (txApp) => rules.applyOfferingToBooking(txApp, e.record));
}, "bookings");

// only superusers update bookings (dashboard) – same relation check as above
onRecordUpdate((e) => {
  const rules = require(`${__hooks}/lib/rules.js`);
  rules.runInWriteTransaction(e);
}, "bookings");
