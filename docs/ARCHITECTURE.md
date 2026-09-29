# Getränkeliste – Architecture & Contract

This document is the single source of truth for how the app is built. Backend,
frontend and tests are implemented against it. If an implementation detail has to
deviate, update this document in the same change.

## 1. Goals

- Multi-user web app (shared data set) replacing the single-file, localStorage-based
  `index.html` (the legacy app stays at the repo root because GitHub Pages serves it).
- Mobile-first UI (phones at a bar/counter); desktop is secondary but must work.
- UI language: **German**. Code, comments, docs: English.
- Exactly one running instance, one database, low traffic.
- Built, tested and run in containers: development machine with **Podman** (plain
  `podman` commands wrapped in a `Makefile`), production server with **Docker Compose**
  (latest Docker, x86_64 only).
- TLS is terminated by the operator's **existing reverse proxy**; the app container
  only exposes plain HTTP on port `8090`.

## 2. Architecture decisions

| Topic | Decision | Why |
|---|---|---|
| Backend | **PocketBase v0.40.4** (single Go binary, embedded SQLite) with JS migrations (`pb_migrations`) and JS hooks (`pb_hooks`) | Auth, API rules, realtime (SSE), backups, admin dashboard out of the box; perfect for one instance / low traffic |
| Frontend | **React 19 + TypeScript + Vite** SPA, **Tailwind CSS v4**, React Router, TanStack Query, PocketBase JS SDK | Static build served by PocketBase itself → one container, one process, same origin. No SSR needed for a logged-in tool |
| Money | Integer **cents** everywhere (`priceCents`, `unitPriceCents`) | No float rounding errors |
| Price history | Each booking stores `unitPriceCents` snapshot, set **server-side** | Price changes never alter past bookings; clients can't tamper |
| Integrity | Records that are referenced by bookings cannot be deleted (offerings, persons, users); groups with offerings cannot be deleted. Offerings/users can be **deactivated** instead | Requirement + audit trail |
| Realtime | Clients subscribe to collection changes and invalidate queries | Several phones stay in sync |
| QR codes | QR payload = person `number` (plain text, e.g. `001`) | Compatible with QR codes printed from the legacy app |
| No runtime CDNs | All JS/CSS/WASM/fonts are bundled | Must work on a LAN without internet |

## 3. Repository layout

```
/
├── index.html                  # LEGACY app (served by GitHub Pages) – do not modify
├── docs/ARCHITECTURE.md        # this file
├── Makefile                    # Podman entry point: make dev | build | test | run | stop | logs
├── compose.yaml                # Docker Compose (server); settings in .env (template .env.example)
├── Containerfile               # multi-stage: frontend build → runtime; plus `test` target
├── .dockerignore               # build context filter – read by Docker and Podman/Buildah
├── scripts/                    # helper scripts used by the Makefile / containers
│   └── dev-pocketbase.sh       # downloads PocketBase to .pb/ (gitignored) and runs it for dev
├── deploy/                     # Quadlet unit, reverse-proxy notes/examples
├── backend/
│   ├── pb_migrations/          # JS migrations: schema, rules, settings, seed data
│   ├── pb_hooks/               # JS hooks: price snapshot, delete guards, user rules, totals endpoint
│   └── tests/                  # API integration tests (own package.json; Vitest + pocketbase SDK)
├── frontend/                   # Vite React app (own package.json)
│   └── dist/                   # build output → served by PocketBase as its public dir
└── e2e/                        # Playwright end-to-end tests (own package.json)
```

Each of `backend/tests`, `frontend`, `e2e` is an independent npm package (no workspaces).
Node **24 LTS**.

### npm script contract (used by the Containerfile)

`frontend/`: `npm ci`, `npm run lint`, `npm run typecheck`, `npm test` (Vitest, single run),
`npm run build` (→ `frontend/dist`).

`backend/tests/`: `npm ci`, `npm test` – spawns its own throw-away PocketBase instance
(binary from env `PB_BIN`, default `../../.pb/pocketbase`) with a temp data dir and
`backend/pb_migrations` + `backend/pb_hooks`, runs the suite, stops it.

`e2e/`: `npm ci`, `npm test` – Playwright. Starts PocketBase serving `frontend/dist`
(same env conventions) unless `BASE_URL` is set.

## 4. Data model (PocketBase collections)

Timestamps: every collection has autodate fields `created` and `updated`.
Relations use `cascadeDelete: false`. Field names are camelCase.

### `users` (auth collection – the default one, modified)

| Field | Type | Notes |
|---|---|---|
| `username` | text, required, 3–32 chars, pattern `^[a-z0-9._-]+$`, unique | Login identity. Stored **lowercase** (hook lowercases + trims); frontend lowercases before login |
| `name` | text, optional, max 100 | Display name |
| `role` | select `admin` \| `user`, required, single | |
| `mustChangePassword` | bool | `true` for the seeded admin and for users created / password-reset by an admin; cleared when the user changes their own password. While set, the frontend only offers the password change (and logout) |
| `disabled` | bool | Disabled users cannot log in; disabling invalidates existing tokens |
| `email` | system field | Not used by the app: not required. PocketBase 0.40 cannot hide it via field options, so an `onRecordEnrich` hook strips it from every response (records, auth, realtime) |
| `avatar` | – | removed |

- Password auth enabled with `identityFields: ["username"]`; OAuth2/OTP/MFA off.
- Password min length **8** for every password set through the API. The seeded
  `admin`/`admin` account is created by the migration bypassing that validation
  (login does not re-validate length).
- `authRule`: `disabled = false`.

| Rule | Value |
|---|---|
| list / view | `@request.auth.id != ""` |
| create | `@request.auth.role = "admin"` |
| update | admin, **or** own record changing only `name` / `password` (`passwordConfirm`, `oldPassword`); unchanged values of `username`/`role`/`disabled`/`mustChangePassword` are tolerated, `email`/`emailVisibility`/`verified` must not be sent |
| delete | `@request.auth.role = "admin" && id != @request.auth.id` |
| manage | `@request.auth.role = "admin"` (admin can set passwords without `oldPassword`) |

Hooks: lowercase/trim `username`; default `role` = `user`; users created through the API
(by an admin or a superuser) get `mustChangePassword = true`; own password change →
`mustChangePassword = false` (PocketBase then invalidates the current token – the client
re-authenticates with the new password); an admin/superuser changing another user's
password → `mustChangePassword = true`; an admin cannot
change their **own** `role` or `disabled`; setting `disabled = true` refreshes the
user's `tokenKey` (logs them out everywhere); deleting a user that created bookings is
rejected.

### `groups` (base) – offering groups ("Gruppen")

| Field | Type | Notes |
|---|---|---|
| `name` | text, required, max 50, unique (case-insensitive) | |
| `sortOrder` | number, integer | ascending |

Rules: list/view `@request.auth.id != ""`; create/update/delete `@request.auth.role = "admin"`.
Hook: deleting a group that still has offerings (active or not) is rejected.

### `offerings` (base) – "Angebote"

| Field | Type | Notes |
|---|---|---|
| `name` | text, required, max 50; unique per group (case-insensitive) | |
| `group` | relation → `groups`, required, single | ⚠ `group` is an SQL keyword: always quote it in raw SQL |
| `priceCents` | number, integer, -100000…100000, **not** required (0 allowed) | Negative allowed (e.g. deposit refund) |
| `active` | bool | Inactive offerings are hidden on the booking screen and cannot be booked |
| `sortOrder` | number, integer | ascending within a group |

Rules: list/view `@request.auth.id != ""`; create/update/delete `@request.auth.role = "admin"`.
Hook: deleting an offering that has at least one booking is rejected.
Changing name/price/group of a booked offering is allowed (bookings keep their price snapshot).

### `persons` (base) – guests/members who consume

| Field | Type | Notes |
|---|---|---|
| `number` | text, required, max 20, pattern `^[A-Za-z0-9_-]+$`, unique (case-insensitive) | QR payload; trimmed by hook |
| `name` | text, optional, max 100 | |
| `nickname` | text, optional, max 100 | |

Rules: list/view/create/update `@request.auth.id != ""`; delete `@request.auth.role = "admin"`.
Hook: deleting a person with bookings is rejected.

### `bookings` (base)

| Field | Type | Notes |
|---|---|---|
| `person` | relation → `persons`, required | |
| `offering` | relation → `offerings`, required | |
| `quantity` | number, integer, required, 1…99 | UI books 1 per tap |
| `unitPriceCents` | number, integer | **Set by hook** from `offering.priceCents` (client value ignored) |
| `createdBy` | relation → `users`, required | **Set by hook** to the authenticated user (client value ignored) |

Rules: list/view `@request.auth.id != ""`; create `@request.auth.id != "" && @request.auth.collectionName = "users"`;
update: none (superusers only); delete `@request.auth.role = "admin" || createdBy = @request.auth.id`.
Hook: booking an inactive offering is rejected. Line total = `quantity * unitPriceCents`.

### Seed data (migration)

- User `admin` / password `admin`, role `admin`, `mustChangePassword = true`.
- Group `Getränke` (`sortOrder` 10) with offerings (all `priceCents` 0, `active` true,
  `sortOrder` 10, 20, …): `Bier/Wein`, `Redbull`, `Murelli`, `Mineralwasser`,
  `Fruchtsäfte`, `Kaffee`, `Pfand`.
- App settings: `meta.appName = "Getränkeliste"`.

### Error messages (German, returned as `400` with this `message` by the hooks)

| Case | Message |
|---|---|
| delete offering with bookings | `Dieses Angebot hat bereits Buchungen und kann nicht gelöscht werden. Deaktiviere es stattdessen.` |
| delete group with offerings | `Diese Gruppe enthält noch Angebote und kann nicht gelöscht werden.` |
| delete person with bookings | `Diese Person hat bereits Buchungen und kann nicht gelöscht werden.` |
| delete user with bookings | `Dieser Benutzer hat bereits Buchungen erfasst und kann nicht gelöscht werden. Deaktiviere das Konto stattdessen.` |
| book inactive offering | `Dieses Angebot ist nicht aktiv.` |
| admin changes own role / disables self | `Du kannst deine eigene Rolle nicht ändern und dein eigenes Konto nicht deaktivieren.` |

Hook errors are returned as `{"status":400,"message":"<German text>","data":{}}`.
Standard PocketBase validation errors arrive as `data.<field>.code`
(`validation_not_unique`, `validation_invalid_format`, `validation_min_text_constraint`,
`validation_required`, `validation_values_mismatch`, …) and are mapped to German
messages by the frontend. SQLite `COLLATE NOCASE` only folds ASCII, so a validation hook
additionally enforces Unicode case-insensitive uniqueness of `groups.name` and of
offering names within a group (same `validation_not_unique` error; for offerings both
`group` and `name` are flagged).

Denied API rules surface as PocketBase does it: create → 400 `Failed to create record.`,
update/delete → 404, booking update → 403, list without auth → 200 with an empty list.
Login: wrong credentials → 400; disabled account → 403.

## 5. Custom API

### `GET /api/app/totals` (requires an authenticated `users` record)

Query params (all optional): `from`, `to` (ISO 8601 UTC, `from` inclusive, `to` exclusive,
applied to `bookings.created`), `person` (person id), `createdBy` (user id).

```json
{
  "count": 12,
  "quantity": 14,
  "totalCents": 4550,
  "perPerson":   [{ "personId": "…", "number": "001", "name": "…", "nickname": "…", "count": 4, "quantity": 5, "totalCents": 1750 }],
  "perOffering": [{ "offeringId": "…", "name": "Bier/Wein", "groupId": "…", "groupName": "Getränke", "count": 6, "quantity": 7, "totalCents": 2450 }],
  "perUser":     [{ "userId": "…", "username": "anna", "name": "…", "count": 12, "quantity": 14, "totalCents": 4550 }]
}
```

`perPerson` sorted by `number`, `perOffering` by group `sortOrder` then offering
`sortOrder`, `perUser` by `username`. Only entries with bookings appear (so it doubles as
"is this record referenced?" for the admin UI). Note: PocketBase stores datetimes as
`YYYY-MM-DD HH:MM:SS.sssZ`; the endpoint converts ISO input (with `Z` or offset,
date-only, or the storage format itself) accordingly; an invalid date → 400 with a German
message. Superusers get 403 (a `users` record is required).

Everything else uses the standard PocketBase REST API/SDK. Date filters in PocketBase
filter strings must use the same `YYYY-MM-DD HH:MM:SS.sssZ` format.

## 6. Frontend

### Screens (bottom tab bar on phones)

1. **Login** – username + password.
2. **Buchen** (home) – the core flow: select person (QR scan / search by number, name,
   nickname) → tap an offering tile → booked (1×), toast with **Rückgängig** (undo).
   Selected person stays selected (persisted in `localStorage`) and is shown in a sticky
   card with their running total; recent bookings of that person below. Offerings are
   shown per group (only active ones, sorted), big tiles with name + price.
3. **Personen** – search/list, create (number, name, nickname) → shows QR code;
   detail: large QR (download PNG / print), edit, the person's bookings + total,
   "Für diese Person buchen". Print sheet with QR codes of all persons. Delete: admin
   only, disabled when the person has bookings.
4. **Buchungen** – list (newest first, paginated), filters: period (Heute / 7 Tage /
   30 Tage / Alle / custom from–to), person, "nur meine"; summary (count, total sum);
   views: list / per person / per offering; CSV export of the current filter.
   Cancel booking: own bookings, admin all.
5. **Verwaltung** (admin only) – tabs **Angebote** (CRUD, price, group, active,
   order; delete disabled + hint when booked), **Gruppen** (CRUD, order; delete disabled
   when not empty), **Benutzer** (create with username + initial password + role; reset
   password; enable/disable; change role; delete disabled when user has bookings or is self).
6. **Konto** – who am I, change password, logout. When `mustChangePassword` is set, the
   user must set a new password right after login before anything else is possible
   (the seeded `admin`/`admin` and admin-chosen initial passwords must not linger). The
   server requires the current password (`oldPassword`) for every own password change,
   admins included.

Routes: `/login`, `/` (Buchen), `/personen`, `/personen/:id`, `/personen/qr-codes`
(print sheet, `?ids=…&drucken=1`), `/buchungen`, `/verwaltung/{angebote,gruppen,benutzer}`
(admin only), `/konto`. Everything except login and Buchen is lazy-loaded.

Behavior details:
- Tapping an offering tile without a selected person opens the person picker ("Nach der
  Auswahl wird X gebucht.") and books right after the selection.
- Buchungen keeps its filters in the URL (`zeitraum=heute|7-tage|30-tage|alle|zeitraum`,
  `von`, `bis`, `person`, `meine=1`, `ansicht=liste|personen|angebote`); default period "Alle".
- QR scanning uses `barcode-detector` (native `BarcodeDetector` where it supports QR,
  otherwise the bundled ZXing WASM – served by the app itself, never from a CDN).
- Realtime: if the SSE connection can't be established it is retried with backoff
  (1, 2, 5, 10, 20, 30 s) and immediately on `online` / when the app becomes visible;
  subscriptions are rebuilt after every re-login. The session is re-validated on every
  realtime connect and every 5 min while visible, so disabled or reset accounts are
  logged out promptly.
- Edit dialogs send only the fields that changed (no silent overwrite of concurrent
  edits); reordering swaps the `sortOrder` of the two affected records.
- CSV export pages with a keyset cursor on `(created, id)` and a fixed upper bound, so
  bookings made during the export neither duplicate nor drop rows.
- Production builds carry a Content-Security-Policy meta tag (`'self'` only).
- PWA: installable via manifest; no service worker (no offline mode – bookings need the server).

### Conventions

- Currency formatting `Intl.NumberFormat('de-AT', { style: 'currency', currency: 'EUR' })`;
  price input accepts `3,50` / `3.50` / `3`.
- Dates/times shown in the browser's local time zone.
- CSV: UTF-8 with BOM, `;` separator, CRLF, columns
  `Datum;Uhrzeit;Nummer;Name;Nickname;Gruppe;Angebot;Anzahl;Einzelpreis;Summe;Gebucht von`;
  date `TT.MM.JJJJ`, time `HH:MM:SS` (local), amounts `3,50` (no currency sign),
  "Gebucht von" = username; text cells starting with `= + - @` get a leading `'`
  (spreadsheet formula injection guard). File name `buchungen_<zeitraum>_<datum>.csv`.
- Dev: Vite dev server on `5173` proxies `/api` and `/_` to PocketBase on `127.0.0.1:8090`.
  Production: same origin (SDK base URL = `window.location.origin`).
- Mobile: `viewport-fit=cover` + safe-area insets, tap targets ≥ 48 px (offering tiles
  larger), inputs ≥ 16 px font (no iOS zoom), dark mode via `prefers-color-scheme`,
  PWA manifest (installable, `display: standalone`). Camera access needs HTTPS (or
  `localhost`); show a clear message when the camera is unavailable.

## 7. Containers & operations

- Server: `docker compose up -d --build` builds the `runtime` target as
  `getraenkeliste:latest` and runs it as container `getraenkeliste` with the named volume
  `getraenkeliste-data` at `/pb_data`, `restart: unless-stopped`, published on
  `${GETRAENKELISTE_BIND:-127.0.0.1}:${GETRAENKELISTE_PORT:-8090}` (from `.env`), read-only
  root filesystem + tmpfs `/tmp`, all capabilities dropped, `no-new-privileges`. A
  gitignored `compose.override.yaml` can replace the published port with the reverse
  proxy's Docker network (`deploy/reverse-proxy.md`).
- `make build` → image `localhost/getraenkeliste:latest` (the frontend's lint, typecheck,
  unit tests and build run inside the build stage; PocketBase binary is downloaded and
  verified against the release checksums).
- `make test` → builds the `test` target (Playwright base image + PocketBase + built SPA)
  and runs API tests and E2E tests inside it (`--init --shm-size=1g`; `E2E_WORKERS=n`
  overrides the Playwright worker count); reports (JUnit, HTML, screenshots) are copied
  to `./test-results`.
- `make run` / `make stop` / `make logs` → runs the app container
  (`-p ${PORT:-8090}:8090`, named volume `getraenkeliste-data` mounted at `/pb_data`,
  `--restart=unless-stopped`).
- `make dev` → local development without containers: PocketBase (`127.0.0.1:8090`) +
  Vite dev server (`5173`).
- Optional env: `PB_SUPERUSER_EMAIL` / `PB_SUPERUSER_PASSWORD` → superuser for the
  PocketBase dashboard (`/_/`) is upserted at container start; `PB_ENCRYPTION_KEY`
  (32 chars) encrypts the stored settings.
- The container runs PocketBase with `--automigrate=false --hooksWatch=false` (the
  dashboard must not write migration files into the image); so does
  `scripts/dev-pocketbase.sh` unless `PB_AUTOMIGRATE=true`.
- Images are built with `--format docker` (an OCI image would drop the `HEALTHCHECK`).
  Pinned versions: PocketBase `0.40.4`, Playwright `1.63.0`
  (`mcr.microsoft.com/playwright:v1.63.0-noble`; `@playwright/test` must match exactly).
- `deploy/getraenkeliste.container` – Quadlet unit (systemd user service);
  `deploy/reverse-proxy.md` – nginx / Caddy / Traefik snippets.
- Reverse proxy: forward to `host:8090`; realtime uses Server-Sent Events on
  `/api/realtime` → disable response buffering, long read timeout.
- Hardening defaults (migration): login attempts are rate-limited per client IP
  (PocketBase rate limiter; configure the trusted proxy header, otherwise all clients
  behind the proxy share one budget); scheduled backups daily at 03:00 UTC, 14 kept,
  inside the data volume. Test harnesses switch the rate limiter off via the superuser
  settings API.
- Caching: `index.html`, SPA fallback and other non-hashed files are served with
  `Cache-Control: no-cache`, Vite's hashed `/assets/*` with a one-year `immutable`
  lifetime – phones pick up a new version on the next load.

Podman note (dev container): the `podman` CLI talks to the host's Podman socket, so
containers run on the host. Published ports are reachable from inside the dev container
via `host.containers.internal`, from the host via `localhost`. Avoid bind mounts in
scripts (host paths differ); use named volumes and `podman cp`.

## 8. Testing

| Layer | Tool | Where |
|---|---|---|
| Frontend unit/component | Vitest (+ Testing Library) – 172 tests | `frontend/src/**/*.test.ts(x)`; runs in the image build |
| API / rules / hooks | Vitest + pocketbase SDK against a real PocketBase – 82 tests | `backend/tests`; runs in `make test` |
| End-to-end | Playwright – 141 tests: Pixel 7 (Chromium), iPhone (WebKit), Desktop Chrome; QR scanning via Chromium fake camera (`qr-camera`); tests that need a quiet server run afterwards in `isolated-chrome` / `isolated-safari` | `e2e/`; runs in `make test` |

Both test harnesses start their own throw-away PocketBase, create a throw-away
superuser and switch the login rate limiter off through the settings API (all parallel
workers share one IP). E2E tests are parallel-safe: every test uses unique names,
cleans up after itself and never changes the seeded `admin` password; regression tests
for fixed bugs are tagged `@regression`.

Manual test on real phones (camera, via the HTTPS reverse proxy) is done by the operator.
