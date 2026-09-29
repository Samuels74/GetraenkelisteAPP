import { describe, expect, it } from "vitest";
import type PocketBase from "pocketbase";
import {
  MESSAGES,
  PB_URL,
  book,
  createGroup,
  createOffering,
  createPerson,
  createUser,
  expectApiError,
  seededAdmin,
  superuser,
} from "./helpers";

/** Plain model delete through the test-only route (bypasses the REST record handlers). */
async function modelDelete(su: PocketBase, collection: string, id: string): Promise<Response> {
  return fetch(`${PB_URL}/api/test/model-delete/${collection}/${id}`, {
    method: "POST",
    headers: { Authorization: su.authStore.token },
  });
}

describe("delete guards (REST API)", () => {
  it("rejects deleting an offering with bookings, deletes unbooked ones", async () => {
    const admin = await seededAdmin();
    const user = await createUser();
    const booked = await createOffering(admin);
    const unbooked = await createOffering(admin, { group: booked.group });
    await book(user.pb, (await createPerson(user.pb)).id, booked.id);

    await expectApiError(admin.collection("offerings").delete(booked.id), 400, MESSAGES.offeringHasBookings);
    expect((await admin.collection("offerings").getOne(booked.id)).id).toBe(booked.id);

    await admin.collection("offerings").delete(unbooked.id);
    await expectApiError(admin.collection("offerings").getOne(unbooked.id), 404);
  });

  it("rejects deleting an inactive offering with bookings too", async () => {
    const admin = await seededAdmin();
    const user = await createUser();
    const offering = await createOffering(admin);
    await book(user.pb, (await createPerson(user.pb)).id, offering.id);
    await admin.collection("offerings").update(offering.id, { active: false });

    await expectApiError(admin.collection("offerings").delete(offering.id), 400, MESSAGES.offeringHasBookings);
  });

  it("rejects deleting a person with bookings, deletes persons without", async () => {
    const admin = await seededAdmin();
    const user = await createUser();
    const offering = await createOffering(admin);
    const booked = await createPerson(user.pb);
    const unbooked = await createPerson(user.pb);
    await book(user.pb, booked.id, offering.id);

    await expectApiError(admin.collection("persons").delete(booked.id), 400, MESSAGES.personHasBookings);
    await admin.collection("persons").delete(unbooked.id);
    await expectApiError(admin.collection("persons").getOne(unbooked.id), 404);
  });

  it("rejects deleting a group with (even inactive) offerings, deletes empty groups", async () => {
    const admin = await seededAdmin();
    const group = await createGroup(admin);
    const offering = await createOffering(admin, { group: group.id, active: false });

    await expectApiError(admin.collection("groups").delete(group.id), 400, MESSAGES.groupHasOfferings);

    await admin.collection("offerings").delete(offering.id);
    await admin.collection("groups").delete(group.id);
    await expectApiError(admin.collection("groups").getOne(group.id), 404);
  });

  it("rejects deleting a user who created bookings, deletes users without", async () => {
    const admin = await seededAdmin();
    const booker = await createUser();
    const idle = await createUser();
    const offering = await createOffering(admin);
    await book(booker.pb, (await createPerson(booker.pb)).id, offering.id);

    await expectApiError(admin.collection("users").delete(booker.record.id), 400, MESSAGES.userHasBookings);
    await admin.collection("users").delete(idle.record.id);
  });

  it("applies to superusers (dashboard) as well", async () => {
    const admin = await seededAdmin();
    const su = await superuser();
    const user = await createUser();
    const offering = await createOffering(admin);
    const person = await createPerson(user.pb);
    await book(user.pb, person.id, offering.id);

    await expectApiError(su.collection("offerings").delete(offering.id), 400, MESSAGES.offeringHasBookings);
    await expectApiError(su.collection("persons").delete(person.id), 400, MESSAGES.personHasBookings);
    await expectApiError(su.collection("users").delete(user.record.id), 400, MESSAGES.userHasBookings);
    await expectApiError(su.collection("groups").delete(offering.group), 400, MESSAGES.groupHasOfferings);
  });

  it("allows deleting a person again once all their bookings are cancelled", async () => {
    const admin = await seededAdmin();
    const user = await createUser();
    const offering = await createOffering(admin);
    const person = await createPerson(user.pb);
    const booking = await book(user.pb, person.id, offering.id);

    await expectApiError(admin.collection("persons").delete(person.id), 400, MESSAGES.personHasBookings);
    await user.pb.collection("bookings").delete(booking.id);
    await admin.collection("persons").delete(person.id);
  });
});

describe("delete guards (model level, outside the REST API)", () => {
  it("rejects plain model deletes of referenced records", async () => {
    const admin = await seededAdmin();
    const su = await superuser();
    const user = await createUser();
    const offering = await createOffering(admin);
    const person = await createPerson(user.pb);
    await book(user.pb, person.id, offering.id);

    const cases: Array<[string, string, string]> = [
      ["offerings", offering.id, MESSAGES.offeringHasBookings],
      ["persons", person.id, MESSAGES.personHasBookings],
      ["users", user.record.id, MESSAGES.userHasBookings],
      ["groups", offering.group, MESSAGES.groupHasOfferings],
    ];
    for (const [collection, id, message] of cases) {
      const res = await modelDelete(su, collection, id);
      expect(res.status, collection).toBe(400);
      expect((await res.json()).message, collection).toBe(message);
      expect((await su.collection(collection).getOne(id)).id).toBe(id);
    }
  });

  it("allows plain model deletes of unreferenced records", async () => {
    const admin = await seededAdmin();
    const su = await superuser();
    const group = await createGroup(admin);
    const res = await modelDelete(su, "groups", group.id);
    expect(res.status).toBe(204);
    await expectApiError(su.collection("groups").getOne(group.id), 404);
  });
});
