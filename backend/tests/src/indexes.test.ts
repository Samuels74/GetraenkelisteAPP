import { describe, expect, it } from "vitest";
import { superuser } from "./helpers";

// The bookings indexes and the plans of the "nur meine" queries –
// docs/ARCHITECTURE.md §4 "bookings", load-test finding F8.
//
// The test database is in the state of a new installation: the bookings table
// had no rows when the migrations ran, so SQLite has no statistics for it
// (until PocketBase's nightly "PRAGMA optimize") – nor for the other app
// tables (the migration removes their seed-state statistics). Without the
// composite index "Heute + nur meine" was planned through
// idx_bookings_createdBy, i.e. all bookings of the user were read. The
// statements mirror what the app sends:
// the list SQL as PocketBase builds it for the Buchungen filter, the summary
// query of backend/pb_hooks/lib/totals.js, the delete guard of users.

const COMPOSITE = "CREATE INDEX `idx_bookings_createdBy_created` ON `bookings` (`createdBy`, `created`)";

async function explain(sql: string, params: Record<string, string>): Promise<string> {
  const su = await superuser();
  const { plan } = await su.send<{ plan: string[] }>("/api/test/explain", { method: "POST", body: { sql, params } });
  return plan.join(" | ");
}

const RANGE = { auth: "u1", f: "2026-10-20 00:00:00.000Z", t: "2026-10-21 00:00:00.000Z", u: "u1" };
const list = (where: string) =>
  `SELECT bookings.* FROM bookings WHERE ({:auth} IS NOT '') AND (${where}) ORDER BY bookings.created DESC, bookings.id DESC LIMIT 50`;
const BOTH = /USING (COVERING )?INDEX idx_bookings_createdBy_created \(createdBy=\? AND created>\? AND created<\?\)/;
const USER_ONLY = /USING (COVERING )?INDEX idx_bookings_createdBy_created \(createdBy=\?\)/;

describe("bookings indexes", () => {
  it("has the composite index (createdBy, created) instead of the single-column createdBy index", async () => {
    const su = await superuser();
    const bookings = await su.collections.getOne("bookings");
    expect(bookings.indexes).toContain(COMPOSITE);
    expect(bookings.indexes.some((index: string) => index.includes("`idx_bookings_createdBy`"))).toBe(false);
    // the other single-column indexes stay
    for (const name of ["idx_bookings_person", "idx_bookings_offering", "idx_bookings_created"]) {
      expect(bookings.indexes.some((index: string) => index.includes(`\`${name}\``)), name).toBe(true);
    }
  });

  it("plans the period + \"nur meine\" list through the composite index", async () => {
    const plan = await explain(
      list("(bookings.created >= {:f} AND bookings.created < {:t} AND bookings.createdBy = {:u})"),
      RANGE,
    );
    expect(plan).toMatch(BOTH);
    // rows come in created order: only the id tie-break is sorted
    expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  it("plans the \"nur meine\" list without sorting all bookings of the user", async () => {
    const plan = await explain(list("bookings.createdBy = {:u}"), RANGE);
    expect(plan).toMatch(USER_ONLY);
    expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  it("plans the totals of period + \"nur meine\" through the composite index", async () => {
    const plan = await explain(
      `SELECT COUNT(*) AS "count", COALESCE(SUM(b."quantity"), 0) AS "quantity",
         COALESCE(SUM(b."quantity" * b."unitPriceCents"), 0) AS "totalCents"
       FROM "bookings" b WHERE b."created" >= {:f} AND b."created" < {:t} AND b."createdBy" = {:u}`,
      RANGE,
    );
    expect(plan).toMatch(BOTH);
  });

  it("serves the delete guard of users from the composite index", async () => {
    const plan = await explain("SELECT COUNT(*) FROM `bookings` WHERE `createdBy` = {:u}", RANGE);
    expect(plan).toMatch(USER_ONLY);
  });

  it("keeps no seed-state statistics: a join of users per booking looks users up by id", async () => {
    // with the statistics of the seed state (users: 1 row) SQLite scanned users once per booking
    const plan = await explain(
      `SELECT b."createdBy", COALESCE(u."username", '') AS "username", COUNT(*) AS "count"
       FROM "bookings" b LEFT JOIN "users" u ON u."id" = b."createdBy" GROUP BY b."createdBy"`,
      {},
    );
    expect(plan).toMatch(/SEARCH u USING (COVERING )?INDEX sqlite_autoindex_users_1 \(id=\?\)/);
    expect(plan).not.toContain("SCAN u");
  });
});
