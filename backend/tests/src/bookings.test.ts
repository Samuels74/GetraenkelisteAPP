import { describe, expect, it } from "vitest";
import {
  MESSAGES,
  book,
  client,
  createOffering,
  createPerson,
  createUser,
  expectApiError,
  seededAdmin,
  superuser,
} from "./helpers";

describe("bookings: creation", () => {
  it("sets createdBy and unitPriceCents server-side, ignoring client values", async () => {
    const admin = await seededAdmin();
    const user = await createUser();
    const other = await createUser();
    const offering = await createOffering(admin, { priceCents: 350 });
    const person = await createPerson(user.pb);

    const booking = await book(user.pb, person.id, offering.id, 2, {
      unitPriceCents: 1,
      createdBy: other.record.id,
    });
    expect(booking).toMatchObject({
      person: person.id,
      offering: offering.id,
      quantity: 2,
      unitPriceCents: 350,
      createdBy: user.record.id,
    });
  });

  it("snapshots the price also for bookings created by a superuser (dashboard)", async () => {
    const admin = await seededAdmin();
    const su = await superuser();
    const user = await createUser();
    const offering = await createOffering(admin, { priceCents: 420 });
    const person = await createPerson(user.pb);

    const booking = await book(su, person.id, offering.id, 1, { unitPriceCents: 1, createdBy: user.record.id });
    expect(booking).toMatchObject({ unitPriceCents: 420, createdBy: user.record.id });
  });

  it("rejects booking inactive offerings", async () => {
    const admin = await seededAdmin();
    const user = await createUser();
    const offering = await createOffering(admin, { active: false });
    const person = await createPerson(user.pb);

    await expectApiError(book(user.pb, person.id, offering.id), 400, MESSAGES.offeringInactive);
    await expectApiError(book(await superuser(), person.id, offering.id, 1, { createdBy: user.record.id }), 400, MESSAGES.offeringInactive);

    await admin.collection("offerings").update(offering.id, { active: true });
    expect((await book(user.pb, person.id, offering.id)).offering).toBe(offering.id);
  });

  it("keeps the price of existing bookings when the offering price changes", async () => {
    const admin = await seededAdmin();
    const user = await createUser();
    const offering = await createOffering(admin, { priceCents: 150 });
    const person = await createPerson(user.pb);

    const first = await book(user.pb, person.id, offering.id);
    expect(first.unitPriceCents).toBe(150);

    await admin.collection("offerings").update(offering.id, { priceCents: 275, name: `${offering.name} neu` });
    const second = await book(user.pb, person.id, offering.id);
    expect(second.unitPriceCents).toBe(275);
    expect((await user.pb.collection("bookings").getOne(first.id)).unitPriceCents).toBe(150);
  });

  it("validates quantity (1…99) and required relations", async () => {
    const admin = await seededAdmin();
    const user = await createUser();
    const offering = await createOffering(admin);
    const person = await createPerson(user.pb);

    for (const quantity of [0, 100, 1.5, -1]) {
      await expectApiError(book(user.pb, person.id, offering.id, quantity), 400);
    }
    await expectApiError(user.pb.collection("bookings").create({ person: person.id, quantity: 1 }), 400);
    await expectApiError(book(user.pb, person.id, "doesnotexist123"), 400);
    expect((await book(user.pb, person.id, offering.id, 99)).quantity).toBe(99);
  });

  it("does not let guests book", async () => {
    const admin = await seededAdmin();
    const offering = await createOffering(admin);
    const person = await createPerson(admin);
    await expectApiError(book(client(), person.id, offering.id), 400);
  });
});

describe("bookings: update & delete", () => {
  it("does not allow updates (superusers only)", async () => {
    const admin = await seededAdmin();
    const user = await createUser();
    const offering = await createOffering(admin);
    const person = await createPerson(user.pb);
    const booking = await book(user.pb, person.id, offering.id);

    await expectApiError(user.pb.collection("bookings").update(booking.id, { quantity: 5 }), 403);
    await expectApiError(admin.collection("bookings").update(booking.id, { quantity: 5 }), 403);
  });

  it("lets users delete their own bookings, admins all, but nobody else's", async () => {
    const seeded = await seededAdmin();
    const admin = await createUser({ role: "admin" });
    const anna = await createUser();
    const ben = await createUser();
    const offering = await createOffering(seeded);
    const person = await createPerson(anna.pb);

    const annasBooking = await book(anna.pb, person.id, offering.id);
    const bensBooking = await book(ben.pb, person.id, offering.id);

    await expectApiError(ben.pb.collection("bookings").delete(annasBooking.id), 404);
    await anna.pb.collection("bookings").delete(annasBooking.id);
    await expectApiError(anna.pb.collection("bookings").getOne(annasBooking.id), 404);

    await admin.pb.collection("bookings").delete(bensBooking.id);
    await expectApiError(ben.pb.collection("bookings").getOne(bensBooking.id), 404);
  });
});
