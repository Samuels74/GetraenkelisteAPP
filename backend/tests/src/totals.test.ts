import { describe, expect, it } from "vitest";
import {
  PB_URL,
  book,
  createGroup,
  createOffering,
  createPerson,
  createUser,
  expectApiError,
  seededAdmin,
  sleep,
  superuser,
  toIso,
  totals,
  totalsParts,
  uid,
  type Totals,
} from "./helpers";

/** Same instant as the ISO string, written with the given UTC offset (e.g. "+02:00", "-05:30"). */
function withOffset(iso: string, offset: string): string {
  const sign = offset.startsWith("-") ? -1 : 1;
  const minutes = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  const shifted = new Date(new Date(iso).getTime() + minutes * 60 * 1000).toISOString();
  return shifted.replace("Z", offset);
}

const INVALID_DATE = (param: string) =>
  `Ungültiger Wert für "${param}": erwartet wird ein Datum im ISO-8601-Format.`;

const INVALID_PARTS =
  'Ungültiger Wert für "parts": erwartet wird eine durch Kommas getrennte Auswahl aus summary, perPerson, perOffering, perUser.';

const MALFORMED_QUERY = 'Ungültiger Wert in der Abfrage: ";" und "%" müssen URL-kodiert sein (%3B, %25).';

const PARTS = ["summary", "perPerson", "perOffering", "perUser"] as const;
type Part = (typeof PARTS)[number];

/** Response keys of the given parts, sorted (PocketBase writes JSON object keys in random order). */
function keysOf(parts: readonly Part[]): string[] {
  return parts.flatMap((part) => (part === "summary" ? ["count", "quantity", "totalCents"] : [part])).sort();
}

const sortedKeys = (value: object) => Object.keys(value).sort();

/** The full response restricted to the given parts – what ?parts= must return. */
function restrict(full: Totals, parts: readonly Part[]): Partial<Totals> {
  return Object.fromEntries(keysOf(parts).map((key) => [key, full[key as keyof Totals]]));
}

/** A user with own bookings on two persons and two offerings (filter createdBy = the user). */
async function partsFixture() {
  const admin = await seededAdmin();
  const user = await createUser({ name: "Teile" });
  const group = await createGroup(admin);
  const cola = await createOffering(admin, { group: group.id, name: "Cola", priceCents: 250, sortOrder: 2 });
  const wasser = await createOffering(admin, { group: group.id, name: "Wasser", priceCents: 100, sortOrder: 1 });
  const p1 = await createPerson(user.pb, { name: "Eins" });
  const p2 = await createPerson(user.pb, { name: "Zwei" });
  const b1 = await book(user.pb, p1.id, cola.id, 2);
  await sleep(15);
  await book(user.pb, p1.id, wasser.id, 1);
  await book(user.pb, p2.id, cola.id, 1);
  return { user, p1, p2, firstBooking: b1, own: { createdBy: user.record.id } };
}

describe("GET /api/app/totals", () => {
  it("requires an authenticated users record", async () => {
    const res = await fetch(`${PB_URL}/api/app/totals`);
    expect(res.status).toBe(401);
    // superusers are not "users" records
    await expectApiError(totals(await superuser()), 403);
  });

  it("aggregates per person, offering and user with the documented shape and order", async () => {
    const admin = await seededAdmin();
    const prefix = uid("x");
    const anna = await createUser({ prefix: `a${prefix}`, name: "Anna" });
    const ben = await createUser({ prefix: `b${prefix}`, name: "Ben" });

    // perOffering: group sortOrder first (Pfand has the highest offering
    // sortOrder but is in the first group), then offering sortOrder
    const early = await createGroup(admin, { sortOrder: 1 });
    const late = await createGroup(admin, { sortOrder: 2 });
    const cola = await createOffering(admin, { group: late.id, name: "Cola", priceCents: 250, sortOrder: 20 });
    const wasser = await createOffering(admin, { group: late.id, name: "Wasser", priceCents: 100, sortOrder: 10 });
    const pfand = await createOffering(admin, { group: early.id, name: "Pfand", priceCents: -200, sortOrder: 99 });

    const p2 = await createPerson(anna.pb, { number: `${prefix}-2`, name: "Zweite", nickname: "Zwo" });
    const p1 = await createPerson(anna.pb, { number: `${prefix}-1`, name: "Erste", nickname: "" });

    await book(anna.pb, p1.id, cola.id, 2); // 500
    await book(anna.pb, p1.id, wasser.id, 1); // 100
    await book(ben.pb, p1.id, pfand.id, 1); // -200
    await book(ben.pb, p2.id, cola.id, 3); // 750

    // restrict to this test's data: bookings of anna + ben on p1/p2
    const annaTotals = await totals(anna.pb, { createdBy: anna.record.id });
    expect(annaTotals).toMatchObject({ count: 2, quantity: 3, totalCents: 600 });

    const p1Totals = await totals(ben.pb, { person: p1.id });
    expect(p1Totals).toEqual({
      count: 3,
      quantity: 4,
      totalCents: 400,
      perPerson: [
        { personId: p1.id, number: `${prefix}-1`, name: "Erste", nickname: "", count: 3, quantity: 4, totalCents: 400 },
      ],
      perOffering: [
        { offeringId: pfand.id, name: "Pfand", groupId: early.id, groupName: early.name, count: 1, quantity: 1, totalCents: -200 },
        { offeringId: wasser.id, name: "Wasser", groupId: late.id, groupName: late.name, count: 1, quantity: 1, totalCents: 100 },
        { offeringId: cola.id, name: "Cola", groupId: late.id, groupName: late.name, count: 1, quantity: 2, totalCents: 500 },
      ],
      perUser: [
        { userId: anna.record.id, username: anna.username, name: "Anna", count: 2, quantity: 3, totalCents: 600 },
        { userId: ben.record.id, username: ben.username, name: "Ben", count: 1, quantity: 1, totalCents: -200 },
      ],
    });

    const benTotals = await totals(anna.pb, { createdBy: ben.record.id });
    expect(benTotals).toMatchObject({ count: 2, quantity: 4, totalCents: 550 });
    expect(benTotals.perPerson.map((p) => p.number)).toEqual([`${prefix}-1`, `${prefix}-2`]);
    expect(benTotals.perUser.map((u) => u.userId)).toEqual([ben.record.id]);

    const combined = await totals(anna.pb, { createdBy: ben.record.id, person: p2.id });
    expect(combined).toMatchObject({ count: 1, quantity: 3, totalCents: 750 });

    // price changes don't affect the totals of existing bookings
    await admin.collection("offerings").update(cola.id, { priceCents: 999 });
    expect(await totals(ben.pb, { person: p1.id })).toMatchObject({ totalCents: 400 });
  });

  it("is consistent without filters (sums of all breakdowns equal the total)", async () => {
    const user = await createUser();
    const all = await totals(user.pb);
    for (const list of [all.perPerson, all.perOffering, all.perUser]) {
      expect(list.reduce((sum, row) => sum + row.count, 0)).toBe(all.count);
      expect(list.reduce((sum, row) => sum + row.quantity, 0)).toBe(all.quantity);
      expect(list.reduce((sum, row) => sum + row.totalCents, 0)).toBe(all.totalCents);
    }
  });

  it("filters by from (inclusive) and to (exclusive) on the booking creation time", async () => {
    const admin = await seededAdmin();
    const user = await createUser();
    const offering = await createOffering(admin, { priceCents: 100 });
    const person = await createPerson(user.pb);

    const b1 = await book(user.pb, person.id, offering.id, 1);
    await sleep(15);
    const b2 = await book(user.pb, person.id, offering.id, 2);
    await sleep(15);
    const b3 = await book(user.pb, person.id, offering.id, 4);
    expect(b1.created < b2.created && b2.created < b3.created).toBe(true);

    const q = (extra: Record<string, string>) => totals(user.pb, { person: person.id, ...extra });

    expect(await q({})).toMatchObject({ count: 3, quantity: 7 });
    expect(await q({ from: toIso(b2.created) })).toMatchObject({ count: 2, quantity: 6 });
    expect(await q({ to: toIso(b2.created) })).toMatchObject({ count: 1, quantity: 1 });
    expect(await q({ from: toIso(b2.created), to: toIso(b3.created) })).toMatchObject({ count: 1, quantity: 2 });

    // other notations of the same instant
    expect(await q({ from: withOffset(toIso(b2.created), "+02:00") })).toMatchObject({ count: 2, quantity: 6 });
    expect(await q({ from: withOffset(toIso(b2.created), "-05:30") })).toMatchObject({ count: 2, quantity: 6 });
    expect(await q({ to: b2.created })).toMatchObject({ count: 1, quantity: 1 }); // storage format accepted too

    // date-only values
    expect(await q({ from: "2000-01-01", to: "2000-01-02" })).toMatchObject({ count: 0, quantity: 0, totalCents: 0 });
    expect(await q({ from: "2000-01-01" })).toMatchObject({ count: 3 });
  });

  it("returns empty breakdowns for filters without matches", async () => {
    const user = await createUser();
    expect(await totals(user.pb, { person: "doesnotexist123" })).toEqual({
      count: 0,
      quantity: 0,
      totalCents: 0,
      perPerson: [],
      perOffering: [],
      perUser: [],
    });
  });

  it("accepts only the documented date formats", async () => {
    const user = await createUser();
    const valid = [
      "2024-02-29", // leap day
      "0001-01-01",
      "2026-01-01T10:00Z",
      "2026-01-01T10:00:05Z",
      "2026-01-01T10:00:05.1Z",
      "2026-01-01T10:00:05.123Z",
      "2026-01-01T10:00:05.123456789+02:00",
      "2026-01-01T10:00-05:30",
      "2026-01-01 10:00:00Z", // storage format
      "2026-01-01 10:00:00.123Z",
    ];
    for (const value of valid) {
      await expect(totals(user.pb, { from: value, to: value }), value).resolves.toMatchObject({ count: 0 });
    }
  });

  it("rejects malformed and calendar-invalid dates with 400", async () => {
    const user = await createUser();
    const invalid = [
      "1",
      "2026",
      "gestern",
      "2026-02-30", // calendar-invalid
      "2026-02-29", // 2026 is no leap year
      "2026-04-31",
      "2026-13-01",
      "2026-00-10",
      "2026-01-00",
      "2026-1-1",
      " 2026-01-01",
      "2026-01-01T10:00", // zone required
      "2026-01-01T10:00:00",
      "2026-01-01T24:00Z",
      "2026-01-01T10:60Z",
      "2026-01-01T10:00:60Z",
      "2026-01-01T10:00:00.Z",
      "2026-01-01T10:00:00.1234567890Z",
      "2026-01-01t10:00z",
      "2026-01-01T10:00+2:00",
      "2026-01-01T10:00+24:00",
      "2026-01-01T10:00+0200",
      "2026-01-01 10:00Z", // storage format needs seconds
      "2026-01-01 10:00:00+02:00", // storage format is UTC only
      "2026-01-01 10:00:00",
    ];
    for (const value of invalid) {
      for (const param of ["from", "to"]) {
        const error = await expectApiError(totals(user.pb, { [param]: value }), 400, INVALID_DATE(param));
        expect(error.response.data, `${param}=${value}`).toEqual({});
      }
    }
  });

  it("treats empty date parameters as no filter", async () => {
    const user = await createUser();
    await expect(totals(user.pb, { from: "", to: "  " })).resolves.toHaveProperty("count");
  });

  it("treats filter values as data, not SQL", async () => {
    const user = await createUser();
    const res = await totals(user.pb, { person: "x' OR 1=1 --", createdBy: '" OR ""="' });
    expect(res.count).toBe(0);
  });

  it("rejects a raw ';' or an invalid %-escape in the query (the filter would silently vanish)", async () => {
    const user = await createUser();
    const get = (query: string) =>
      fetch(`${PB_URL}/api/app/totals?${query}`, { headers: { Authorization: user.pb.authStore.token } });
    const malformed = [
      "parts=summary&from=2099-01-01;x",
      "from=2099-01-01;&parts=summary",
      "parts=summary;perUser",
      "person=nobody;x",
      "person=%zz",
      "from=%2",
      "parts=summary&x=50%",
    ];
    for (const query of malformed) {
      const res = await get(query);
      expect(res.status, query).toBe(400);
      expect(((await res.json()) as { message: string }).message, query).toBe(MALFORMED_QUERY);
    }
    // encoded, both characters are ordinary data (as the SDK sends them)
    const encoded = await get("parts=summary&person=nobody%3Bx%25");
    expect(encoded.status).toBe(200);
    expect(await encoded.json()).toMatchObject({ count: 0 });
  });
});

describe("GET /api/app/totals?parts=", () => {
  it("returns only the requested part – for each part alone", async () => {
    const { user, own } = await partsFixture();
    const full = await totals(user.pb, own);
    expect(full).toMatchObject({ count: 3, quantity: 4, totalCents: 850 });

    for (const part of PARTS) {
      const res = await totalsParts(user.pb, { ...own, parts: part });
      expect(sortedKeys(res), part).toEqual(keysOf([part]));
      expect(res, part).toEqual(restrict(full, [part]));
    }
  });

  it("combines parts, whatever order they are requested in", async () => {
    const { user, own } = await partsFixture();
    const full = await totals(user.pb, own);

    const combinations: Array<[Record<string, string | string[]>, Part[]]> = [
      [{ parts: "perOffering,perUser" }, ["perOffering", "perUser"]], // the admin badges
      [{ parts: "perUser,summary" }, ["summary", "perUser"]],
      [{ parts: " perPerson , summary " }, ["summary", "perPerson"]], // entries are trimmed
      [{ parts: "summary,summary" }, ["summary"]], // duplicates are harmless
      [{ parts: ["summary", "perUser"] }, ["summary", "perUser"]], // repeated parameter (SDK array)
      [{ parts: ["", "perOffering"] }, ["perOffering"]], // empty values are ignored
      [{ parts: "perUser,perOffering,perPerson,summary" }, [...PARTS]],
    ];
    for (const [query, parts] of combinations) {
      const res = await totalsParts(user.pb, { ...own, ...query });
      expect(sortedKeys(res), JSON.stringify(query)).toEqual(keysOf(parts));
      expect(res, JSON.stringify(query)).toEqual(restrict(full, parts));
    }
  });

  it("applies every filter to the requested parts", async () => {
    const { user, p1, firstBooking, own } = await partsFixture();
    const filters: Array<Record<string, string>> = [
      { person: p1.id },
      { ...own, person: p1.id },
      { ...own, to: toIso(firstBooking.created) }, // before the first booking: nothing
      { ...own, from: toIso(firstBooking.created) },
      { from: "2000-01-01", to: "2000-01-02" },
    ];
    for (const filter of filters) {
      const full = await totals(user.pb, filter);
      for (const parts of [["summary"], ["perPerson"], ["perOffering", "perUser"]] as Part[][]) {
        const res = await totalsParts(user.pb, { ...filter, parts: parts.join(",") });
        expect(res, `${JSON.stringify(filter)} ${parts}`).toEqual(restrict(full, parts));
      }
    }
    // the filters really apply (not just both sides empty)
    expect(await totalsParts(user.pb, { person: p1.id, parts: "summary" })).toEqual({ count: 2, quantity: 3, totalCents: 600 });
    expect(await totalsParts(user.pb, { ...own, to: toIso(firstBooking.created), parts: "summary,perPerson" })).toEqual({
      count: 0,
      quantity: 0,
      totalCents: 0,
      perPerson: [],
    });
  });

  it("returns the full response when parts is missing, empty or blank", async () => {
    const { user, own } = await partsFixture();
    const full = await totals(user.pb, own);
    expect(sortedKeys(full)).toEqual(keysOf(PARTS));

    for (const parts of ["", "   ", ["", " "]]) {
      const res = await totalsParts(user.pb, { ...own, parts });
      expect(sortedKeys(res), JSON.stringify(parts)).toEqual(sortedKeys(full));
      expect(res, JSON.stringify(parts)).toEqual(full);
    }
  });

  it("rejects unknown or empty part names with 400", async () => {
    const user = await createUser();
    const invalid: Array<string | string[]> = [
      "foo",
      "Summary", // names are case-sensitive
      "perperson",
      "count", // a response key, not a part
      "summary,",
      ",",
      "summary,,perUser",
      "summary;perUser",
      "summary perUser",
      ["summary", "foo"], // every repeated value is checked
    ];
    for (const parts of invalid) {
      const error = await expectApiError(totalsParts(user.pb, { parts }), 400, INVALID_PARTS);
      expect(error.response.data, JSON.stringify(parts)).toEqual({});
    }
    // a valid parts value does not hide an invalid date
    await expectApiError(totalsParts(user.pb, { parts: "summary", from: "gestern" }), 400, INVALID_DATE("from"));
    // percent-escapes that are no valid UTF-8 (sent raw, the SDK would escape the "%")
    for (const raw of ["%FF", "summary,%C3", "summary&parts=%E2%82"]) {
      const res = await fetch(`${PB_URL}/api/app/totals?parts=${raw}`, { headers: { Authorization: user.pb.authStore.token } });
      expect(res.status, raw).toBe(400);
      expect(((await res.json()) as { message: string }).message, raw).toBe(INVALID_PARTS);
    }
  });

  it("still requires an authenticated users record", async () => {
    const res = await fetch(`${PB_URL}/api/app/totals?parts=summary`);
    expect(res.status).toBe(401);
    await expectApiError(totalsParts(await superuser(), { parts: "foo" }), 403);
  });
});
