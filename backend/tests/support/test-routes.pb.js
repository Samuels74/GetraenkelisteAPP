// TEST ONLY – copied into the throw-away PocketBase of the API tests by
// setup/global-setup.ts. Never deployed. All routes are superuser-only.
//
// model-delete: deletes a record with a plain model delete ($app.delete),
// i.e. without the REST record handlers and their request hooks, to prove
// that the delete guards also hold outside of the REST API.
// explain: the query plan of a SELECT (index checks), see below.
// held-write: a write that commits at the moment the test chooses (races), see below.

routerAdd(
  "POST",
  "/api/test/model-delete/{collection}/{id}",
  (e) => {
    const record = e.app.findRecordById(e.request.pathValue("collection"), e.request.pathValue("id"));
    e.app.delete(record);
    return e.noContent(204);
  },
  $apis.requireSuperuserAuth(),
);

// EXPLAIN QUERY PLAN of one SELECT statement with bound {:name} parameters –
// planned, never executed – so the tests can check which index a query uses
// (src/indexes.test.ts). Runs on the regular (read) connection pool, like the
// app's queries.
routerAdd(
  "POST",
  "/api/test/explain",
  (e) => {
    const body = JSON.parse(JSON.stringify(e.requestInfo().body || {}));
    const sql = typeof body.sql === "string" ? body.sql.trim() : "";
    if (!/^select\s/i.test(sql) || sql.indexOf(";") !== -1) {
      throw new BadRequestError('"sql" must be a single SELECT statement.');
    }
    const params = body.params && typeof body.params === "object" ? body.params : {};
    const rows = arrayOf(new DynamicModel({ id: 0, parent: 0, notused: 0, detail: "" }));
    e.app.db().newQuery("EXPLAIN QUERY PLAN " + sql).bind(params).all(rows);
    const plan = [];
    for (let i = 0; i < rows.length; i++) {
      plan.push(rows[i].detail);
    }
    return e.json(200, { plan });
  },
  $apis.requireSuperuserAuth(),
);

// held-write – deterministic races (src/races.test.ts):
//   POST /api/test/held-write/{key}
//     body {"op": "delete", "collection": "…", "id": "…"}
//       or {"op": "create", "collection": "…", "data": {…}}
//       or {"op": "update", "collection": "…", "id": "…", "data": {…}}
//     Opens a transaction – it holds PocketBase's single write connection,
//     like every write of the hooks – marks {key} as held, waits until {key}
//     is released (at most 15 s), then performs the plain model write (the
//     model hooks run, the API rules don't) in that transaction and commits.
//     Answers {"id": "…"} or the error of the write.
//   GET  /api/test/held-write/{key}
//     {"held": true, "blocked": n} while it waits: n = the number of requests
//     that have started to wait for the write connection since the write is
//     held, i.e. that are blocked by it (the wait count of Go's pool of
//     PocketBase's write connections – there is only one). The tests release
//     a held write only once the request under test is blocked by it, never
//     after a fixed time.
//   POST /api/test/held-write/{key}/release  lets it write and commit
// A request sent while the write is held either waits for the write
// connection before its checks (they then see the held write) or – without
// the transactions of the hooks – checks the old state and waits only to
// write afterwards.
routerAdd(
  "POST",
  "/api/test/held-write/{key}",
  (e) => {
    const key = `held-write:${e.request.pathValue("key")}`;
    const body = JSON.parse(JSON.stringify(e.requestInfo().body || {}));
    const store = e.app.store();
    let id = "";
    try {
      e.app.runInTransaction((txApp) => {
        // e.app is the app outside the transaction: its write connection pool
        store.set(`${key}:waits`, e.app.nonconcurrentDB().db().stats().waitCount);
        store.set(key, "held");
        const deadline = Date.now() + 15000;
        while (store.get(key) !== "released") {
          if (Date.now() > deadline) {
            throw new BadRequestError("held-write: not released within 15 s");
          }
          sleep(5);
        }
        if (body.op === "delete") {
          txApp.delete(txApp.findRecordById(body.collection, body.id));
          id = body.id;
        } else if (body.op === "create" || body.op === "update") {
          const record =
            body.op === "create"
              ? new Record(txApp.findCollectionByNameOrId(body.collection))
              : txApp.findRecordById(body.collection, body.id);
          record.load(body.data || {});
          txApp.save(record);
          id = record.id;
        } else {
          throw new BadRequestError('"op" must be "delete", "create" or "update".');
        }
      });
    } finally {
      store.remove(key);
      store.remove(`${key}:waits`);
    }
    return e.json(200, { id });
  },
  $apis.requireSuperuserAuth(),
);

routerAdd(
  "GET",
  "/api/test/held-write/{key}",
  (e) => {
    const key = `held-write:${e.request.pathValue("key")}`;
    const store = e.app.store();
    const held = store.get(key) === "held";
    const blocked = held ? e.app.nonconcurrentDB().db().stats().waitCount - store.get(`${key}:waits`) : 0;
    return e.json(200, { held, blocked });
  },
  $apis.requireSuperuserAuth(),
);

routerAdd(
  "POST",
  "/api/test/held-write/{key}/release",
  (e) => {
    e.app.store().set(`held-write:${e.request.pathValue("key")}`, "released");
    return e.noContent(204);
  },
  $apis.requireSuperuserAuth(),
);
