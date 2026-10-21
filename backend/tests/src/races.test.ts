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
  sleep,
  superuser,
  uid,
  withOnlyActiveAdmins,
} from "./helpers";

// Writes at the same moment, made deterministic (bug hunt M1, L2, N2). The
// test-only route /api/test/held-write (support/test-routes.pb.js) opens a
// write transaction and waits; the REST request under test is sent while it
// waits; once that request is blocked by the held write – it waits for the
// write connection – the held write commits. The hooks check and write in ONE
// transaction (lib/rules.js runInWriteTransaction): the request waits for
// the write connection, and its checks see the held write. Without that, the
// request checked the old state right away and wrote after the held write –
// e.g. a booking for a person deleted in between (a dangling reference).
// No fixed waiting time: a request that is slow to arrive is waited for, and
// one that is never blocked by the held write fails the test – it would not
// exercise the race.

/** How long the request under test may take to run into the held write – generous on purpose (busy CI). */
const BLOCK_TIMEOUT_MS = 10_000;

interface HeldWrite {
  /**
   * Waits until `request` is blocked by the held write (waits for the write
   * connection the held write holds), then lets the held write commit and
   * resolves with its response. Fails if the request finishes first or is
   * not blocked within BLOCK_TIMEOUT_MS. Releases the held write in any case.
   */
  release(request: Promise<unknown>): Promise<{ status: number; body: { id?: string; message?: string } }>;
}

async function holdWrite(su: PocketBase, op: Record<string, unknown>): Promise<HeldWrite> {
  const url = `${PB_URL}/api/test/held-write/${uid("held")}`;
  const headers = { Authorization: su.authStore.token, "Content-Type": "application/json" };
  const state = async () => (await (await fetch(url, { headers })).json()) as { held: boolean; blocked: number };
  const done = fetch(url, { method: "POST", headers, body: JSON.stringify(op) }).then(async (res) => ({
    status: res.status,
    body: (await res.json()) as { id?: string; message?: string },
  }));
  const started = Date.now();
  while (!(await state()).held) {
    if (Date.now() - started > BLOCK_TIMEOUT_MS) {
      throw new Error(`the held write ${JSON.stringify(op)} did not start: ${JSON.stringify(await done)}`);
    }
    await sleep(5);
  }
  return {
    async release(request) {
      let settled = false;
      request.then(
        () => (settled = true),
        () => (settled = true),
      );
      try {
        const sent = Date.now();
        for (;;) {
          const { blocked } = await state();
          if (settled) {
            throw new Error(
              `the request under test finished while ${JSON.stringify(op)} was held – it did not wait for the held write, the race was not exercised`,
            );
          }
          if (blocked > 0) {
            break; // the request waits for the write connection: its response can only come after the commit
          }
          if (Date.now() - sent > BLOCK_TIMEOUT_MS) {
            throw new Error(`the request under test was not blocked by ${JSON.stringify(op)} within ${BLOCK_TIMEOUT_MS} ms`);
          }
          await sleep(5);
        }
      } finally {
        await fetch(`${url}/release`, { method: "POST", headers }); // never leave the write connection held
      }
      return done;
    },
  };
}

/** A request whose outcome is asserted later: marked as handled now (no unhandled rejection meanwhile). */
function pending<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

async function count(su: PocketBase, collection: string, field: string, id: string): Promise<number> {
  const list = await su.collection(collection).getList(1, 1, { filter: su.filter(`${field} = {:id}`, { id }) });
  return list.totalItems;
}

describe("a record deleted while a write references it", () => {
  it("fails the booking of a person deleted meanwhile – no booking points to a deleted person", async () => {
    const admin = await seededAdmin();
    const su = await superuser();
    const user = await createUser();
    const offering = await createOffering(admin);
    const person = await createPerson(user.pb);

    const held = await holdWrite(su, { op: "delete", collection: "persons", id: person.id });
    const booking = pending(expectApiError(book(user.pb, person.id, offering.id), 400));
    expect((await held.release(booking)).status).toBe(200);

    expect((await booking).response.data.person?.code).toBe("validation_missing_rel_records");
    expect(await count(su, "bookings", "person", person.id)).toBe(0);
  });

  it("fails the booking of an offering deleted meanwhile", async () => {
    const admin = await seededAdmin();
    const su = await superuser();
    const user = await createUser();
    const offering = await createOffering(admin);
    const person = await createPerson(user.pb);

    const held = await holdWrite(su, { op: "delete", collection: "offerings", id: offering.id });
    const booking = pending(expectApiError(book(user.pb, person.id, offering.id), 400));
    expect((await held.release(booking)).status).toBe(200);

    expect((await booking).response.data.offering?.code).toBe("validation_missing_rel_records");
    expect(await count(su, "bookings", "offering", offering.id)).toBe(0);
  });

  it("fails the first booking of a user deleted meanwhile", async () => {
    const admin = await seededAdmin();
    const su = await superuser();
    const user = await createUser();
    const offering = await createOffering(admin);
    const person = await createPerson(user.pb);

    const held = await holdWrite(su, { op: "delete", collection: "users", id: user.record.id });
    const booking = pending(expectApiError(book(user.pb, person.id, offering.id), 400));
    expect((await held.release(booking)).status).toBe(200);

    expect((await booking).response.data.createdBy?.code).toBe("validation_missing_rel_records");
    expect(await count(su, "bookings", "createdBy", user.record.id)).toBe(0);
  });

  it("fails creating an offering in, or moving one into, a group deleted meanwhile", async () => {
    const admin = await seededAdmin();
    const su = await superuser();
    const offering = await createOffering(admin);

    for (const write of ["create", "move"] as const) {
      const group = await createGroup(admin);
      const held = await holdWrite(su, { op: "delete", collection: "groups", id: group.id });
      const request =
        write === "create"
          ? admin.collection("offerings").create({ name: uid("Angebot "), group: group.id, priceCents: 0, active: true })
          : admin.collection("offerings").update(offering.id, { group: group.id });
      const saved = pending(expectApiError(request, 400));
      expect((await held.release(saved)).status, write).toBe(200);

      expect((await saved).response.data.group?.code, write).toBe("validation_missing_rel_records");
      expect(await count(su, "offerings", "group", group.id), write).toBe(0);
    }
  });
});

describe("a delete while a write that references the record commits", () => {
  // Without the transaction PocketBase's own check in the delete transaction
  // still refused it – with an English message instead of the German one.
  it("rejects deleting the person, offering or user of a booking written meanwhile – German message", async () => {
    const admin = await seededAdmin();
    const su = await superuser();

    for (const target of ["persons", "offerings", "users"] as const) {
      const user = await createUser();
      const offering = await createOffering(admin);
      const person = await createPerson(user.pb);
      const held = await holdWrite(su, {
        op: "create",
        collection: "bookings",
        data: { person: person.id, offering: offering.id, quantity: 1, createdBy: user.record.id },
      });
      const [id, message] = {
        persons: [person.id, MESSAGES.personHasBookings],
        offerings: [offering.id, MESSAGES.offeringHasBookings],
        users: [user.record.id, MESSAGES.userHasBookings],
      }[target];
      const deletion = pending(expectApiError(admin.collection(target).delete(id), 400, message));
      expect((await held.release(deletion)).status, target).toBe(200);

      await deletion;
      expect((await su.collection(target).getOne(id)).id, target).toBe(id);
    }
  });

  it("rejects deleting a group while an offering in it is written – German message", async () => {
    const admin = await seededAdmin();
    const su = await superuser();
    const group = await createGroup(admin);

    const held = await holdWrite(su, {
      op: "create",
      collection: "offerings",
      data: { name: uid("Angebot "), group: group.id, priceCents: 0, active: true },
    });
    const deletion = pending(expectApiError(admin.collection("groups").delete(group.id), 400, MESSAGES.groupHasOfferings));
    expect((await held.release(deletion)).status).toBe(200);

    await deletion;
    expect(await count(su, "offerings", "group", group.id)).toBe(1);
  });
});

describe("names taken at the same moment", () => {
  it("rejects a group name that only differs in case from one written meanwhile", async () => {
    const admin = await seededAdmin();
    const su = await superuser();
    const suffix = uid("");

    const held = await holdWrite(su, { op: "create", collection: "groups", data: { name: `Säfte ${suffix}` } });
    const created = pending(expectApiError(admin.collection("groups").create({ name: `SÄFTE ${suffix}` }), 400));
    expect((await held.release(created)).status).toBe(200);

    expect((await created).response.data.name?.code).toBe("validation_not_unique");
  });

  it("rejects renaming an offering to a look-alike of one written meanwhile in the same group", async () => {
    const admin = await seededAdmin();
    const su = await superuser();
    const group = await createGroup(admin);
    const other = await createOffering(admin, { group: group.id });
    const suffix = uid("");

    const held = await holdWrite(su, {
      op: "create",
      collection: "offerings",
      data: { name: `Äpfelsaft ${suffix}`, group: group.id, priceCents: 0, active: true },
    });
    const renamed = pending(
      expectApiError(admin.collection("offerings").update(other.id, { name: `A\u0308PFELSAFT ${suffix}` }), 400),
    );
    expect((await held.release(renamed)).status).toBe(200);

    expect((await renamed).response.data.name?.code).toBe("validation_not_unique");
  });
});

describe("admins acting at the same moment", () => {
  it("rejects an admin's change of another user once their own admin rights are gone – demote, disable, delete", async () => {
    const su = await superuser();
    const admin = await createUser({ role: "admin" });
    const target = await createUser({ role: "admin" });

    for (const [revoke, change] of [
      [{ role: "user" }, (pb: PocketBase) => pb.collection("users").update(target.record.id, { role: "user" })],
      [{ disabled: true }, (pb: PocketBase) => pb.collection("users").update(target.record.id, { disabled: true })],
      [{ role: "user" }, (pb: PocketBase) => pb.collection("users").delete(target.record.id)],
    ] as const) {
      const actor = await createUser({ role: "admin" });
      // e.g. "target" demotes "actor" while "actor" demotes "target"
      const held = await holdWrite(su, { op: "update", collection: "users", id: actor.record.id, data: revoke });
      const attempt = pending(expectApiError(change(actor.pb), 403, MESSAGES.noLongerAdmin));
      expect((await held.release(attempt)).status).toBe(200);

      await attempt;
      expect(await su.collection("users").getOne(target.record.id)).toMatchObject({ role: "admin", disabled: false });
    }
    expect((await admin.pb.collection("users").update(target.record.id, { name: "Noch Admin" })).name).toBe("Noch Admin");
  });

  it("keeps the last active admin when two changes at the same moment would remove both", async () => {
    const su = await superuser();
    const first = await createUser({ role: "admin" });
    const second = await createUser({ role: "admin" });

    await withOnlyActiveAdmins(su, [first.record.id, second.record.id], async () => {
      const held = await holdWrite(su, { op: "update", collection: "users", id: first.record.id, data: { role: "user" } });
      const disabling = pending(
        expectApiError(su.collection("users").update(second.record.id, { disabled: true }), 400, MESSAGES.lastActiveAdmin),
      );
      expect((await held.release(disabling)).status).toBe(200);

      await disabling;
      expect(await su.collection("users").getOne(second.record.id)).toMatchObject({ role: "admin", disabled: false });
    });
  });
});
