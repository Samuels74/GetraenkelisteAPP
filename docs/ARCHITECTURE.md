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
├── docs/ARCHITECTURE.md        # this file (+ LOADTEST.md: load test method and results; LOADTEST-FINDINGS.md: findings)
├── Makefile                    # Podman entry point: make dev | build | test | test-api | run | stop | logs | loadtest-dev | loadtest | clean | clean-data | help
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
├── e2e/                        # Playwright end-to-end tests (own package.json)
└── loadtest/                   # load test (own package.json): data generator, make loadtest-dev, make loadtest
    ├── src/                    # library modules (instance, dataset, seed, verify, …) + cli/
    │   ├── perf/               # performance checks: measurement core, API scenarios, runner, report
    │   ├── ui/                 # browser checks U1–U11 (runUiScenarios); page-probe.js = in-page timing
    │   └── cli/                # seed.ts, dev.ts (make loadtest-dev), run.ts (make loadtest), ui.ts (UI checks alone),
    │                           # model-check.ts (npm run model-check: the API device model vs. the real SPA)
    └── support/                # TEST-ONLY *.pb.js routes for load-test instances (never deployed)
```

Each of `backend/tests`, `frontend`, `e2e`, `loadtest` is an independent npm package (no
workspaces). Node **24 LTS**. `loadtest/` runs its TypeScript directly with Node's type
stripping (no build step; `npm run typecheck`); it is not part of any image.

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
| `name` | text, optional, max 100 | Display name; stored normalized (see "Names" below) |
| `role` | select `admin` \| `user`, required, single | |
| `mustChangePassword` | bool | `true` for the seeded admin and for users created / password-reset by an admin; cleared when the user changes their own password **to a different one** – on the own record the hooks reject a new password equal to the current one and any change of the flag without a new password (admins too). Admins/superusers may set or clear the flag of **other** users. While set, the frontend only offers the password change (and logout) |
| `disabled` | bool | Disabled users cannot log in; disabling invalidates existing tokens |
| `email` | system field | Not used by the app: not required. PocketBase 0.40 cannot hide it via field options, so an `onRecordEnrich` hook strips it from every response to app users (records, auth, realtime); superusers (dashboard) still see it – PocketBase unhides all fields for them after the enrich hooks |
| `avatar` | – | removed |

- Password auth enabled with `identityFields: ["username"]`; OAuth2/OTP/MFA off.
- Password length **8–71** characters and at most 72 bytes in UTF-8 (bcrypt; an `ä` counts
  2) for every password set through the API: longer → `validation_max_text_constraint`
  (without `params.max`) or, beyond 72 bytes, `validation_invalid_value`. The seeded
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

Hooks: lowercase/trim `username`; normalize `name` (see "Names"); default `role` = `user`; users created through the API
(by an admin or a superuser) get `mustChangePassword = true`; own password change →
`mustChangePassword = false` (PocketBase then invalidates the current token – the client
re-authenticates with the new password); an own "change" to the current password (checked only
after the current password was verified – no hint without it) and an own change of
`mustChangePassword` without a new password are rejected; an admin/superuser changing another user's
password → `mustChangePassword = true`; an admin cannot
change their **own** `role` or `disabled`; setting `disabled = true` refreshes the
user's `tokenKey` (logs them out everywhere); deleting a user that created bookings is
rejected. **At least one active admin** (`role = admin`, not disabled) always remains for
everything done through the API – in the app and in the dashboard: demoting, disabling or deleting
the last one is rejected, and a change or deletion of another user by an app user is written only
if the **acting** user is still an active admin at that moment (else `403`) – of two admins
demoting each other at the same moment, the second one fails (the API rules see the acting
account as it was when the request started). Both are request-level checks: migrations and other
hooks are trusted code and not bound by them (the seed migration's down step deletes the seeded
admin, also when it is the last one).

### `groups` (base) – offering groups ("Gruppen")

| Field | Type | Notes |
|---|---|---|
| `name` | text, required, max 50, unique (case-insensitive, look-alikes count as equal) | stored normalized (see "Names") |
| `sortOrder` | number, integer | ascending |

Rules: list/view `@request.auth.id != ""`; create/update/delete `@request.auth.role = "admin"`.
Hook: deleting a group that still has offerings (active or not) is rejected.

### `offerings` (base) – "Angebote"

| Field | Type | Notes |
|---|---|---|
| `name` | text, required, max 50; unique per group (case-insensitive, look-alikes count as equal) | stored normalized (see "Names") |
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
| `name` | text, optional, max 100 | stored normalized (see "Names") |
| `nickname` | text, optional, max 100 | stored normalized (see "Names") |

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
Hook: booking an inactive offering is rejected; the relations are checked and the booking is
written in one transaction (see "Concurrent writes"). Line total = `quantity * unitPriceCents`.
Indexes: `person`, `offering`, `created` and the composite `(createdBy, created)` (migration
`1790550003`, replaces the former single-column `createdBy` index): "nur meine" alone and combined
with a period reads only the user's bookings of that period, already in `created` order – with or
without SQLite's planner statistics; it also serves every other `createdBy = ?` lookup. A new
database has no statistics for the app tables until PocketBase's nightly `PRAGMA optimize` finds
data: the migration removes the ones that the `PRAGMA optimize` after its index change records from
the seed state (users 1 row, groups 1, offerings 7 – later optimizes do not correct tables that grow
only a few times, and with them SQLite scanned `users` once per booking when joining it); an
existing database keeps its statistics.

### Names

Names are normalized by model hooks (`lib/rules.js`) when a save sets or changes them. A value
that a save leaves unchanged stays as stored: an update of other fields (a reorder, a price,
number or password change) neither rewrites a name stored before these rules nor fails because of
one (blank, look-alike). All names: control characters other than whitespace removed, every run of
whitespace (also non-breaking and other Unicode spaces, tabs, line breaks) → one space, trimmed,
Unicode NFC.

- **Unique names** – `groups.name`, `offerings.name` (`normalizeName`): invisible characters are
  removed as well (Unicode category Cf – zero-width space/joiner, soft hyphen, BOM, bidi controls,
  tag characters, …), they would only make two names look alike; an emoji sequence joined by a
  zero-width joiner (woman cook, rainbow flag) therefore falls apart into its emoji. A required
  name that is empty afterwards fails with `validation_required`. The uniqueness checks run when a
  name is set or changes (for offerings also when the group changes) and compare normalized names
  – also those stored before these rules – case-folded (lower → upper → lower, not
  locale-specific: `ß` = `ẞ` = `ss`, the dotless `ı` = `i`): names that only look alike are
  duplicates. Not covered: other default-ignorable characters (variation selectors, Hangul fillers).
- **Display names** – `persons.name`/`nickname`, `users.name` (`normalizeText`; not unique): format
  characters are kept – emoji sequences with a zero-width joiner or tag characters (woman cook,
  rainbow flag, the flag of Scotland) stay intact, a zero-width space stays as well.

### Concurrent writes

PocketBase validates a record (relation targets exist, the hooks' uniqueness and delete checks) on
the read connections and writes it afterwards on its single write connection, with no transaction
around both. The hooks therefore run their checks and the write in **one transaction**
(`lib/rules.js` `runInWriteTransaction`): booking create/update, offering and group
create/update, the delete guards of groups/offerings/persons/users and – at request level – every
users update and delete through the API (last active admin, re-check of the acting admin).
Concurrent writes then run one after the other and each sees what the others committed: a
delete and a write that references the record at the same moment never leave a dangling
reference (the write fails with
`validation_missing_rel_records`, or the delete with its German message), two look-alike names
are never both taken, and the last active admin stays. Cost: the write connection is held
≈ 0.15 ms longer per write (8 concurrent booking writers: ≈ 2,800 instead of 4,500 per second on
the dev machine; alone unchanged). Raw SQL (dashboard) bypasses all of this (§7).

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
| own `mustChangePassword` changed without a new password | `Du kannst die Pflicht zur Passwortänderung für dein eigenes Konto nicht selbst ändern – sie endet, sobald du dein Passwort änderst.` |
| own new password = current one | `Das neue Passwort muss sich vom bisherigen unterscheiden.` |
| demote / disable / delete the last active admin | `Mindestens ein aktiver Admin muss bleiben.` |
| change/delete another user after losing the own admin rights meanwhile (**403**) | `Dafür fehlt dir inzwischen die Berechtigung.` |

Hook errors are returned as `{"status":400,"message":"<German text>","data":{}}` (the last row:
`403`). Standard PocketBase validation errors arrive as `data.<field>.code`
(`validation_not_unique`, `validation_invalid_format`, `validation_min_text_constraint`,
`validation_required`, `validation_values_mismatch`, …) and are mapped to German
messages by the frontend. SQLite `COLLATE NOCASE` only folds ASCII, so a validation hook
additionally enforces Unicode case-insensitive uniqueness of `groups.name` and of
offering names within a group whenever a name is set or changed (offerings: also the group),
comparing normalized names (see "Names"; same `validation_not_unique` error; for offerings
both `group` and `name` are flagged).
Number fields: PocketBase converts a JSON value that is no number instead of rejecting it
(`"3,50"`, `"abc"`, `[1,2]` → `0`; `true` → `1`; `"1e1"` → `10`) – the SPA always sends
numbers; scripts using the API must too.

Denied API rules surface as PocketBase does it: create → 400 `Failed to create record.`,
update/delete → 404, booking update → 403, list without auth → 200 with an empty list.
Login: wrong credentials → 400; disabled account → 403.

## 5. Custom API

### `GET /api/app/totals` (requires an authenticated `users` record)

Query params (all optional): `from`, `to` (ISO 8601 UTC, `from` inclusive, `to` exclusive,
applied to `bookings.created`), `person` (person id), `createdBy` (user id), `parts`.

`parts` selects what is computed and returned: a comma-separated subset of `summary`
(= `count`, `quantity`, `totalCents`), `perPerson`, `perOffering`, `perUser` (entries trimmed;
a repeated parameter – the SDK's array form – is combined). Missing or empty → all four, i.e.
the full response below. Keys of parts that were not requested are **omitted** (never an empty
array – that would read as "no bookings"); an unknown or empty entry → 400 with a German
message. Request only what the screen shows: `perPerson` is the expensive part (one row per
person – ≈ 250 KiB / 26 ms of the full 252 KiB / 37 ms with 2000 persons and 15k bookings;
`summary` alone ≈ 2 ms). All filters combine with `parts`.

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

`perPerson` sorted by `number` (ASCII case-insensitive, ties by person id), `perOffering` by
group `sortOrder` then offering `sortOrder`, `perUser` by `username`. Only entries with bookings appear (so it doubles as
"is this record referenced?" for the admin UI). Note: PocketBase stores datetimes as
`YYYY-MM-DD HH:MM:SS.sssZ`; the endpoint converts ISO input (with `Z` or offset,
date-only, or the storage format itself) accordingly; an invalid date → 400 with a German
message. A query with a raw `;` or a `%` not followed by two hex digits → 400 with a German
message (Go's query parser would silently drop such a pair – and with it a filter; the SDK
encodes both as `%3B` / `%25`). Superusers get 403 (a `users` record is required). JSON object keys come in random
order (PocketBase encodes JS objects as Go maps) – clients must not depend on key order.

Everything else uses the standard PocketBase REST API/SDK. Date filters in PocketBase
filter strings must use the same `YYYY-MM-DD HH:MM:SS.sssZ` format. Unknown API paths (`/api`,
`/api/…` – also with a trailing slash or `%2F`) and `/_/…` paths that the dashboard does not
handle get PocketBase's JSON 404 `{"status":404,"message":"The requested resource wasn't
found.","data":{}}` for every method – never the SPA (`pb_hooks/static.pb.js`).

## 6. Frontend

### Screens (bottom tab bar on phones)

1. **Login** – username + password.
2. **Buchen** (home) – the core flow: select person (QR scan / search by number, name,
   nickname) → tap an offering tile → booked (1×), toast with **Rückgängig** (undo).
   Selected person stays selected (persisted in `localStorage`) and is shown in a sticky
   card with their running total; recent bookings of that person below. At app start the
   remembered person is loaded on its own (`getOne`, ≈1 KB) while the person list loads: the
   card says "Person wird geladen …" (never "Keine Person ausgewählt") and the tiles wait; a
   remembered person that no longer exists is dropped (after the session check). Offerings are
   shown per group (only active ones, sorted), big tiles with name + price; a tile whose booking
   is on its way shows a spinner and stays tappable.
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
   admins included. New passwords (Konto, forced change, Benutzer create/reset) are checked
   like the server does before sending: 8–71 characters and at most 72 UTF-8 bytes (bcrypt);
   no `maxLength` on the fields (a password manager's longer password would be cut silently).

Routes: `/login`, `/` (Buchen), `/personen`, `/personen/:id`, `/personen/qr-codes`
(print sheet, `?ids=…&drucken=1`), `/buchungen`, `/verwaltung/{angebote,gruppen,benutzer}`
(admin only), `/konto`. Everything except login and Buchen is lazy-loaded.

Behavior details:
- Tapping an offering tile without a selected person opens the person picker ("Nach der
  Auswahl wird X gebucht.", in its create mode "Nach dem Anlegen wird X gebucht.") and books
  right after the selection. Focus returns to the card's main button after picking or clearing.
- Buchungen keeps its filters in the URL (`zeitraum=heute|7-tage|30-tage|alle|zeitraum`,
  `von`, `bis`, `person`, `meine=1`, `ansicht=liste|personen|angebote`); default period "Alle".
  The person filter is a field that opens the person picker (search / QR scan, without
  "Neue Person"); "×" goes back to all persons. Unknown or malformed values are shown as the
  defaults and the URL is corrected (replace). Filter changes replace the history entry; a
  drill-down to one person (picking it in the filter, a "Pro Person" row) pushes one, so Back
  returns – to "Pro Person" with the rows ("Weitere …") it showed. "Von" after "Bis" shows
  "„Von“ liegt nach „Bis“ …". While a new filter loads, the previous numbers are dimmed with a
  spinner, never shown as the new result. Day headings ("Heute", "Gestern") and the time-only
  rows of today move on at local midnight and when the app becomes visible again
  (`lib/useToday.ts` on the midnight timer of `api/midnight.ts`) – also on Buchen and the
  person detail.
- Lists of all persons stay fast on phones with thousands of persons: Personen and Buchungen
  "Pro Person" render the first 100 rows, "Weitere 100 anzeigen" appends the next 100
  (a new search / filter starts over, also a return to an earlier one); when the last rows
  appear, the focus moves from the vanishing button to the first of them. Rows are memoized
  with primitive props, so a totals update re-renders only the rows that changed. The Personen
  search filters as a deferred value and keeps `?q=` in the URL, written (replace) 400 ms after
  the last keystroke; a navigation (Back, a link, the Personen tab) wins over a pending write,
  and tapping a person writes it at once, so Back returns to the search. Search (Personen,
  picker) compares names and nicknames in two forms, each the same way on both sides – plain
  (case, diacritics) and folded (also "ß"/"ss", "ä/ö/ü"/"ae/oe/ue": "Weiss" finds "Weiß",
  "Mueller" finds "Müller"); a match in either counts, so substrings that folding would cut
  still match ("erstein" finds "Feuerstein", "el" finds "Michael") – and numbers as they are
  (case-insensitive).
- The QR print sheet mounts its cards step by step (100, 100, 200, then ≤ 400 per step, as
  transitions); "Drucken" and `drucken=1` wait until every card is rendered, printing from
  the browser menu renders the rest first (`beforeprint`); `drucken=1` opens the print dialog
  once per visit, not at all when the sheet was printed otherwise meanwhile. QR paths are
  cached per number. Long numbers get a smaller type and wrap on their card. "Zurück" goes back
  only to a page of this app visit (React Router's history `idx` > 0), otherwise to
  `/personen` – never to whatever the tab showed before.
- QR scanning uses `barcode-detector` (native `BarcodeDetector` where it supports QR,
  otherwise the bundled ZXing WASM – served by the app itself, never from a CDN).
- Realtime: if the SSE connection can't be established it is retried with backoff
  (1, 2, 5, 10, 20, 30 s); on `online` / when the app becomes visible the next attempt starts
  at once (also cutting short the SDK's own wait of up to 2 s between its reconnect attempts).
  Subscriptions are rebuilt after every re-login and after the own password change – also in
  the other tabs of the browser (localStorage `gl.sessionGeneration`; a token refresh does not
  count).
- Session: a revoked token (account disabled, password reset by an admin, own password changed
  on another device) is answered by PocketBase as a guest (lists 200 without rows, creates 400,
  views/deletes 404), and the realtime connection loses its auth *before* the change is
  broadcast – no event tells the app. The session (`auth-refresh`, 401 = revoked) is therefore
  checked at start, every minute while the app is visible (counted from the last check,
  whatever started it), when it becomes visible again, on every realtime (re)connect, and at
  once when a request gets such a guest-style denial (403, 404, 400 without field errors).
  A disabled or reset account is logged out within about a minute while the app is visible and
  immediately on its next action – the action then reports "Deine Sitzung ist abgelaufen …"
  (its error counts as a 401), not a permission error, and the message shows once; so does an
  action that was on its way when a check ended the session. Only PocketBase's own JSON answer
  (`{ status, message, data }`) says anything about the session: the same statuses from
  something in front of it – a reverse proxy's "404 page not found" while the app container
  restarts (Traefik), a captive portal's 403 – are, like network errors, timeouts and 5xx,
  "server unreachable": no check, no logout, the action says "Der Server ist gerade nicht
  erreichbar …" (and such queries are retried like 5xx). Our hooks' German messages (inactive
  offering, delete guards, …) are answers, too – they cost no check. A check without an
  answer is given up after 10 s ("unknown", the session stays; an action's error waits for a
  check at most that long), and the next check follows a minute after it started.
- Edit dialogs send only the fields that changed (no silent overwrite of concurrent
  edits); reordering swaps the `sortOrder` of the two affected records.
- CSV export pages with a keyset cursor on `(created, id)` and a fixed upper bound, so
  bookings made during the export neither duplicate nor drop rows. The cursor condition
  starts with a redundant `created <= c`, so SQLite reads a range of the `created` index
  (without it every page sorted all older bookings – quadratic over an export).
- Dialogs: Escape / Android's back gesture closes only the topmost dialog (a confirmation
  opened from an edit dialog keeps the edit dialog and its input). Destructive confirmations
  focus "Abbrechen" first and run their action once – a double tap sends one request. While
  the action runs, a confirmation (cancel a booking, delete) cannot be closed – "Abbrechen",
  "Schließen", Escape and the backdrop wait for the answer, which closes it with the real
  outcome ("Buchung storniert", "bereits storniert") or shows the error in it: a sent request
  cannot be recalled, and an "Abbrechen" that hides a cancellation that happens anyway misleads.
  Only after 15 s without an answer can it be closed again; the outcome then comes as a toast.
- Production builds carry a Content-Security-Policy meta tag: `default-src 'self'` (scripts,
  fonts, connections, manifest only from the app itself, no CDNs), plus what the app needs:
  `'wasm-unsafe-eval'` (QR scanner WASM), inline styles (`style` attributes, the toast
  library), `data:`/`blob:` images, `blob:` media and workers; `object-src 'none'`,
  `base-uri`/`form-action 'self'` (see `frontend/vite.config.ts`).
- PWA: installable via manifest; no service worker (no offline mode – bookings need the server).
  Requests are sent even while the browser reports "offline" and fail at once with "Keine
  Verbindung zum Server …" (TanStack `networkMode: 'always'` – the default would queue them and
  send them minutes later); what failed loads again when the network is back. While offline a
  one-line banner "Keine Verbindung" shows at the top (TanStack's `onlineManager`) and the
  offering tiles are disabled. A screen whose code could not be loaded: if PocketBase answers
  (`/api/health` with its JSON) the app was updated meanwhile – the page reloads once by itself
  into the new version (not again within a minute: then "Neu laden"); otherwise (offline, no
  answer, a proxy's 502 page) it says "Keine Verbindung zum Server", asks the server every 5 s
  and on `online`, and reloads when it answers. A request that was sent cannot be recalled:
  when a form dialog was closed before the answer arrived (create person), the result shows no
  late navigation or selection – the lists still show the change.
- A failed background refresh keeps what a screen shows (the error replaces content only when
  there is none yet) – but an empty list whose refresh failed shows the error with "Erneut
  versuchen", never "Keine Buchungen" / "Noch keine Buchungen." / "Noch keine Personen". While
  the browser is online, a non-blocking inline hint "Verbindung zum Server unterbrochen –
  Anzeige evtl. nicht aktuell." with "Erneut versuchen" says when shown content may be
  outdated (`components/ConnectionHint.tsx`, `api/connection.ts`): a shown query failed to
  refresh for want of a usable answer (network error, timeout, 5xx, a proxy's page – not
  PocketBase's own 4xx) and kept its data, or realtime has been disconnected for 30 s while the
  app was visible (no event reaches the cache meanwhile; hidden or offline, the clock starts
  over). Failures from while the browser was offline do not count (the banner said it). Its
  retry refetches what failed – during a realtime outage everything shown, which then counts
  as current for another 30 s. It sits on Buchen below the person card (sticky), on Buchungen
  above the summary, on Personen below the search, on the person detail and in Verwaltung.

### Data flow (TanStack Query, realtime)

- Query keys start with the collection: `persons`, `groups`, `offerings`, `users`,
  `['bookings','list',filter]` (Buchungen), `['bookings','recent',person,limit]`,
  `['totals',filter,parts]`. Defaults: kept 10 min; while realtime is connected nothing goes
  stale by time – every change reaches the cache through an event, every reconnect refetches
  everything, and the periods relative to today are invalidated at midnight – so a screen
  that mounts again or a refocused app loads nothing again; without a connection (not
  established yet, reconnecting, SSE blocked by a proxy) no event would arrive, so data goes
  stale after 30 s (`realtimeStaleTime`). Focus and `online` refetch nothing while a realtime
  reconnect is pending: it refetches everything once connected – one round after an unlock,
  not two. Before the first connect (realtime may never work behind a proxy) they refetch as
  usual.
- Totals: each screen requests only the parts it shows (`parts=`, §5) – Buchen card and person
  detail `summary` of the person, Buchungen list `summary`, "Pro Person" `summary,perPerson`,
  "Pro Angebot" `summary,perOffering`, Personen `perPerson`, Verwaltung Angebote `perOffering`,
  Benutzer `perUser`.
- Buchungen list: pages of 50, newest first (`-created,-id`); "Weitere laden" loads the
  bookings older than the last loaded one (keyset cursor, like the CSV export), so bookings
  added to or removed from the cached pages never shift the next page. All pages use the filter
  page 1 was loaded with – "Weitere laden" after midnight continues the day the list shows. When
  cancellations remove every loaded booking while older ones exist, the list reloads.
- Realtime (events debounced 120 ms): `offerings` and `groups` events invalidate the
  dependent queries by prefix. `persons` and `users` events invalidate only their own lists and
  patch the new names into the cached rows – `expand.person` / `expand.createdBy` of the
  bookings, the per-person / per-user totals rows (re-sorted) – without a request; everyone
  watches all users (their names show with the bookings, "von …"). Own person / user edits do
  the same with the saved record (no reload of every booking list and all totals). Booking events are applied
  per cached query (`api/bookingSync.ts`): a booking outside the query's filter changes nothing
  (a Buchen phone of another person sends no request); small totals (one person, summary, per
  offering / user) are refetched; per-person totals fetch only the affected persons' rows
  (`person=<id>&parts=perPerson` + the filter) and patch them in (other parts refetched); the
  Buchungen list removes a cancelled booking from its pages and loads new ones with one request
  ("newer than the newest cached booking"); recent bookings of a person drop a cancelled one
  (refetched when the list was full) and refetch on new ones; hidden screens' queries are only
  marked stale. One patch per query at a time and none while it is fetching (its first load, a
  refetch, "Weitere laden"): changes that arrive meanwhile are collected and applied together
  once it is idle – one head request or row patch for any number of batches, never a refetch
  per batch (that kept a slow network busy with full refetches for as long as a booking stream
  lasted); a patch whose query fetched or changed during its request starts again on the new
  data (3 attempts, then a refetch). Whenever the state is uncertain the query is refetched
  instead (it failed or was invalidated, it shows a relative period that midnight has moved on
  – lists and totals keep the period they were loaded for, `dataUpdatedAt` would not tell –,
  the head request returned a full page or missed a new booking, a request failed, more than
  10 persons at once, an `update` event). A query that is fetching gets one refetch after its
  fetch, however many invalidations arrive meanwhile.
- Connects: every reconnect refetches everything (events may have been missed) – after the
  session check, because a revoked token would load empty lists. The first connect refetches
  the queries that settled before the subscriptions were active – before their request ended
  (changes made in between would be missed; on a cold start that is usually a few small ones).
- Midnight: at local midnight (one timer, `api/midnight.ts`, plus a catch-up when the app
  becomes visible again; the timer waits at most a minute between looks at the clock – timers
  stand still while a device sleeps, a laptop asleep across midnight with the page "visible"
  would catch up hours late) the lists and totals of "Heute" / 7 / 30 Tage are invalidated – open
  screens show the new day without waiting for a booking, hidden ones when shown again.
- Own bookings and cancellations take the same targeted update right after the response (plus
  an estimate on the person card until its totals arrive); their realtime echo is skipped
  (action + booking id) – a tap costs the POST plus one small totals request.
- Lists known to be empty are not requested (PocketBase delays empty filtered lists by up to
  0.5 s per client IP): the recent bookings of a person whose cached summary says 0, the
  Buchungen list whose cached summary of the same filter says 0. Only an already cached
  summary counts, and only while it is not being or about to be refetched (stale, or
  invalidated by a booking while the screen was hidden); otherwise summary and list load in
  parallel. An empty list from the cache that is being refetched shows as loading (it may be
  outdated); rows of an earlier visit stay visible while they are refetched – "Keine
  Buchungen" never shows while bookings may exist.

### Conventions

- Currency formatting `Intl.NumberFormat('de-AT', { style: 'currency', currency: 'EUR' })`;
  price input accepts `3,50` / `3.50` / `3`. Counts (bookings, persons, quantities) use the
  thousands separator of the amounts: `14.927` next to `€ 41.135,50` (`formatCount`).
- Dates/times shown in the browser's local time zone.
- CSV: UTF-8 with BOM, `;` separator, CRLF, columns
  `Datum;Uhrzeit;Nummer;Name;Nickname;Gruppe;Angebot;Anzahl;Einzelpreis;Summe;Gebucht von`;
  date `TT.MM.JJJJ`, time `HH:MM:SS` (local), amounts `3,50` (no currency sign),
  "Gebucht von" = username; text cells starting with `= + - @` get a leading `'`
  (spreadsheet formula injection guard). File name `buchungen_<zeitraum>_<datum>.csv`
  (`heute`, `7-tage`, `30-tage`, `alle`; the local date of the export); for "Von–bis"
  `buchungen_<von>_bis_<bis>.csv` – `anfang` without "Von", today's date without "Bis".
- Dev: Vite dev server on `5173` proxies `/api` and `/_` to PocketBase on `127.0.0.1:8090`.
  Production: same origin (SDK base URL = `window.location.origin`).
- Mobile: `viewport-fit=cover` + safe-area insets – the top inset is owned once by the
  AppShell (sticky bars stick below it and below the offline banner), tap targets ≥ 48 px
  (offering tiles larger), no horizontal scrolling down to 320 px with 125 % text (rows, tabs
  and segmented controls wrap), landscape phones get a compact sticky person card, inputs ≥ 16 px
  font (no iOS zoom), text contrast ≥ 4.5:1 (toasts included), dark mode via `prefers-color-scheme`,
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
  unit tests and build run inside the build stage; the PocketBase zip is verified against the
  SHA-256 pinned next to `PB_VERSION` – `PB_SHA256_*` build args, the release's
  `checksums.txt` only as a cross-check; the same pins in `scripts/dev-pocketbase.sh`).
  `--pull=newer` (in `BUILD_FLAGS`) pulls newer base images when the registry has them;
  Docker: `docker compose build --pull`.
- `make test` → builds the `test` target (Playwright base image + PocketBase + built SPA)
  and runs API tests and E2E tests inside it (`--init --shm-size=1g`; `E2E_WORKERS=n`
  overrides the Playwright worker count); reports (JUnit, HTML, screenshots) are copied
  to `./test-results`.
- `make run` / `make stop` / `make logs` → runs the app container
  (`-p ${BIND:+$BIND:}${PORT:-8090}:8090` – all interfaces unless `BIND` is set, because a dev
  container cannot reach the Podman host's loopback; `BIND=127.0.0.1` on a server behind a
  reverse proxy on that host –, named volume `getraenkeliste-data` mounted at `/pb_data`,
  `--restart=unless-stopped`, hardened like Compose: `--read-only --tmpfs /tmp --cap-drop=ALL
  --security-opt no-new-privileges:true`). It stores no settings: `PB_ENCRYPTION_KEY` /
  `PB_SUPERUSER_*` must be passed on every run. `scripts/wait-for-app.sh` waits for
  `/api/health` (with `BIND` set, the image's health check run inside the container counts
  when the port is out of reach from here); a container that exits or restarts meanwhile is
  stopped with its restart policy dropped – its last logs are shown, no restart loop.
- `make dev` → local development without containers: PocketBase (`127.0.0.1:8090`) +
  Vite dev server (`5173`); aborts when something already answers on the PocketBase port
  (e.g. `make run`) and stops both when one of them exits.
- `make loadtest-dev` → the load-test dataset (2000 persons, 5 users, ~15k bookings;
  [LOADTEST.md](LOADTEST.md)) in `.pb/loadtest-data`, served with the production SPA build
  by PocketBase on `127.0.0.1:8091` (`LOADTEST_PORT`) until Ctrl+C; `LOADTEST_KEEP=1` reuses
  the last dataset.
- `make loadtest` → the automated performance checks ([LOADTEST.md](LOADTEST.md)): rebuilds
  the SPA, a throw-away PocketBase on a free port serving a snapshot of it with that dataset, API
  scenarios and browser timings
  checked against WARN/FAIL budgets, report in `./test-results/loadtest/`; exit code 1 when a
  FAIL budget is violated (`LOADTEST_QUICK=1`, `LOADTEST_SCENARIOS=…`, `LOADTEST_UI=0`,
  `LOADTEST_SOAK=1`).
- Optional env: `PB_SUPERUSER_EMAIL` / `PB_SUPERUSER_PASSWORD` → superuser for the
  PocketBase dashboard (`/_/`) is upserted at container start (one of the two alone only logs
  a warning; keyed by the e-mail – a changed e-mail adds a superuser); `PB_ENCRYPTION_KEY`
  (exactly 32 characters – anything else makes the entrypoint exit with 64, PocketBase itself
  would crash-loop or take 16/24 characters as a weaker key) encrypts the stored settings; the
  volume and its backups then only start with that key. Extra container arguments go to
  `pocketbase serve` – not `--http` (the health check probes 8090; the entrypoint warns).
- Raw SQL from the dashboard (SQL editor, `POST /api/sql`) bypasses every hook – no delete guards, name normalization or admin checks, and `UPDATE users SET disabled = 1` keeps that user logged in; edit records through the record forms.
- The container runs PocketBase with `--automigrate=false --hooksWatch=false` (the
  dashboard must not write migration files into the image; the hooks never change at
  runtime). `scripts/dev-pocketbase.sh` also passes `--automigrate=false` (unless
  `PB_AUTOMIGRATE=true`) but watches the hooks: PocketBase restarts when a file in
  `backend/pb_hooks` changes.
- Images are built with `--format docker` (an OCI image would drop the `HEALTHCHECK`:
  `GET /api/health` every 10 s – Podman runs the first check one interval after the start,
  ignoring Docker's `--start-interval`, and the Quadlet unit's `Notify=healthy` waits for it).
  Pinned versions: PocketBase `0.40.4`, Playwright `1.63.0`
  (`mcr.microsoft.com/playwright:v1.63.0-noble`; `@playwright/test` must match exactly).
- `deploy/getraenkeliste.container` – Quadlet unit (systemd user service, Podman ≥ 5.0 for
  `Notify=healthy`): published on `127.0.0.1:8090`, hardened like Compose (`ReadOnly=true`
  with Podman's tmpfs on `/tmp`, `DropCapability=all`, `NoNewPrivileges=true`), secrets in an
  `EnvironmentFile` without quotes (Podman keeps them); `deploy/reverse-proxy.md` – nginx /
  Caddy / Traefik snippets.
- Reverse proxy: forward to `host:8090`; realtime uses Server-Sent Events on
  `/api/realtime` → disable response buffering, long read timeout, never compress it.
  Compress everything else (JSON, JS, CSS, HTML, SVG, manifest): PocketBase compresses
  neither the API nor the SPA (gzip: totals ≈ 4.5×, list pages ≈ 13× smaller). Pass the client IP
  in a trusted header (rate limits and PocketBase's empty-search throttle are per client IP) –
  trusted only while port 8090 is reachable through the proxy alone, else clients forge their IP.
- Hardening defaults (migration): login attempts are rate-limited per client IP
  (PocketBase rate limiter; configure the trusted proxy header, otherwise all clients
  behind the proxy share one budget); scheduled backups daily at 03:00 UTC, 14 kept,
  inside the data volume. Test harnesses switch the rate limiter off via the superuser
  settings API.
- Caching: `index.html`, SPA fallback and other non-hashed files are served with
  `Cache-Control: no-cache`, Vite's hashed `/assets/*` with a one-year `immutable`
  lifetime – phones pick up a new version on the next load. `pb_hooks/static.pb.js`
  registers the static route `GET /{path...}` itself (PocketBase's native file handler with
  the index.html fallback, `--publicDir` read from the process arguments) with the header
  logic as a middleware of that route only – API calls and realtime streams never run JS
  for it (a global JS middleware kept one JS VM per open realtime stream).

Podman note (dev container): the `podman` CLI talks to the host's Podman socket, so
containers run on the host. Published ports are reachable from inside the dev container
via `host.containers.internal` – not those published on the host's loopback (`BIND=127.0.0.1`,
the Quadlet unit) –, from the host via `localhost`. Avoid bind mounts in
scripts (host paths differ); use named volumes and `podman cp`.

## 8. Testing

| Layer | Tool | Where |
|---|---|---|
| Frontend unit/component | Vitest (+ Testing Library) – 438 tests in 49 files | `frontend/src/**/*.test.ts(x)`; runs in the image build |
| API / rules / hooks | Vitest + pocketbase SDK against a real PocketBase – 132 tests in 12 files (races made deterministic by a test-only route that holds a write transaction) | `backend/tests`; runs in `make test` |
| End-to-end | Playwright – 181 tests in 19 files (`playwright test --list`, all projects): Pixel 7 (Chromium), iPhone (WebKit), Desktop Chrome; QR scanning via Chromium fake camera (`qr-camera`); tests that need a quiet server run afterwards in `isolated-chrome` / `isolated-safari` | `e2e/`; runs in `make test` |
| Load test | Node (pocketbase SDK for the dataset, `node:http` + real realtime streams for the performance checks): deterministic dataset (2000 persons, 5 users, ~15k bookings created through the REST API, read back and verified); interactive instance `make loadtest-dev`; performance checks `make loadtest` – API scenarios with virtual SPA devices (real realtime connections, open-loop bar rushes, sweep, export, write contention, fan-out, rate limiter) and UI checks with Playwright/Chromium (phone = Pixel 7 + 4× CPU, desktop) against WARN/FAIL budgets – method, budgets and results in [LOADTEST.md](LOADTEST.md) | `loadtest/`; not part of `make test` |

Both test harnesses start their own throw-away PocketBase, create a throw-away
superuser and switch the login rate limiter off through the settings API (all parallel
workers share one IP); so do the load test's automated runs. `make loadtest-dev` instead
keeps a persistent instance (`.pb/loadtest-data`, fixed superuser `loadtest@example.com`)
and switches the limiter off only while seeding. Test-only routes
(`backend/tests/support/test-routes.pb.js`, `loadtest/support/zz_loadtest-routes.pb.js`)
are copied next to the app hooks of these test and load-test instances only – never into
`backend/pb_hooks` or an image; the load test creates and deletes directories only below
the OS temp dir or `.pb/`, and only those it created itself (marker file). E2E tests are
parallel-safe: every test uses unique names, cleans up after itself and never changes the
seeded `admin` password; concurrent runs on one machine need distinct `E2E_PORT`s, which also
name their fake-camera directories (`$TMPDIR/getraenkeliste-e2e-camera-<port>`); regression tests for fixed bugs are tagged `@regression`.

The performance checks (`make loadtest`) measure only their own throw-away instance – they
create and delete bookings, switch the planner statistics to the state of a production database
(PocketBase's nightly `PRAGMA optimize`, through a test-only route) and finally switch the rate
limiter on again (A9). All virtual devices share 127.0.0.1, which is why the login rate limiter is
off and why scenarios avoid empty filtered lists (PocketBase throttles those per client IP,
see LOADTEST.md). A FAIL budget (user-visible problem) makes the run exit with 1; WARN budgets
(noticeable delay, regression margin) are only reported. The numbers depend on the machine:
the report records CPU, load and whether other processes kept the machine busy.

Manual test on real phones (camera, via the HTTPS reverse proxy) is done by the operator.
