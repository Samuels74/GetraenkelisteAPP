import { describe, expect, it } from "vitest";
import {
  DEFAULT_PASSWORD,
  MESSAGES,
  PB_URL,
  client,
  createOffering,
  createUser,
  expectApiError,
  login,
  seededAdmin,
  superuser,
  totals,
  uid,
} from "./helpers";

describe("users: creation", () => {
  it("does not allow public signup", async () => {
    const username = uid("signup");
    await expectApiError(
      client().collection("users").create({
        username,
        password: DEFAULT_PASSWORD,
        passwordConfirm: DEFAULT_PASSWORD,
        role: "admin",
      }),
      400,
    );
    const admin = await seededAdmin();
    const found = await admin.collection("users").getList(1, 1, { filter: admin.filter("username = {:u}", { u: username }) });
    expect(found.totalItems).toBe(0);
  });

  it("does not allow non-admins to create users", async () => {
    const user = await createUser();
    await expectApiError(
      user.pb.collection("users").create({
        username: uid("byuser"),
        password: DEFAULT_PASSWORD,
        passwordConfirm: DEFAULT_PASSWORD,
      }),
      400,
    );
  });

  it("lets an admin create users: lowercased/trimmed username, default role, must change password", async () => {
    const admin = await seededAdmin();
    const base = uid("new");
    const created = await admin.collection("users").create({
      username: `  ${base.toUpperCase()}  `,
      password: DEFAULT_PASSWORD,
      passwordConfirm: DEFAULT_PASSWORD,
      name: "Neue Person",
      mustChangePassword: false, // ignored: admin-created users always have to change it
    });
    expect(created).toMatchObject({
      username: base,
      role: "user",
      mustChangePassword: true,
      disabled: false,
      name: "Neue Person",
    });
    expect(created).not.toHaveProperty("email");

    // login works with any casing of the username
    const pb = await login(base.toUpperCase(), DEFAULT_PASSWORD);
    expect(pb.authStore.record?.id).toBe(created.id);
  });

  it("requires passwords with at least 8 characters", async () => {
    const admin = await seededAdmin();
    const error = await expectApiError(
      admin.collection("users").create({ username: uid("short"), password: "1234567", passwordConfirm: "1234567" }),
      400,
    );
    expect(error.response.data.password?.code).toBe("validation_min_text_constraint");
  });

  it("enforces unique usernames case-insensitively", async () => {
    const admin = await seededAdmin();
    const { username } = await createUser();
    const error = await expectApiError(
      admin.collection("users").create({
        username: username.toUpperCase(),
        password: DEFAULT_PASSWORD,
        passwordConfirm: DEFAULT_PASSWORD,
      }),
      400,
    );
    expect(error.response.data.username?.code).toBe("validation_not_unique");
  });

  it("validates the username pattern and length", async () => {
    const admin = await seededAdmin();
    for (const username of ["ab", "with space", "ümlaut", "x".repeat(33)]) {
      const error = await expectApiError(
        admin.collection("users").create({ username, password: DEFAULT_PASSWORD, passwordConfirm: DEFAULT_PASSWORD }),
        400,
      );
      expect(error.response.data.username, username).toBeDefined();
    }
  });

  it("lets authenticated users list and view users, but not guests", async () => {
    const user = await createUser();
    const list = await user.pb.collection("users").getList(1, 50);
    expect(list.totalItems).toBeGreaterThan(0);
    for (const item of list.items) {
      expect(item).not.toHaveProperty("email");
    }

    const guest = await client().collection("users").getList(1, 50);
    expect(guest.totalItems).toBe(0);
    await expectApiError(client().collection("users").getOne(user.record.id), 404);
  });
});

describe("users: passwords", () => {
  it("clears mustChangePassword when users change their own password", async () => {
    const user = await createUser();
    expect(user.record.mustChangePassword).toBe(true);

    // oldPassword is required for the own password change
    await expectApiError(
      user.pb.collection("users").update(user.record.id, { password: "new-password-1", passwordConfirm: "new-password-1" }),
      400,
    );

    const updated = await user.pb.collection("users").update(user.record.id, {
      oldPassword: user.password,
      password: "new-password-1",
      passwordConfirm: "new-password-1",
    });
    expect(updated.mustChangePassword).toBe(false);

    // the password change invalidates the old token -> login again
    const relogged = await login(user.username, "new-password-1");
    expect(relogged.authStore.record?.mustChangePassword).toBe(false);
    await expectApiError(login(user.username, user.password), 400);
  });

  it("rejects too short new passwords", async () => {
    const user = await createUser();
    const error = await expectApiError(
      user.pb.collection("users").update(user.record.id, {
        oldPassword: user.password,
        password: "short",
        passwordConfirm: "short",
      }),
      400,
    );
    expect(error.response.data.password?.code).toBe("validation_min_text_constraint");
  });

  it("sets mustChangePassword when an admin resets another user's password (no oldPassword needed)", async () => {
    const admin = await seededAdmin();
    const user = await createUser();
    await user.pb.collection("users").update(user.record.id, {
      oldPassword: user.password,
      password: "changed-by-user",
      passwordConfirm: "changed-by-user",
    });

    const reset = await admin.collection("users").update(user.record.id, {
      password: "reset-by-admin",
      passwordConfirm: "reset-by-admin",
    });
    expect(reset.mustChangePassword).toBe(true);
    const pb = await login(user.username, "reset-by-admin");
    expect(pb.authStore.record?.mustChangePassword).toBe(true);
  });

  it("clears the flag when an admin changes their own password", async () => {
    const admin = await createUser({ role: "admin" });
    expect(admin.record.mustChangePassword).toBe(true);
    const updated = await admin.pb.collection("users").update(admin.record.id, {
      oldPassword: admin.password,
      password: "admin-own-new",
      passwordConfirm: "admin-own-new",
    });
    expect(updated.mustChangePassword).toBe(false);
  });
});

describe("users: own password change requires the current password (admins too)", () => {
  const NEW = "brand-new-pw";
  const cases: Array<[string, Record<string, string>]> = [
    ["missing oldPassword", { password: NEW, passwordConfirm: NEW }],
    ["empty oldPassword", { oldPassword: "", password: NEW, passwordConfirm: NEW }],
    ["wrong oldPassword", { oldPassword: "wrong-password", password: NEW, passwordConfirm: NEW }],
    ["wrong oldPassword + confirm mismatch", { oldPassword: "wrong-password", password: NEW, passwordConfirm: "other-pw" }],
    ["missing oldPassword + empty confirm", { password: NEW, passwordConfirm: "" }],
    ["wrong oldPassword, only confirm", { oldPassword: "wrong-password", passwordConfirm: "other-pw" }],
  ];

  it.each(cases)("rejects %s for admins exactly like for regular users", async (_name, data) => {
    const admin = await createUser({ role: "admin" });
    const user = await createUser();

    const userError = await expectApiError(user.pb.collection("users").update(user.record.id, data), 400);
    const adminError = await expectApiError(admin.pb.collection("users").update(admin.record.id, data), 400);
    expect(adminError.response).toEqual(userError.response);
    expect(adminError.response.message).toBe("Failed to update record.");
    expect(adminError.response.data.oldPassword?.code).toMatch(/^validation_(required|invalid_old_password)$/);

    // nothing changed: both still log in with their current password
    await login(admin.username, admin.password);
    await login(user.username, user.password);
  });

  it("reports a wrong current password as validation_invalid_old_password", async () => {
    const admin = await createUser({ role: "admin" });
    const error = await expectApiError(
      admin.pb.collection("users").update(admin.record.id, { oldPassword: "nope", password: NEW, passwordConfirm: NEW }),
      400,
    );
    expect(error.response.data).toEqual({
      oldPassword: { code: "validation_invalid_old_password", message: "Missing or invalid old password." },
    });
  });

  it("lets admins change their own password with the correct current password", async () => {
    const admin = await createUser({ role: "admin" });
    const updated = await admin.pb.collection("users").update(admin.record.id, {
      oldPassword: admin.password,
      password: NEW,
      passwordConfirm: NEW,
    });
    expect(updated.mustChangePassword).toBe(false);
    await login(admin.username, NEW);
    await expectApiError(login(admin.username, admin.password), 400);
  });

  it("still lets admins and superusers reset other users' passwords without oldPassword", async () => {
    const admin = await createUser({ role: "admin" });
    const otherAdmin = await createUser({ role: "admin" });
    const user = await createUser();

    await admin.pb.collection("users").update(otherAdmin.record.id, { password: NEW, passwordConfirm: NEW });
    await login(otherAdmin.username, NEW);

    const su = await superuser();
    const reset = await su.collection("users").update(user.record.id, { password: NEW, passwordConfirm: NEW });
    expect(reset.mustChangePassword).toBe(true);
    await login(user.username, NEW);
  });
});

describe("users: self-service restrictions", () => {
  it("lets users change their own name (also when unchanged protected values are sent along)", async () => {
    const user = await createUser();
    const updated = await user.pb.collection("users").update(user.record.id, {
      name: "Neuer Name",
      username: user.username,
      role: "user",
      disabled: false,
      mustChangePassword: true,
    });
    expect(updated.name).toBe("Neuer Name");
  });

  it("does not let users change their own role, username, disabled or mustChangePassword", async () => {
    const user = await createUser();
    for (const data of [{ role: "admin" }, { username: uid("renamed") }, { disabled: true }, { mustChangePassword: false }]) {
      await expectApiError(user.pb.collection("users").update(user.record.id, data), 404);
    }
    const fresh = await user.pb.collection("users").getOne(user.record.id);
    expect(fresh).toMatchObject({ role: "user", username: user.username, disabled: false, mustChangePassword: true });
  });

  it("does not let users update other users", async () => {
    const user = await createUser();
    const other = await createUser();
    await expectApiError(user.pb.collection("users").update(other.record.id, { name: "hacked" }), 404);
  });

  it("does not let an admin demote or disable themselves", async () => {
    const admin = await createUser({ role: "admin" });
    await expectApiError(
      admin.pb.collection("users").update(admin.record.id, { role: "user" }),
      400,
      MESSAGES.ownRoleOrDisabled,
    );
    await expectApiError(
      admin.pb.collection("users").update(admin.record.id, { disabled: true }),
      400,
      MESSAGES.ownRoleOrDisabled,
    );
    const fresh = await admin.pb.collection("users").getOne(admin.record.id);
    expect(fresh).toMatchObject({ role: "admin", disabled: false });

    // other changes on the own record are fine
    const renamed = await admin.pb.collection("users").update(admin.record.id, { name: "Chef", role: "admin" });
    expect(renamed.name).toBe("Chef");
  });

  it("lets an admin change the role of other users", async () => {
    const admin = await createUser({ role: "admin" });
    const user = await createUser();
    const promoted = await admin.pb.collection("users").update(user.record.id, { role: "admin" });
    expect(promoted.role).toBe("admin");
    const demoted = await admin.pb.collection("users").update(user.record.id, { role: "user" });
    expect(demoted.role).toBe("user");
  });
});

describe("users: disabling", () => {
  it("prevents login and invalidates existing tokens of disabled users", async () => {
    const admin = await seededAdmin();
    const user = await createUser();
    const token = user.pb.authStore.token;
    await totals(user.pb); // token works

    const disabled = await admin.collection("users").update(user.record.id, { disabled: true });
    expect(disabled.disabled).toBe(true);

    await expectApiError(login(user.username, user.password), 403);
    await expectApiError(user.pb.collection("users").authRefresh(), 401);
    const res = await fetch(`${PB_URL}/api/app/totals`, { headers: { Authorization: token } });
    expect(res.status).toBe(401);

    // re-enabling allows logging in again
    await admin.collection("users").update(user.record.id, { disabled: false });
    const pb = await login(user.username, user.password);
    expect(pb.authStore.isValid).toBe(true);
  });

  it("also invalidates tokens when a superuser disables the account (dashboard)", async () => {
    const su = await superuser();
    const user = await createUser();
    await su.collection("users").update(user.record.id, { disabled: true });
    await expectApiError(user.pb.collection("users").authRefresh(), 401);
  });
});

describe("users: deletion", () => {
  it("lets admins delete unreferenced users but not themselves", async () => {
    const admin = await createUser({ role: "admin" });
    const user = await createUser();
    await admin.pb.collection("users").delete(user.record.id);
    await expectApiError(admin.pb.collection("users").getOne(user.record.id), 404);

    await expectApiError(admin.pb.collection("users").delete(admin.record.id), 404);
  });

  it("does not let non-admins delete users (not even themselves)", async () => {
    const user = await createUser();
    const other = await createUser();
    await expectApiError(user.pb.collection("users").delete(other.record.id), 404);
    await expectApiError(user.pb.collection("users").delete(user.record.id), 404);
  });

  it("rejects deleting users that created bookings", async () => {
    const admin = await seededAdmin();
    const user = await createUser();
    const person = await user.pb.collection("persons").create({ number: uid("p") });
    const offering = await createOffering(admin);
    await user.pb.collection("bookings").create({ person: person.id, offering: offering.id, quantity: 1 });

    await expectApiError(admin.collection("users").delete(user.record.id), 400, MESSAGES.userHasBookings);
    expect((await admin.collection("users").getOne(user.record.id)).id).toBe(user.record.id);
  });
});
