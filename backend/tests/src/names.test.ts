import type PocketBase from "pocketbase";
import { describe, expect, it } from "vitest";
import {
  PB_URL,
  createGroup,
  createOffering,
  createPerson,
  createUser,
  expectApiError,
  login,
  seededAdmin,
  superuser,
  uid,
} from "./helpers";

// Names are stored normalized when a save sets or changes them (lib/rules.js):
// control characters removed, whitespace runs → one space, trimmed, NFC.
// Unique names (groups, offerings – normalizeName) also lose every invisible
// format character (Unicode Cf); display names (persons name/nickname, users
// name – normalizeText) keep them, so emoji sequences joined by a zero-width
// joiner stay intact. The uniqueness checks compare normalized names with
// case folding, so names that only look alike are duplicates. A value that a
// save leaves unchanged stays as stored (names saved by an older version).

/** Overwrites columns directly in the database (superuser SQL API, no hooks) – data as an older version stored it. */
async function storeRaw(su: PocketBase, table: string, id: string, values: Record<string, string>): Promise<void> {
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const assignments = Object.entries(values).map(([column, value]) => `"${column}" = ${literal(value)}`);
  const res = await fetch(`${PB_URL}/api/sql`, {
    method: "POST",
    headers: { Authorization: su.authStore.token, "Content-Type": "application/json" },
    body: JSON.stringify({ query: `UPDATE ${table} SET ${assignments.join(", ")} WHERE id = ${literal(id)}` }),
  });
  expect(res.status, await res.text()).toBe(200);
}

describe("names are stored normalized", () => {
  it("removes invisible characters, collapses whitespace, trims and composes (NFC)", async () => {
    const admin = await seededAdmin();
    const suffix = uid("");
    const cases: Array<[string, string]> = [
      [`\u00a0 Säft\u200be \t ${suffix}\n`, `Säfte ${suffix}`], // NBSP, zero-width space, tab, newline
      [`Sa\u0308fte2 ${suffix}`, `Säfte2 ${suffix}`], // "a" + combining diaeresis → "ä"
      [`Bier\u00ad\u2060/Wein ${suffix}`, `Bier/Wein ${suffix}`], // soft hyphen, word joiner
      [`\u202eRTL\u202c\ufeff ${suffix}`, `RTL ${suffix}`], // bidi override, byte order mark
      [`Kaffee\u3000\u2003${suffix}`, `Kaffee ${suffix}`], // ideographic / em space
      [`Tee\u0007\u0085 ${suffix}`, `Tee ${suffix}`], // control characters
      // unique names: the zero-width joiner goes too – the woman cook falls apart (documented trade-off)
      [`\u{1F469}\u200d\u{1F373} Küche ${suffix}`, `\u{1F469}\u{1F373} Küche ${suffix}`],
    ];
    for (const [input, stored] of cases) {
      expect((await admin.collection("groups").create({ name: input })).name, JSON.stringify(input)).toBe(stored);
    }
  });

  it("normalizes offering names as well – on create and on update", async () => {
    const admin = await seededAdmin();
    const offering = await createOffering(admin, { name: ` Apfel\u200bsaft  ${uid("")} ` });
    expect(offering.name).toMatch(/^Apfelsaft \S+$/);
    expect((await admin.collection("offerings").update(offering.id, { name: "Apfelsaft\u2003pur " })).name).toBe(
      "Apfelsaft pur",
    );
  });

  it("normalizes person and user names as display names – on create and on update", async () => {
    const user = await createUser({ name: "  Anna\u00a0 Mu\u0308ller\u0007 " });
    expect(user.record.name).toBe("Anna Müller");

    // whitespace, controls and NFC like the unique names – but format characters (here a zero-width space) stay
    const person = await createPerson(user.pb, { name: " Jo\u0308rg \u0085 Huber ", nickname: "\tJö\u200b " });
    expect(person).toMatchObject({ name: "Jörg Huber", nickname: "Jö\u200b" });
    expect((await user.pb.collection("persons").update(person.id, { nickname: "  Der\u00a0Jörg " })).nickname).toBe(
      "Der Jörg",
    );

    const relogged = await login(user.username, user.password);
    expect((await relogged.collection("users").update(user.record.id, { name: " Anna \u00a0M. " })).name).toBe("Anna M.");
  });

  it("keeps emoji sequences intact in person and user names – zero-width joiner, tag characters", async () => {
    const cook = "\u{1F469}\u200d\u{1F373} Köchin"; // woman + ZWJ + frying pan = woman cook
    const rainbow = "\u{1F3F3}\ufe0f\u200d\u{1F308} Regenbogen"; // white flag + VS16 + ZWJ + rainbow
    const scotland = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} Schottland"; // tag sequence
    const user = await createUser({ name: `${cook} ` });
    expect(user.record.name).toBe(cook);

    const person = await createPerson(user.pb, { name: cook, nickname: ` ${rainbow}` });
    expect(person).toMatchObject({ name: cook, nickname: rainbow });
    expect((await user.pb.collection("persons").update(person.id, { name: scotland })).name).toBe(scotland);

    const relogged = await login(user.username, user.password);
    expect((await relogged.collection("users").update(user.record.id, { name: rainbow })).name).toBe(rainbow);
  });

  it("keeps names that are already normalized – umlauts, punctuation, emoji", async () => {
    const admin = await seededAdmin();
    const suffix = uid("");
    for (const name of [`Bier/Wein ${suffix}`, `Anna-Lena Müller ${suffix}`, `🍺 Bier ${suffix}`, `Kaffee ☕\ufe0f ${suffix}`]) {
      expect((await admin.collection("groups").create({ name })).name).toBe(name);
    }
  });

  it("rejects names that are empty after the normalization", async () => {
    const admin = await seededAdmin();
    const group = await createGroup(admin);
    for (const name of ["   ", "\t\n", "\u00a0", "\u200b", "\u200b \ufeff\u00ad"]) {
      const groupError = await expectApiError(admin.collection("groups").create({ name }), 400);
      expect(groupError.response.data.name?.code, JSON.stringify(name)).toBe("validation_required");
      const offeringError = await expectApiError(
        admin.collection("offerings").create({ name, group: group.id, priceCents: 0, active: true }),
        400,
      );
      expect(offeringError.response.data.name?.code, JSON.stringify(name)).toBe("validation_required");
    }
  });
});

describe("look-alike names are duplicates", () => {
  it("treats extra or invisible characters, decomposed letters and case as the same group name", async () => {
    const admin = await seededAdmin();
    const name = `Säfte ${uid("")}`;
    await createGroup(admin, { name });
    const variants = [
      `${name} `,
      `\u00a0${name}`,
      name.replace(" ", "  "),
      name.replace("ä", "a\u0308"),
      name.replace("ft", "f\u200bt"),
      name.toUpperCase(),
    ];
    for (const variant of variants) {
      const error = await expectApiError(admin.collection("groups").create({ name: variant }), 400);
      expect(error.response.data.name?.code, JSON.stringify(variant)).toBe("validation_not_unique");
    }
  });

  it("folds case fully: ß, ẞ and SS are the same", async () => {
    const admin = await seededAdmin();
    const suffix = uid("");
    await createGroup(admin, { name: `Straße ${suffix}` });
    for (const variant of [`STRASSE ${suffix}`, `STRAẞE ${suffix}`, `strasse ${suffix}`]) {
      const error = await expectApiError(admin.collection("groups").create({ name: variant }), 400);
      expect(error.response.data.name?.code, variant).toBe("validation_not_unique");
    }
  });

  it("applies to offering names within a group (both fields flagged), not across groups", async () => {
    const admin = await seededAdmin();
    const group = await createGroup(admin);
    const name = `Äpfelsaft ${uid("")}`;
    await createOffering(admin, { group: group.id, name });
    for (const variant of [name.replace("Ä", "A\u0308"), name.replace("pf", "p\u200df"), ` ${name.toLowerCase()} `]) {
      const error = await expectApiError(createOffering(admin, { group: group.id, name: variant }), 400);
      expect(error.response.data, JSON.stringify(variant)).toMatchObject({
        group: { code: "validation_not_unique" },
        name: { code: "validation_not_unique" },
      });
    }
    expect((await createOffering(admin, { name: name.replace("Ä", "A\u0308") })).name).toBe(name);
  });

  it("compares with names stored before the normalization existed", async () => {
    const su = await superuser();
    const admin = await seededAdmin();
    const suffix = uid("");
    const id = `${uid("l")}000000000000000`.slice(0, 15);
    const res = await fetch(`${PB_URL}/api/sql`, {
      method: "POST",
      headers: { Authorization: su.authStore.token, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `INSERT INTO groups (id, name, sortOrder, created, updated) VALUES ('${id}', '  Altlast\u00a0 ${suffix} ', 0, '', '')`,
      }),
    });
    expect(res.status, await res.text()).toBe(200);

    const error = await expectApiError(admin.collection("groups").create({ name: `ALTLAST ${suffix}` }), 400);
    expect(error.response.data.name?.code).toBe("validation_not_unique");
    await admin.collection("groups").delete(id);
  });
});

// Review 4 L2: an update that does not change a name neither rewrites it nor
// fails because of it – reorders, price, number and password changes of
// data from before the normalization keep working.
describe("names stored by an older version stay until a save changes them", () => {
  it("leaves an older person name untouched on a number-only update, normalizes it once it is changed", async () => {
    const su = await superuser();
    const user = await createUser();
    const person = await createPerson(user.pb);
    const name = "Alt  Name"; // double space
    const nickname = "\u200b Spitz\u0007 "; // zero-width space, control character, spaces
    await storeRaw(su, "persons", person.id, { name, nickname });

    const persons = user.pb.collection("persons");
    expect(await persons.update(person.id, { number: uid("n") })).toMatchObject({ name, nickname });
    // the person form sends every field – unchanged values stay as they are
    expect(await persons.update(person.id, { number: uid("n"), name, nickname })).toMatchObject({ name, nickname });
    expect(await persons.update(person.id, { name: `${name} neu` })).toMatchObject({ name: "Alt Name neu", nickname });
  });

  it("lets a group with an older blank name be reordered – a new blank name is still rejected", async () => {
    const su = await superuser();
    const admin = await seededAdmin();
    const group = await createGroup(admin);
    await storeRaw(su, "groups", group.id, { name: "   " });

    expect(await admin.collection("groups").update(group.id, { sortOrder: 7 })).toMatchObject({ name: "   ", sortOrder: 7 });
    const error = await expectApiError(admin.collection("groups").update(group.id, { name: "\u200b " }), 400);
    expect(error.response.data.name?.code).toBe("validation_required");
    await admin.collection("groups").delete(group.id);
  });

  it("does not let older look-alikes block unrelated updates – a new look-alike is still rejected", async () => {
    const su = await superuser();
    const admin = await seededAdmin();
    const groups = admin.collection("groups");
    const offerings = admin.collection("offerings");
    const suffix = uid("");

    // groups "Säfte …" and an older "Säfte … " (trailing space): both can be reordered
    const first = await createGroup(admin, { name: `Säfte ${suffix}`, sortOrder: 1 });
    const second = await createGroup(admin, { sortOrder: 2 });
    await storeRaw(su, "groups", second.id, { name: `Säfte ${suffix} ` });
    expect((await groups.update(first.id, { sortOrder: 2 })).sortOrder).toBe(2);
    expect(await groups.update(second.id, { sortOrder: 1 })).toMatchObject({ name: `Säfte ${suffix} `, sortOrder: 1 });
    // renaming it to something new works; back to a look-alike does not
    expect((await groups.update(second.id, { name: ` Saefte  ${suffix}` })).name).toBe(`Saefte ${suffix}`);
    const renamed = await expectApiError(groups.update(second.id, { name: `SÄFTE ${suffix}` }), 400);
    expect(renamed.response.data.name?.code).toBe("validation_not_unique");

    // offerings "Bier …" and an older "Bier\u00a0…" (no-break space) in one group: both can be repriced
    const bier = await createOffering(admin, { group: first.id, name: `Bier ${suffix}` });
    const older = await createOffering(admin, { group: first.id });
    await storeRaw(su, "offerings", older.id, { name: `Bier\u00a0${suffix}` });
    expect((await offerings.update(bier.id, { priceCents: 250 })).priceCents).toBe(250);
    expect(await offerings.update(older.id, { priceCents: 260 })).toMatchObject({ name: `Bier\u00a0${suffix}`, priceCents: 260 });
    // moving a look-alike into the group is a change of the uniqueness scope: rejected
    const elsewhere = await createOffering(admin, { group: second.id, name: `BIER ${suffix}` });
    const moved = await expectApiError(offerings.update(elsewhere.id, { group: first.id }), 400);
    expect(moved.response.data).toMatchObject({ group: { code: "validation_not_unique" }, name: { code: "validation_not_unique" } });
  });

  it("leaves an older user name untouched when an admin resets the password", async () => {
    const su = await superuser();
    const admin = await seededAdmin();
    const user = await createUser();
    await storeRaw(su, "users", user.record.id, { name: "Alt  Nutzer\u0007" });

    const reset = await admin
      .collection("users")
      .update(user.record.id, { password: "anotherpass1", passwordConfirm: "anotherpass1" });
    expect(reset).toMatchObject({ name: "Alt  Nutzer\u0007", mustChangePassword: true });
    expect((await admin.collection("users").update(user.record.id, { name: "Alt  Nutzer\u0007" })).name).toBe(
      "Alt  Nutzer\u0007",
    );
    expect((await admin.collection("users").update(user.record.id, { name: " Neu  Nutzer " })).name).toBe("Neu Nutzer");
  });
});
