/// <reference path="../../../.pb/dev-data/types.d.ts" />

// Aggregations for GET /api/app/totals – docs/ARCHITECTURE.md §5.
// All user input is bound as SQL parameters.

// Accepted date formats (anything else -> 400):
//   YYYY-MM-DD                                   date only, midnight UTC
//   YYYY-MM-DDTHH:MM[:SS[.fff]](Z|±HH:MM)        ISO 8601 datetime with zone
//   YYYY-MM-DD HH:MM:SS[.fff]Z                   PocketBase storage format
// (fractions may have 1–9 digits; precision is milliseconds)
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;
const STORAGE_DATETIME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

/**
 * Validates a date/datetime strictly and converts it into PocketBase's
 * datetime storage format "YYYY-MM-DD HH:MM:SS.sssZ" (UTC).
 *
 * @param {string} value
 * @param {string} param  query parameter name (for the error message)
 * @returns {string}
 */
function toStorageDateTime(value, param) {
  const invalid = () =>
    new BadRequestError(`Ungültiger Wert für "${param}": erwartet wird ein Datum im ISO-8601-Format.`);

  const text = String(value);
  // [year, month, day, hour, minute, second, fraction, zone]
  let parts = DATE_ONLY.exec(text) || ISO_DATETIME.exec(text);
  if (!parts) {
    parts = STORAGE_DATETIME.exec(text);
    if (parts) {
      parts[8] = "Z";
    }
  }
  if (!parts) {
    throw invalid();
  }

  const num = (s) => (s === undefined || s === null || s === "" ? 0 : parseInt(s, 10));
  const year = num(parts[1]);
  const month = num(parts[2]);
  const day = num(parts[3]);
  const hour = num(parts[4]);
  const minute = num(parts[5]);
  const second = num(parts[6]);
  const millis = parts[7] ? parseInt(`${parts[7]}00`.slice(0, 3), 10) : 0;
  const zone = parts[8] || "Z";
  if (hour > 23 || minute > 59 || second > 59) {
    throw invalid();
  }

  // calendar check by round trip (rejects e.g. 2026-02-30 or month 13)
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, millis);
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day) {
    throw invalid();
  }

  let offsetMinutes = 0;
  if (zone !== "Z") {
    const offsetHours = parseInt(zone.slice(1, 3), 10);
    const offsetMins = parseInt(zone.slice(4, 6), 10);
    if (offsetHours > 23 || offsetMins > 59) {
      throw invalid();
    }
    offsetMinutes = (zone[0] === "-" ? -1 : 1) * (offsetHours * 60 + offsetMins);
  }

  const utc = new Date(local.getTime() - offsetMinutes * 60 * 1000);
  if (utc.getUTCFullYear() < 0 || utc.getUTCFullYear() > 9999) {
    throw invalid();
  }
  return utc.toISOString().replace("T", " ");
}

/**
 * Parses the optional filters of the request query.
 *
 * @param {Object<string, any>} query  first value per query parameter
 * @returns {{ where: string, params: Object<string, string> }}
 */
function buildFilter(query) {
  const conditions = [];
  const params = {};
  const raw = (name) => {
    const v = query[name];
    return v === undefined || v === null ? "" : String(v);
  };
  const value = (name) => raw(name).trim();

  // empty values mean "no filter"; non-empty dates are validated as sent
  if (value("from")) {
    params.from = toStorageDateTime(raw("from"), "from");
    conditions.push('b."created" >= {:from}');
  }
  if (value("to")) {
    params.to = toStorageDateTime(raw("to"), "to");
    conditions.push('b."created" < {:to}');
  }
  if (value("person")) {
    params.person = value("person");
    conditions.push('b."person" = {:person}');
  }
  if (value("createdBy")) {
    params.createdBy = value("createdBy");
    conditions.push('b."createdBy" = {:createdBy}');
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

const AGGREGATES = `
  COUNT(*) AS "count",
  COALESCE(SUM(b."quantity"), 0) AS "quantity",
  COALESCE(SUM(b."quantity" * b."unitPriceCents"), 0) AS "totalCents"`;

function queryAll(app, sql, params, shape) {
  const rows = arrayOf(new DynamicModel(shape));
  app.db().newQuery(sql).bind(params).all(rows);

  const result = [];
  for (let i = 0; i < rows.length; i++) {
    const item = {};
    for (const key in shape) {
      item[key] = rows[i][key];
    }
    result.push(item);
  }
  return result;
}

/**
 * @param {core.App} app
 * @param {Object<string, any>} query  request query (first value per key)
 */
function computeTotals(app, query) {
  const { where, params } = buildFilter(query);

  const [totals] = queryAll(
    app,
    `SELECT ${AGGREGATES} FROM "bookings" b ${where}`,
    params,
    { count: 0, quantity: 0, totalCents: 0 },
  );

  const perPerson = queryAll(
    app,
    `SELECT
       b."person" AS "personId",
       COALESCE(p."number", '') AS "number",
       COALESCE(p."name", '') AS "name",
       COALESCE(p."nickname", '') AS "nickname",
       ${AGGREGATES}
     FROM "bookings" b
     LEFT JOIN "persons" p ON p."id" = b."person"
     ${where}
     GROUP BY b."person"
     ORDER BY p."number" COLLATE NOCASE, b."person"`,
    params,
    { personId: "", number: "", name: "", nickname: "", count: 0, quantity: 0, totalCents: 0 },
  );

  const perOffering = queryAll(
    app,
    `SELECT
       b."offering" AS "offeringId",
       COALESCE(o."name", '') AS "name",
       COALESCE(o."group", '') AS "groupId",
       COALESCE(g."name", '') AS "groupName",
       ${AGGREGATES}
     FROM "bookings" b
     LEFT JOIN "offerings" o ON o."id" = b."offering"
     LEFT JOIN "groups" g ON g."id" = o."group"
     ${where}
     GROUP BY b."offering"
     ORDER BY g."sortOrder", g."name" COLLATE NOCASE, g."id",
              o."sortOrder", o."name" COLLATE NOCASE, b."offering"`,
    params,
    { offeringId: "", name: "", groupId: "", groupName: "", count: 0, quantity: 0, totalCents: 0 },
  );

  const perUser = queryAll(
    app,
    `SELECT
       b."createdBy" AS "userId",
       COALESCE(u."username", '') AS "username",
       COALESCE(u."name", '') AS "name",
       ${AGGREGATES}
     FROM "bookings" b
     LEFT JOIN "users" u ON u."id" = b."createdBy"
     ${where}
     GROUP BY b."createdBy"
     ORDER BY u."username", b."createdBy"`,
    params,
    { userId: "", username: "", name: "", count: 0, quantity: 0, totalCents: 0 },
  );

  return {
    count: totals.count,
    quantity: totals.quantity,
    totalCents: totals.totalCents,
    perPerson,
    perOffering,
    perUser,
  };
}

module.exports = { computeTotals, toStorageDateTime };
