/// <reference path="../../.pb/dev-data/types.d.ts" />

// GET /api/app/totals – docs/ARCHITECTURE.md §5.
//
// Optional query params: from, to (ISO 8601; from inclusive, to exclusive,
// applied to bookings.created), person (person id), createdBy (user id).
// Requires an authenticated record of the "users" collection.

routerAdd(
  "GET",
  "/api/app/totals",
  (e) => {
    const totals = require(`${__hooks}/lib/totals.js`);
    return e.json(200, totals.computeTotals(e.app, e.requestInfo().query));
  },
  $apis.requireAuth("users"),
);
