import { describe, expect, it } from "vitest";
import { PB_URL, client, createPerson, createUser, expectApiError, login, superuser, totals } from "./helpers";

describe("operational settings (migration 1790550002)", () => {
  it("schedules daily backups at 03:00 keeping the latest 14", async () => {
    const settings = await (await superuser()).settings.getAll();
    expect(settings.backups).toMatchObject({ cron: "0 3 * * *", cronMaxKeep: 14 });
  });

  it("configures a single login throttling rule (disabled by the test harness)", async () => {
    const settings = await (await superuser()).settings.getAll();
    expect(settings.rateLimits.rules).toEqual([{ label: "*:auth", audience: "", duration: 60, maxRequests: 10 }]);
    expect(settings.rateLimits.enabled).toBe(false); // see setup/global-setup.ts
  });
});

describe("login throttling", () => {
  it("rejects the 11th login attempt within a minute with 429 – but no other requests", async () => {
    // everything that needs a login happens before the throttling is enabled
    const su = await superuser();
    const user = await createUser();

    await su.settings.update({ rateLimits: { enabled: true } });
    try {
      for (let attempt = 1; attempt <= 10; attempt++) {
        await expectApiError(client().collection("users").authWithPassword(user.username, "wrong-password"), 400);
      }
      const throttled = await expectApiError(login(user.username, user.password), 429);
      expect(throttled.response).toEqual({ status: 429, message: "Too Many Requests.", data: {} });

      // "*:auth" also covers the other auth methods (each endpoint has its own budget) ...
      const otp = await fetch(`${PB_URL}/api/collections/users/auth-with-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otpId: "x", password: "y" }),
      });
      expect(otp.status).not.toBe(429); // first OTP attempt: not throttled (OTP itself is disabled)

      // ... but not token refresh, auth methods, record CRUD, custom routes or realtime
      await user.pb.collection("users").authRefresh();
      await client().collection("users").listAuthMethods();
      await user.pb.collection("persons").getList(1, 1);
      await createPerson(user.pb);
      await totals(user.pb);
      const stream = await fetch(`${PB_URL}/api/realtime`);
      expect(stream.status).toBe(200);
      await stream.body?.cancel();
    } finally {
      await su.settings.update({ rateLimits: { enabled: false } });
    }

    // throttling off again -> login works
    await login(user.username, user.password);
  });
});
