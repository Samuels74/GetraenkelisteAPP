/// <reference path="../../.pb/dev-data/types.d.ts" />

// Composite index bookings (createdBy, created) – docs/ARCHITECTURE.md §4
// "bookings", load-test finding F8 (docs/LOADTEST-FINDINGS.md).
//
// "Nur meine" combined with a period (Buchungen "Heute + nur meine", the
// totals of that filter) filters on createdBy AND a created range. With
// single-column indexes SQLite can use only one of them: on a database
// without planner statistics for the app tables (a new installation or a
// restored backup until PocketBase's first nightly "PRAGMA optimize" with
// data) it picks idx_bookings_createdBy and reads ALL bookings of the user
// (≈ 3,000 per user in the load test) to keep the few of the period; with
// statistics it reads all bookings of the period instead. The composite index
// returns exactly the user's bookings of the period, already in created
// order – with or without statistics, independent of the history length.
//
// It replaces idx_bookings_createdBy: an index can be searched by any prefix
// of its columns, so every "createdBy = ?" lookup (the "nur meine" list, the
// per-user totals, the delete guard of users) uses the composite index just
// as well, and every booking has one index less to maintain.
//
// PocketBase recreates all indexes of a collection when its index list
// changes (one transaction), so this rebuilds the bookings indexes once, and
// then runs "PRAGMA optimize". On an existing database that records planner
// statistics from the real data – they are kept. On a new installation (no
// bookings yet) it records the seed state of users (1 row), groups (1) and
// offerings (7), which later optimizes do not correct for tables that grow
// only a few times: SQLite then scanned users once per booking when joining
// it to bookings. forgetSeedStatistics() removes these rows again, so a new
// installation has no statistics for the app tables – as before this
// migration. Statistics only steer query plans, never results; should the
// cleanup fail, the migration still succeeds. Independent of that, the totals
// join these tables only after aggregating (backend/pb_hooks/lib/totals.js).

/** The app tables' planner statistics of a database without bookings (see above). */
function forgetSeedStatistics(app) {
  try {
    const state = new DynamicModel({ statTable: 0, bookings: 0 });
    app
      .db()
      .newQuery(
        "SELECT (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1') AS statTable, " +
          "(SELECT COUNT(*) FROM (SELECT 1 FROM bookings LIMIT 1)) AS bookings",
      )
      .one(state);
    if (!state.statTable || state.bookings) return; // no statistics at all, or real data
    app.db().newQuery("DELETE FROM sqlite_stat1 WHERE tbl IN ('users', 'groups', 'offerings', 'persons', 'bookings')").execute();
    // reload the statistics of this connection (the others reload with the new schema)
    app.db().newQuery("ANALYZE sqlite_schema").execute();
  } catch (err) {
    app.logger().warn("Could not remove the seed-state planner statistics", "error", String(err));
  }
}

migrate((app) => {
  const bookings = app.findCollectionByNameOrId("bookings");
  bookings.removeIndex("idx_bookings_createdBy");
  bookings.addIndex("idx_bookings_createdBy_created", false, "`createdBy`, `created`", "");
  app.save(bookings);
  forgetSeedStatistics(app);
}, (app) => {
  const bookings = app.findCollectionByNameOrId("bookings");
  bookings.removeIndex("idx_bookings_createdBy_created");
  bookings.addIndex("idx_bookings_createdBy", false, "`createdBy`", "");
  app.save(bookings);
});
