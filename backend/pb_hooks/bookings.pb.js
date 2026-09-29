/// <reference path="../../.pb/dev-data/types.d.ts" />

// "bookings" hooks – docs/ARCHITECTURE.md §4 "bookings".
//
// - createdBy is always the authenticated user (request level, client value ignored)
// - unitPriceCents is always the offering's current priceCents (model level,
//   client value ignored), so later price changes never alter old bookings
// - inactive offerings cannot be booked (model level)

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
  rules.applyOfferingToBooking(e.app, e.record);
  e.next();
}, "bookings");
