import { describe, expect, it } from "vitest";
import { client, createGroup, createOffering, createPerson, createUser, expectApiError, seededAdmin, uid } from "./helpers";

describe("catalog permissions (groups, offerings)", () => {
  it("lets any authenticated user read groups and offerings, but not guests", async () => {
    const user = await createUser();
    expect((await user.pb.collection("groups").getList(1, 10)).totalItems).toBeGreaterThan(0);
    expect((await user.pb.collection("offerings").getList(1, 10)).totalItems).toBeGreaterThan(0);
    expect((await client().collection("offerings").getList(1, 10)).totalItems).toBe(0);
  });

  it("does not let non-admins create, update or delete groups", async () => {
    const admin = await seededAdmin();
    const user = await createUser();
    const group = await createGroup(admin);

    await expectApiError(user.pb.collection("groups").create({ name: uid("Gruppe ") }), 400);
    await expectApiError(user.pb.collection("groups").update(group.id, { name: uid("x") }), 404);
    await expectApiError(user.pb.collection("groups").delete(group.id), 404);
    expect((await admin.collection("groups").getOne(group.id)).name).toBe(group.name);
  });

  it("does not let non-admins create, update or delete offerings", async () => {
    const admin = await seededAdmin();
    const user = await createUser();
    const offering = await createOffering(admin, { priceCents: 250 });

    await expectApiError(
      user.pb.collection("offerings").create({ name: uid("x"), group: offering.group, priceCents: 1, active: true }),
      400,
    );
    await expectApiError(user.pb.collection("offerings").update(offering.id, { priceCents: 1 }), 404);
    await expectApiError(user.pb.collection("offerings").update(offering.id, { active: false }), 404);
    await expectApiError(user.pb.collection("offerings").delete(offering.id), 404);
    expect(await admin.collection("offerings").getOne(offering.id)).toMatchObject({ priceCents: 250, active: true });
  });

  it("lets admins manage groups and offerings (negative and zero prices allowed)", async () => {
    const admin = await createUser({ role: "admin" });
    const group = await admin.pb.collection("groups").create({ name: uid("Gruppe "), sortOrder: 5 });
    const offering = await admin.pb
      .collection("offerings")
      .create({ name: "Pfand zurück", group: group.id, priceCents: -200, active: true, sortOrder: 1 });
    expect(offering.priceCents).toBe(-200);

    const free = await admin.pb.collection("offerings").update(offering.id, { priceCents: 0, active: false });
    expect(free).toMatchObject({ priceCents: 0, active: false });

    await expectApiError(admin.pb.collection("offerings").update(offering.id, { priceCents: 100001 }), 400);
    await expectApiError(admin.pb.collection("offerings").update(offering.id, { priceCents: 1.5 }), 400);
  });

  it("enforces unique group names and unique offering names per group (case-insensitive)", async () => {
    const admin = await seededAdmin();
    const group = await createGroup(admin);
    const err = await expectApiError(admin.collection("groups").create({ name: group.name.toUpperCase() }), 400);
    expect(err.response.data.name?.code).toBe("validation_not_unique");

    const offering = await createOffering(admin, { group: group.id, name: "Cola" });
    await expectApiError(createOffering(admin, { group: group.id, name: "COLA" }), 400);
    // the same name in another group is fine
    const other = await createOffering(admin, { name: "Cola" });
    expect(other.group).not.toBe(offering.group);
  });

  it("treats umlauts case-insensitively too (SQLite NOCASE only folds ASCII)", async () => {
    const admin = await seededAdmin();
    const seeded = await expectApiError(admin.collection("groups").create({ name: "GETRÄNKE" }), 400);
    expect(seeded.response).toMatchObject({
      message: "Failed to create record.",
      data: { name: { code: "validation_not_unique" } },
    });

    const suffix = uid("");
    const group = await createGroup(admin, { name: `Säfte ${suffix}` });
    const renamed = await expectApiError(
      admin.collection("groups").update((await createGroup(admin)).id, { name: `SÄFTE ${suffix}` }),
      400,
    );
    expect(renamed.response).toMatchObject({
      message: "Failed to update record.",
      data: { name: { code: "validation_not_unique" } },
    });

    await createOffering(admin, { group: group.id, name: "Äpfelsaft" });
    const offering = await expectApiError(createOffering(admin, { group: group.id, name: "äPFELSAFT" }), 400);
    expect(offering.response.data.name?.code).toBe("validation_not_unique");
    // other group: fine; unchanged name on update: fine
    const elsewhere = await createOffering(admin, { name: "ÄPFELSAFT" });
    expect((await admin.collection("offerings").update(elsewhere.id, { name: "ÄPFELSAFT", priceCents: 5 })).priceCents).toBe(5);
  });
});

describe("persons permissions", () => {
  it("lets authenticated users create and update persons, but not guests", async () => {
    const user = await createUser();
    const person = await createPerson(user.pb, { name: "Max", nickname: "Maxi" });
    const updated = await user.pb.collection("persons").update(person.id, { nickname: "Der Max" });
    expect(updated.nickname).toBe("Der Max");

    await expectApiError(client().collection("persons").create({ number: uid("g") }), 400);
  });

  it("only lets admins delete persons", async () => {
    const admin = await seededAdmin();
    const user = await createUser();
    const person = await createPerson(user.pb);

    await expectApiError(user.pb.collection("persons").delete(person.id), 404);
    await admin.collection("persons").delete(person.id);
    await expectApiError(admin.collection("persons").getOne(person.id), 404);
  });

  it("trims person numbers and enforces uniqueness case-insensitively", async () => {
    const user = await createUser();
    const number = uid("Nr-");
    const person = await createPerson(user.pb, { number: `  ${number}  ` });
    expect(person.number).toBe(number);

    for (const duplicate of [number, number.toUpperCase(), ` ${number.toLowerCase()} `]) {
      const error = await expectApiError(createPerson(user.pb, { number: duplicate }), 400);
      expect(error.response.data.number?.code, duplicate).toBe("validation_not_unique");
    }
  });

  it("validates the person number", async () => {
    const user = await createUser();
    for (const number of ["", "with space", "a/b", "x".repeat(21)]) {
      const error = await expectApiError(createPerson(user.pb, { number }), 400);
      expect(error.response.data.number, JSON.stringify(number)).toBeDefined();
    }
  });
});
