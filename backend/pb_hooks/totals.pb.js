/// <reference path="../../.pb/dev-data/types.d.ts" />

// GET /api/app/totals – docs/ARCHITECTURE.md §5.
//
// Optional query params: from, to (ISO 8601; from inclusive, to exclusive,
// applied to bookings.created), person (person id), createdBy (user id),
// parts (comma-separated subset of summary, perPerson, perOffering, perUser;
// missing/empty = all – only the requested parts are computed and returned).
// A query with a raw ";" or an invalid %-escape -> 400 (see
// lib/totals.js assertWellFormedQuery).
// Requires an authenticated record of the "users" collection.

routerAdd(
  "GET",
  "/api/app/totals",
  (e) => {
    const totals = require(`${__hooks}/lib/totals.js`);
    totals.assertWellFormedQuery(e.request.url.rawQuery);
    const parts = totals.queryValues(e.request.url.query().encode(), "parts");
    return e.json(200, totals.computeTotals(e.app, e.requestInfo().query, parts));
  },
  $apis.requireAuth("users"),
);
