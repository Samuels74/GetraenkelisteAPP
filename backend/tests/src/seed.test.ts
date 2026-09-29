import { describe, expect, it } from "vitest";
import { PB_URL, client, expectApiError, seededAdmin, superuser } from "./helpers";

describe("seed data & auth configuration", () => {
  it("logs in the seeded admin with admin/admin (identity is case-insensitive)", async () => {
    const pb = client();
    const auth = await pb.collection("users").authWithPassword("admin", "admin");
    expect(auth.token).toBeTruthy();
    expect(auth.record).toMatchObject({
      username: "admin",
      role: "admin",
      mustChangePassword: true,
      disabled: false,
    });
    expect(auth.record).not.toHaveProperty("email");
    expect(auth.record).not.toHaveProperty("avatar");

    const upper = client();
    await upper.collection("users").authWithPassword("ADMIN", "admin");
    expect(upper.authStore.record?.id).toBe(auth.record.id);
  });

  it("rejects a wrong password", async () => {
    await expectApiError(client().collection("users").authWithPassword("admin", "wrong-password"), 400);
  });

  it("seeds the group Getränke with the 7 offerings", async () => {
    const pb = await seededAdmin();
    const group = await pb.collection("groups").getFirstListItem('name = "Getränke"');
    expect(group.sortOrder).toBe(10);

    const offerings = await pb
      .collection("offerings")
      .getFullList({ filter: pb.filter("group = {:group}", { group: group.id }), sort: "sortOrder" });
    expect(offerings.map((o) => o.name)).toEqual([
      "Bier/Wein",
      "Redbull",
      "Murelli",
      "Mineralwasser",
      "Fruchtsäfte",
      "Kaffee",
      "Pfand",
    ]);
    expect(offerings.map((o) => o.sortOrder)).toEqual([10, 20, 30, 40, 50, 60, 70]);
    for (const offering of offerings) {
      expect(offering.priceCents).toBe(0);
      expect(offering.active).toBe(true);
    }
  });

  it("sets the app name", async () => {
    const su = await superuser();
    const settings = await su.settings.getAll();
    expect(settings.meta.appName).toBe("Getränkeliste");
  });

  it("offers only username/password auth", async () => {
    const methods = await client().collection("users").listAuthMethods();
    expect(methods.password).toEqual({ enabled: true, identityFields: ["username"] });
    expect(methods.oauth2.enabled).toBe(false);
    expect(methods.otp.enabled).toBe(false);
    expect(methods.mfa.enabled).toBe(false);
  });

  it("configures the collections as documented", async () => {
    const su = await superuser();
    const users = await su.collections.getOne("users");
    expect(users.fields.map((f) => f.name)).not.toContain("avatar");
    expect(users.fields.find((f) => f.name === "email")?.required).toBe(false);
    expect(users.authRule).toBe("disabled = false");
    expect(users.indexes.join("\n")).toMatch(/UNIQUE INDEX .* \(`username` COLLATE NOCASE\)/);

    for (const name of ["users", "groups", "offerings", "persons", "bookings"]) {
      const collection = await su.collections.getOne(name);
      const autodates = collection.fields.filter((f) => f.type === "autodate").map((f) => f.name);
      expect(autodates, name).toEqual(expect.arrayContaining(["created", "updated"]));
      for (const relation of collection.fields.filter((f) => f.type === "relation")) {
        expect(relation.cascadeDelete, `${name}.${relation.name}`).toBe(false);
      }
    }
  });

  it("serves the health endpoint", async () => {
    const res = await fetch(`${PB_URL}/api/health`);
    expect(res.status).toBe(200);
  });
});
