/// <reference path="../../../.pb/dev-data/types.d.ts" />

// Aggregations for GET /api/app/totals – docs/ARCHITECTURE.md §5.
// All user input is bound as SQL parameters.
//
// Every aggregate scans the filtered bookings, so a caller asks only for the
// parts it shows (?parts=, see parseParts): the per-person breakdown – one
// row per person, the bulk of the response and of the server time – is
// needed only by Personen and "Pro Person"; the summary (count, sum) and the
// small per-offering / per-user breakdowns cost a fraction of it.

// The parts of the response that can be requested with ?parts=:
// "summary" = count, quantity, totalCents; the others = the arrays.
const PARTS = ["summary", "perPerson", "perOffering", "perUser"];

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

// A raw ";" or a "%" without two hex digits after it (anywhere in the query)
const MALFORMED_QUERY = /;|%(?![0-9A-Fa-f]{2})/;

/**
 * Rejects a query string that Go's query parser would read only partly: it
 * silently drops every pair with a raw ";" or an invalid %-escape
 * (?from=2026-10-01;x, ?person=%zz) – the filter would vanish and the
 * response would show the totals of all bookings instead of an error. The
 * SDK and browsers always encode both characters (%3B, %25).
 *
 * @param {string} rawQuery  e.request.url.rawQuery
 */
function assertWellFormedQuery(rawQuery) {
  if (MALFORMED_QUERY.test(String(rawQuery || ""))) {
    throw new BadRequestError(
      'Ungültiger Wert in der Abfrage: ";" und "%" müssen URL-kodiert sein (%3B, %25).',
    );
  }
}

/**
 * All values of one query parameter in request order – also repeated
 * parameters (?parts=a&parts=b), which the SDK sends for array values.
 * Reads Go's canonical re-encoding of the already parsed query
 * (url.Values.Encode): malformed pairs would be dropped there – the route
 * rejects them first (assertWellFormedQuery). Escapes of bytes that are no
 * valid UTF-8 (e.g. %FF) survive and decode to U+FFFD, i.e. to a value that
 * matches nothing.
 *
 * @param {string} encodedQuery  e.request.url.query().encode()
 * @param {string} name
 * @returns {string[]}
 */
function queryValues(encodedQuery, name) {
  const decode = (s) => {
    try {
      return decodeURIComponent(s.replace(/\+/g, " "));
    } catch (_) {
      return "�";
    }
  };
  const values = [];
  for (const pair of String(encodedQuery || "").split("&")) {
    const eq = pair.indexOf("=");
    const key = eq < 0 ? pair : pair.slice(0, eq);
    if (key !== "" && decode(key) === name) {
      values.push(eq < 0 ? "" : decode(pair.slice(eq + 1)));
    }
  }
  return values;
}

/**
 * Which parts of the response to compute. "parts" is a comma-separated
 * subset of PARTS; repeated parameters are combined. Missing or empty (also
 * blank) → all parts, i.e. the full response. Entries are trimmed; an empty
 * or unknown entry → 400.
 *
 * @param {string[]} values  all values of the "parts" query parameter
 * @returns {Object<string, boolean>}  part name → requested
 */
function parseParts(values) {
  const requested = {};
  const texts = (values || []).map(String).filter((text) => text.trim() !== "");
  if (texts.length === 0) {
    for (const part of PARTS) {
      requested[part] = true;
    }
    return requested;
  }
  for (const text of texts) {
    for (const entry of text.split(",")) {
      const part = entry.trim();
      if (PARTS.indexOf(part) < 0) {
        throw new BadRequestError(
          `Ungültiger Wert für "parts": erwartet wird eine durch Kommas getrennte Auswahl aus ${PARTS.join(", ")}.`,
        );
      }
      requested[part] = true;
    }
  }
  return requested;
}

const AGGREGATES = `
  COUNT(*) AS "count",
  COALESCE(SUM(b."quantity"), 0) AS "quantity",
  COALESCE(SUM(b."quantity" * b."unitPriceCents"), 0) AS "totalCents"`;

// The breakdowns aggregate the bookings first (subquery t) and join the few
// result rows to persons / offerings / users afterwards: one lookup per
// person, offering or user instead of one per booking. That also keeps the
// plan independent of the planner statistics of these small tables – on a
// new installation PocketBase's "PRAGMA optimize" after a schema migration
// records them with only their seed rows (1 user, 1 group, 7 offerings), the
// nightly optimize does not correct that, and with the join inside the
// aggregation SQLite then scanned the users table once per booking
// (per-user totals twice as slow).
const AGGREGATED = `t."count" AS "count", t."quantity" AS "quantity", t."totalCents" AS "totalCents"`;

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
 * The totals for the filters of the query – only the requested parts; the
 * keys of the other parts are omitted (an empty array would read as "no
 * bookings"). Without "parts" the response is the full one, as before.
 *
 * @param {core.App} app
 * @param {Object<string, any>} query  request query (first value per key)
 * @param {string[]} [partsValues]  all values of the "parts" parameter (see queryValues)
 */
function computeTotals(app, query, partsValues) {
  const { where, params } = buildFilter(query);
  const parts = parseParts(partsValues);
  // (PocketBase writes the keys of a JS object in random order – clients
  // must not rely on the key order, today's full response included)
  const result = {};

  if (parts.summary) {
    const [totals] = queryAll(
      app,
      `SELECT ${AGGREGATES} FROM "bookings" b ${where}`,
      params,
      { count: 0, quantity: 0, totalCents: 0 },
    );
    result.count = totals.count;
    result.quantity = totals.quantity;
    result.totalCents = totals.totalCents;
  }

  if (parts.perPerson) {
    result.perPerson = queryAll(
      app,
      `SELECT
         t."personId" AS "personId",
         COALESCE(p."number", '') AS "number",
         COALESCE(p."name", '') AS "name",
         COALESCE(p."nickname", '') AS "nickname",
         ${AGGREGATED}
       FROM (
         SELECT b."person" AS "personId", ${AGGREGATES}
         FROM "bookings" b
         ${where}
         GROUP BY b."person"
       ) t
       LEFT JOIN "persons" p ON p."id" = t."personId"
       ORDER BY p."number" COLLATE NOCASE, t."personId"`,
      params,
      { personId: "", number: "", name: "", nickname: "", count: 0, quantity: 0, totalCents: 0 },
    );
  }

  if (parts.perOffering) {
    result.perOffering = queryAll(
      app,
      `SELECT
         t."offeringId" AS "offeringId",
         COALESCE(o."name", '') AS "name",
         COALESCE(o."group", '') AS "groupId",
         COALESCE(g."name", '') AS "groupName",
         ${AGGREGATED}
       FROM (
         SELECT b."offering" AS "offeringId", ${AGGREGATES}
         FROM "bookings" b
         ${where}
         GROUP BY b."offering"
       ) t
       LEFT JOIN "offerings" o ON o."id" = t."offeringId"
       LEFT JOIN "groups" g ON g."id" = o."group"
       ORDER BY g."sortOrder", g."name" COLLATE NOCASE, g."id",
                o."sortOrder", o."name" COLLATE NOCASE, t."offeringId"`,
      params,
      { offeringId: "", name: "", groupId: "", groupName: "", count: 0, quantity: 0, totalCents: 0 },
    );
  }

  if (parts.perUser) {
    result.perUser = queryAll(
      app,
      `SELECT
         t."userId" AS "userId",
         COALESCE(u."username", '') AS "username",
         COALESCE(u."name", '') AS "name",
         ${AGGREGATED}
       FROM (
         SELECT b."createdBy" AS "userId", ${AGGREGATES}
         FROM "bookings" b
         ${where}
         GROUP BY b."createdBy"
       ) t
       LEFT JOIN "users" u ON u."id" = t."userId"
       ORDER BY u."username", t."userId"`,
      params,
      { userId: "", username: "", name: "", count: 0, quantity: 0, totalCents: 0 },
    );
  }

  return result;
}

module.exports = { PARTS, assertWellFormedQuery, computeTotals, parseParts, queryValues, toStorageDateTime };
