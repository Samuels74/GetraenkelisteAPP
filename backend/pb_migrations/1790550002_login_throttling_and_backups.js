/// <reference path="../../.pb/dev-data/types.d.ts" />

// Operational settings – docs/ARCHITECTURE.md §7.
//
// - Login throttling: at most 10 login attempts per 60 s per client IP.
//   The "*:auth" tag covers auth-with-password, auth-with-otp and
//   auth-with-oauth2 of every auth collection (incl. superusers), but NOT
//   auth-refresh, auth-methods, realtime or record CRUD. The client IP is the
//   remote address unless a trusted proxy header is configured (see
//   deploy/reverse-proxy.md) – without it all clients behind the proxy share
//   one budget.
// - Scheduled backups: daily at 03:00 (container time = UTC), the latest 14
//   are kept (stored in pb_data/backups, i.e. inside the data volume).

migrate((app) => {
  const settings = app.settings();

  unmarshal(
    {
      rateLimits: {
        enabled: true,
        rules: [{ label: "*:auth", audience: "", duration: 60, maxRequests: 10 }],
      },
      backups: { cron: "0 3 * * *", cronMaxKeep: 14 },
    },
    settings,
  );

  app.save(settings);
}, (app) => {
  const settings = app.settings();

  // PocketBase v0.40 defaults
  unmarshal(
    {
      rateLimits: {
        enabled: false,
        rules: [
          { label: "*:auth", audience: "", duration: 3, maxRequests: 2 },
          { label: "*:create", audience: "", duration: 5, maxRequests: 20 },
          { label: "/api/batch", audience: "", duration: 1, maxRequests: 3 },
          { label: "/api/", audience: "", duration: 10, maxRequests: 300 },
        ],
      },
      backups: { cron: "", cronMaxKeep: 3 },
    },
    settings,
  );

  app.save(settings);
});
