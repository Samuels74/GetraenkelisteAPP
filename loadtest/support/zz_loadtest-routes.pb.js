/// <reference path="../../.pb/dev-data/types.d.ts" />

// TEST ONLY – copied into the hooks dir of load-test PocketBase instances by
// loadtest/src/instance.ts (next to a copy of backend/pb_hooks). Never
// deployed: it is not part of backend/pb_hooks and never enters an image.
// All routes here are superuser-only.
//
// ---------------------------------------------------------------------------
// POST /api/loadtest/backdate-bookings   (superusers only)
//   body:     {"items": [{"id": "<booking id>", "created": "2026-09-01 19:23:45.123Z"}, …]}
//   response: {"updated": <number of bookings>}
//
// Sets "created" AND "updated" of the given bookings to the given timestamp
// (PocketBase storage format, UTC, millisecond precision). The load-test
// seeder creates its bookings through the REST API – so the API rules and the
// createdBy / unitPriceCents hooks run exactly as in production – and then
// spreads them over the last weeks with this route, because autodate fields
// cannot be set through the REST API.
//
// All items of a request are applied in one transaction (all or nothing).
// Plain SQL with bound parameters: no hooks, no realtime events, nothing but
// the two timestamps changes.

routerAdd(
  "POST",
  "/api/loadtest/backdate-bookings",
  (e) => {
    const MAX_ITEMS = 1000;
    const ID = /^[a-z0-9]{1,64}$/;
    const STORAGE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}Z$/;

    // plain JS values (the request body arrives as wrapped Go maps/slices)
    const body = JSON.parse(JSON.stringify(e.requestInfo().body || {}));
    const items = body.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
      throw new BadRequestError(`"items" must be an array of 1–${MAX_ITEMS} {id, created} objects.`);
    }
    items.forEach((item, i) => {
      const id = item && item.id;
      const created = item && item.created;
      if (typeof id !== "string" || !ID.test(id)) {
        throw new BadRequestError(`items[${i}].id is not a record id.`);
      }
      // format + calendar check by round trip (rejects e.g. month 13 or Feb 30),
      // plausible range: from 2000 up to one day ahead (clock skew)
      const time = typeof created === "string" ? Date.parse(created.replace(" ", "T")) : NaN;
      const valid =
        typeof created === "string" &&
        STORAGE_DATETIME.test(created) &&
        !isNaN(time) &&
        new Date(time).toISOString().replace("T", " ") === created &&
        time >= Date.UTC(2000, 0, 1) &&
        time <= Date.now() + 24 * 60 * 60 * 1000;
      if (!valid) {
        throw new BadRequestError(
          `items[${i}].created must be a UTC datetime between 2000 and tomorrow like "2026-09-01 19:23:45.123Z".`,
        );
      }
    });

    const missing = [];
    try {
      e.app.runInTransaction((txApp) => {
        for (const item of items) {
          const result = txApp
            .db()
            .newQuery("UPDATE bookings SET created = {:created}, updated = {:created} WHERE id = {:id}")
            .bind({ id: item.id, created: item.created })
            .execute();
          if (result.rowsAffected() !== 1) {
            missing.push(item.id);
            throw new Error("unknown booking id"); // rolls the transaction back
          }
        }
      });
    } catch (err) {
      if (missing.length > 0) {
        throw new NotFoundError(`Booking "${missing[0]}" not found – nothing was changed.`);
      }
      throw err;
    }

    return e.json(200, { updated: items.length });
  },
  $apis.requireSuperuserAuth(),
);

// ---------------------------------------------------------------------------
// POST /api/loadtest/planner-stats   (superusers only)
//   body:     {"action": "status" | "optimize" | "reload" | "checkpoint"}
//   response: {"action": "…", "durationMs": <ms>,
//              "stat1": [{"tbl": "bookings", "idx": "idx_bookings_created", "stat": "14915 1"}, …]}
//
// SQLite's planner statistics (table sqlite_stat1) decide e.g. which index
// the "Heute + nur meine" booking list uses. PocketBase maintains them by
// itself: its cron job "__pbDBOptimize__" runs "PRAGMA optimize" on the write
// connection every day at 00:00 UTC (core/base.go), and every collection
// schema change runs it too (core/collection_record_table_sync.go). On a new
// database the app tables are still empty at migration time, so they are not
// analyzed: a freshly seeded database has statistics for PocketBase's system
// tables only, a production database has them for the app tables after its
// first night with data.
//
//   status      the current content of sqlite_stat1
//   optimize    exactly the "PRAGMA optimize" of PocketBase's nightly job
//   checkpoint  the nightly job's "PRAGMA wal_checkpoint(TRUNCATE)" of the main
//               database: writes the WAL back and empties it – the load test
//               runs it before every scenario, so every scenario starts from
//               the same WAL state
//   reload    makes every pooled connection reload the schema – and with it
//             the statistics – before its next statement (a CREATE + DROP of
//             a scratch table changes the schema cookie). ANALYZE into an
//             existing sqlite_stat1 does not do that: open read connections
//             keep planning with what they loaded when they were opened. In
//             production they pick the statistics up as they are replaced –
//             PocketBase closes connections that are idle for 3 minutes
//             (core/base.go) – so after a night every connection has them;
//             "optimize" + "reload" reach that state at once.
routerAdd(
  "POST",
  "/api/loadtest/planner-stats",
  (e) => {
    const body = JSON.parse(JSON.stringify(e.requestInfo().body || {}));
    const action = body.action;
    if (action !== "status" && action !== "optimize" && action !== "reload" && action !== "checkpoint") {
      throw new BadRequestError('"action" must be "status", "optimize", "reload" or "checkpoint".');
    }

    const started = Date.now();
    if (action === "optimize") {
      e.app.nonconcurrentDB().newQuery("PRAGMA optimize").execute();
    } else if (action === "checkpoint") {
      e.app.nonconcurrentDB().newQuery("PRAGMA wal_checkpoint(TRUNCATE)").execute();
    } else if (action === "reload") {
      e.app.nonconcurrentDB().newQuery("CREATE TABLE _loadtest_schema_bump (x INTEGER)").execute();
      e.app.nonconcurrentDB().newQuery("DROP TABLE _loadtest_schema_bump").execute();
    }
    const durationMs = Date.now() - started;

    const rows = arrayOf(new DynamicModel({ tbl: "", idx: "", stat: "" }));
    e.app
      .nonconcurrentDB()
      .newQuery("SELECT tbl, COALESCE(idx, '') AS idx, stat FROM sqlite_stat1 ORDER BY tbl, idx")
      .all(rows);
    const stat1 = [];
    for (let i = 0; i < rows.length; i++) {
      stat1.push({ tbl: rows[i].tbl, idx: rows[i].idx, stat: rows[i].stat });
    }
    return e.json(200, { action, durationMs, stat1 });
  },
  $apis.requireSuperuserAuth(),
);

// ---------------------------------------------------------------------------
// POST /api/loadtest/explain   (superusers only)
//   body:     {"sql": "SELECT …", "params": {"name": "value", …}}
//   response: {"plan": ["SEARCH b USING INDEX idx_bookings_created (created>? AND created<?)", …]}
//
// EXPLAIN QUERY PLAN of one SELECT statement with bound {:name} parameters –
// planned, never executed. Runs on the write connection: that is the one
// "PRAGMA optimize" ran on, so its plans always reflect the current
// statistics (a pooled read connection may still hold an older schema).
routerAdd(
  "POST",
  "/api/loadtest/explain",
  (e) => {
    const body = JSON.parse(JSON.stringify(e.requestInfo().body || {}));
    const sql = typeof body.sql === "string" ? body.sql.trim() : "";
    if (!/^select\s/i.test(sql) || sql.indexOf(";") !== -1) {
      throw new BadRequestError('"sql" must be a single SELECT statement.');
    }
    const params = body.params && typeof body.params === "object" ? body.params : {};

    const rows = arrayOf(new DynamicModel({ id: 0, parent: 0, notused: 0, detail: "" }));
    e.app
      .nonconcurrentDB()
      .newQuery("EXPLAIN QUERY PLAN " + sql)
      .bind(params)
      .all(rows);
    const plan = [];
    for (let i = 0; i < rows.length; i++) {
      plan.push(rows[i].detail);
    }
    return e.json(200, { plan });
  },
  $apis.requireSuperuserAuth(),
);
