# Getränkeliste – Load test findings

> **Snapshot of 2026-10-20** – code `e7a62a1` (branch `feature/multi-user`) plus the load-test
> tooling in `loadtest/` (uncommitted at the time). The numbers describe that code and go stale as
> soon as fixes land: re-run the checks (see "How to reproduce") and compare with
> [LOADTEST.md](LOADTEST.md) "Baseline results".

Does the app run into issues or significant delays with 2000 persons, 5 users and about 15,000
bookings – where, and how much? This document interprets the performance checks of
[LOADTEST.md](LOADTEST.md) (`make loadtest`) for the app's developers: findings ranked by user
impact, each with the measured numbers, the cause in the code, how it scales and a fix direction.

Conventions:

- Numbers are from the baseline run (run 1; a second run agreed within ± 5 %) unless marked G1 or
  G2 (growth runs, see "Runs"). **Measured** = from the runs; **analysis / estimate** = derived
  from them.
- *Phone* = Chromium with a Pixel 7 viewport and 4× CPU throttling (a proxy for a mid-range
  phone), *desktop* = unthrottled Chromium; everything on localhost. Scenario ids (A1 …, U1 …) are
  those of [LOADTEST.md](LOADTEST.md) "Scenarios" and "UI checks".
- Effort: S ≈ up to a day, M ≈ a few days, L ≈ a week or more (rough).
- File references are relative to the repository root; references marked *PocketBase* point into
  the PocketBase v0.40.4 sources.

## Verdict

With 2000 persons, 5 users and about 15,000 bookings the app works without errors, and the server
is not the bottleneck: a realistic rush (5 phones and a laptop, 2 bookings/s) costs PocketBase
20 % of one core, bookings are stored in under 4 ms (p95) and appear on the other devices within
about 0.2 s. The significant delays are on phones, on the screens that render all 2000 persons
(Personen ≈ 0.7 s per search keystroke and per tab switch plus a 0.12-s freeze for every booking
made elsewhere; the QR sheet one 0.74-s freeze; Buchungen "Pro Person" 0.64 s), and in the data
each booking triggers: every "big" screen re-downloads the complete, uncompressed totals (a
Buchungen laptop with 10 pages ≈ 1.5 MiB/s at 2 bookings/s). Both costs grow linearly – measured:
at 10× the booking history the big screens lag 1.7 s behind (FAIL), at 4000 persons the Personen
screen fails its phone budgets (1.3–1.4 s).

## Runs

| Run | What | Other load on the host | Result |
|---|---|---|---|
| **Baseline (run 1)** | `make loadtest`, 12:43–12:55 UTC | 0–0.3 cores during every scenario | **PASS with 7 warnings**, exit code 0, 11 min 23 s; no BUSY MACHINE mark, no client-bound result |
| Run 2 | `make loadtest`, 12:56–13:08 UTC | ≤ 0.15 cores, 1.6 cores during A4 | PASS with the same 7 warnings, 11 min 21 s; every metric within ± 5 % of run 1 |
| Quick | `LOADTEST_QUICK=1 make loadtest`, 12:31 UTC | ≈ 3 cores | PASS with 6 warnings, 3 min 0 s; 3 browser timings flagged "machine busy" |
| Interactive | `make loadtest-dev` on port 8091 | – | ready after 8 s (build + fresh seed); app, login `user1` / `loadtest` and the totals count (14,915 = seeded) checked; Ctrl+C stopped it within 1 s, exit code 0, nothing left running |
| G1 | 10× the bookings: 50–100 per person = 150,472, a selection of scenarios | ≤ 0.9 cores | **FAIL** – 4 failures, 9 warnings (7 min 18 s) |
| G2 | 2× the persons: 4000 (≈ 30,000 bookings), a selection of scenarios | ≤ 0.65 cores | **FAIL** – 3 failures, 12 warnings (4 min 2 s) |

Machine: AMD Ryzen 7 7700X (8 cores / 16 threads), 30 GiB, Linux dev container; Node 24.21.0,
PocketBase 0.40.4, Chromium 153 (Playwright 1.63). The full table of key metrics for both baseline
runs is in [LOADTEST.md](LOADTEST.md) "Baseline results". G1 and G2 are single runs; G1 spreads
its bookings over the same 60 days as the default dataset (see "Caveats").

## Findings ranked by user impact

### F1 – Personen on phones: every interaction renders all 2000 rows

**Measured (phone / desktop):**

- Opening Personen: 1.30 s / 0.34 s until the list with totals is painted (rows alone 0.81 s on
  the phone); 20,804 DOM elements, 21.6 MiB JS heap.
- Search: slowest keystroke 697 ms / 183 ms (WARN > 300 ms) – "clear", which brings all 2000 rows
  back; "m" 315 ms, "mü" 86 ms. 462 ms of the 697 ms are main-thread long tasks, so the input
  field itself lags.
- Switching to the tab again with all data cached: 682 ms / 191 ms (WARN > 300 ms); the first
  switch 1.09 s / 0.35 s.
- While Personen is open, every booking made on another device blocks the phone's main thread for
  117 ms (median, max 148 ms; WARN > 100 ms; desktop 0 ms) and downloads 253 KiB; the row shows the
  new total 336 ms after the booking. At 1 booking/s that is ≈ 12 % of the time frozen.

**When:** every visit to the tab, every keystroke in its search field, and continuously on a phone
left on Personen during service.

**Why:**

- `frontend/src/features/persons/PersonsPage.tsx:95-128` renders every matching person as inline
  JSX – no virtualization, no cap, no memoized row component.
- `PersonsPage.tsx:25-28` builds a new `totalsById` Map on every totals refetch, so all rows
  re-render after every booking: `frontend/src/api/realtime.ts:28-29` invalidates `['totals']` on
  every booking event, and the page reads the reference totals (`PersonsPage.tsx:17`).
- `PersonsPage.tsx:30-35` keeps the search in the URL – one router navigation per keystroke.
- A Chromium trace of the cold load ([LOADTEST.md](LOADTEST.md), "UI checks") shows the list
  committed by React at ≈ 610 ms but painted only at ≈ 1,150 ms: style, layout and paint of the
  20,800 elements alone took ≈ 540 ms.

**How it scales (measured, G2 = 4000 persons):** open 2.31 s (WARN), keystroke 1.34 s (FAIL > 1 s),
cached tab switch 1.36 s (FAIL), 303 ms per remote booking (FAIL > 300 ms); on the desktop keystroke
335 ms and tab switch 344 ms (both WARN). Linear in the number of persons (×1.8–2.6 for ×2 persons);
the booking history does not matter here.

**Fix direction:**

- Cap the rendered list like the person picker does (60 rows + "Suche verfeinern") – S. The picker
  shows what that buys: open 66 ms, keystroke p95 31 ms on the phone (U3, measured).
- Or virtualize the list (only the visible rows mounted) – M. Estimate: open, keystroke and tab
  switch at a few hundred ms or less, independent of the number of persons.
- A memoized row component with primitive props (number, name, nickname, count, totalCents) – S:
  a totals refetch then re-renders only the rows that changed, which should remove most of the
  per-booking freeze (estimate).
- As a cheap first step, `content-visibility: auto` with `contain-intrinsic-size` on the rows – S
  (targets the layout share of the cost).
- Keep the search text in local state with `useDeferredValue` instead of driving the list from the
  URL on every keystroke – S.

### F2 – Every booking makes every big screen re-download (and the server recompute) the complete totals

Today a bandwidth WARN; with a growing history the main scaling limit of the app.

**Measured:**

- `GET /api/app/totals` without filters returns 252 KiB (p95 44.6 ms when requested alone). It
  always contains all 2000 per-person rows plus the per-offering and per-user rows.
- Every booking invalidates the totals on every device, so every screen that shows Personen,
  Buchungen (list, "Pro Person" or "Pro Angebot") or Verwaltung → Angebote / Benutzer refetches
  them; Buchungen also reloads every loaded list page (64 KiB each). The admin screens load
  257 KiB of API data each just for the "Gebucht" badges (U10).
- Realistic rush (A2: 5 phones on Buchen + 1 laptop on Buchungen "Alle", 2 bookings/s): the laptop
  downloads 605 KiB/s = 303 KiB per booking, a phone 28.6 KiB/s; PocketBase 20 % of a core;
  propagation p95 177 ms.
- With heavy screens (A2b: + 2 phones on Personen, the laptop with 10 pages loaded): the laptop
  downloads 1,513 KiB/s = 757 KiB per booking (WARN > 1 MiB/s, ≈ 12 Mbit/s), each Personen phone
  432 KiB/s = 216 KiB per booking; PocketBase 59 % of a core – 3× A2 for the same bookings; the
  totals take p50 91 ms because three screens request them at the same moment; propagation p95
  216 ms.
- Server cost (A7): one unfiltered totals request costs ≈ 53 ms of CPU alone, ≈ 76 ms with 5
  concurrent clients and ≈ 110 ms with 16; throughput levels off at 68.5 requests/s on this 8-core
  host (the cheap filtered variants reach 2,600–9,100 requests/s).
- Analysis: on 5 Mbit/s Wi-Fi a Personen phone needs ≈ 0.35 s and the 10-page laptop ≈ 1.2 s of
  airtime per booking – such a laptop cannot keep up with 2 bookings/s on that link.

**Why:**

- `frontend/src/api/realtime.ts:28-34` – a `bookings` event invalidates `['bookings']` and
  `['totals']` on every device (after the 120-ms debounce, `:36`).
- `frontend/src/api/queries.ts:107-122` – the infinite booking list; TanStack Query refetches every
  loaded page, one after the other.
- `backend/pb_hooks/lib/totals.js:142-212` – every call runs all four aggregates over the whole
  history; `:123-136` then copies each result row property by property into JS objects.
- Nothing is compressed: PocketBase gzips only its dashboard (*PocketBase* `apis/serve.go:83-99`),
  not the API and not the SPA served from `--publicDir` (*PocketBase* `examples/base/main.go:111`),
  and none of the proxy examples in `deploy/reverse-proxy.md` enables compression.

**How it scales (measured):**

- G1, 10× the bookings (150,472 – for the all-time views ≈ 1.5 years at the dataset's rate):
  - unfiltered totals p95 321 ms alone (A1 FAIL > 300 ms; 7.2×), 957 ms with 5 concurrent clients
    (A7 FAIL > 500 ms), and only 5 requests/s instead of 68.5 – ≈ 0.3 s of CPU per call alone,
    ≈ 0.6 s with 5 concurrent clients;
  - realistic rush A2: PocketBase 76 % of a core (was 20 %), propagation p95 649 ms (WARN), the
    Buchungen laptop 790 ms;
  - A2b: PocketBase 202 % (WARN), propagation p95 1,693 ms (FAIL > 1.5 s) – Buchungen and Personen
    1.76 s, while the phones on Buchen stay at 155 ms;
  - cold starts of Personen and Buchungen on the desktop 0.2–0.3 s slower.
- G2, 2× the persons: the unfiltered totals grow to 504 KiB (WARN > 400 KiB), a Personen phone
  downloads 863 KiB/s (WARN), the 10-page laptop 1,945 KiB/s, PocketBase 105 % of a core in A2b
  (WARN).
- Analysis: bytes per booking ≈ 126 B per person × the number of big screens (plus 64 KiB per
  loaded list page); server CPU ∝ booking history × big screens × booking rate. Hypothesis, not
  measured: SQLite's page cache of 32 MB per connection (*PocketBase* `core/db_connect.go:14`) is
  smaller than the database at 150k bookings, which would explain why the cost per call doubles
  under concurrency.

**Fix direction (cheapest first):**

1. Compression in the reverse proxy for JSON, JS and CSS – S: Caddy `encode zstd gzip`, nginx
   `gzip on; gzip_types application/json application/javascript text/css;`, Traefik `compress`;
   leave the `/api/realtime` stream uncompressed. Measured (U11): the largest JSON responses
   together shrink to 10.3 %. Measured separately on the real responses: the unfiltered totals
   4.5–4.7× smaller with gzip (5.3× with brotli), list pages ≈ 14.5×, persons pages ≈ 7.5×. No
   server CPU gain.
2. Request only what a screen shows – M: e.g. a `parts=` parameter for `/api/app/totals`. The
   Buchungen list view and the Buchen card need only count and sum, the admin badges only which
   offerings / users are referenced; only Personen and "Pro Person" need per-person rows.
   Estimate: the laptop's totals refetch drops from 252 KiB and ≈ 50 ms to under 1 KiB and a few
   ms.
3. Refetch less – S/M: refetch only page 1 of the Buchungen list on realtime events (the 1-page
   laptop of A2 downloads 303 KiB per booking instead of 757); a longer debounce on big screens;
   apply the booking from the realtime event to the cached totals instead of refetching them.
4. Make the totals independent of the history length – M/L: maintain the per-person / offering /
   user aggregates incrementally (booking hooks or a summary table) instead of four scans per call,
   and return the query rows without the JS copy. Estimate: removes the G1 growth.

### F3 – CSV export: quadratic server cost and 18.7 MiB of JSON

**Measured:** exporting all 15,143 bookings takes 0.99 s through the API, 1.78 s on the phone and
1.25 s on the desktop (localhost) – 31 requests, 18.7 MiB (1.26 KiB per booking); on 5 Mbit/s
Wi-Fi 33.7 s (U11). The keyset pages take p95 44 ms against 15.5 ms for the first page, and their
time falls as fewer older rows remain. The same export with an index-friendly filter: 0.58 s.

**Why:** `frontend/src/api/keyset.ts:18-26` builds `(created < c || (created = c && id < i))`.
PocketBase binds both literals as separate parameters, so SQLite plans every page as
`MULTI-INDEX OR` + `USE TEMP B-TREE FOR ORDER BY` over all older bookings (EXPLAIN in the A1-planner
section of the report). `frontend/src/api/queries.ts:146-160` loads pages of 500 with the full
expand (person, offering.group, createdBy).

**How it scales:** projected 51 s at 10× the history (A5 WARN > 10 s; from the measured page
costs). A separate measurement at 150,472 bookings with a patched filter: the app's export took
62.3 s, the same export with `created <= c &&` in front of the cursor condition 6.4 s – so the
projection is somewhat optimistic, and the patched filter is linear. The bytes grow linearly
(≈ 187 MiB at 10×).

**Fix direction:**

- Prefix the cursor condition with `created <= c &&` (it selects the same rows) – S: 0.58 s
  instead of 0.99 s today, linear growth.
- Request only the columns the CSV needs (`fields=`, names from the expand) or build the CSV on the
  server – M; several times fewer bytes (estimate).
- Compression (F2, item 1) – S; CSV pages compress ≈ 15.8× (separate measurement).

### F4 – The QR print sheet freezes the phone once (≈ 0.74 s)

**Measured (phone / desktop):** ready after 1.32 s / 0.34 s, with one main-thread task of 743 ms /
180 ms (WARN > 500 ms); 14,743 DOM elements. G2 (4000 persons): 2.53 s and a 1.46-s task on the
phone.

**Why:** `frontend/src/features/persons/QrSheetPage.tsx:82-98` renders all 2000 cards in one
commit, and `frontend/src/components/QrCode.tsx:6` computes each SVG path during render
(`frontend/src/lib/qr.ts:24`).

**Fix direction:** render in chunks (e.g. 100 cards per idle callback or transition) or compute
the paths in a worker – S/M. Low priority: printing is rare.

### F5 – Buchungen "Pro Person" and the person filter render all persons

**Measured (phone / desktop):** switching to "Pro Person" 642 ms / 169 ms (PASS; WARN at 1 s);
filter steps ≤ 127 ms. G2 (4000 persons): "Pro Person" 1.24 s on the phone (WARN), filter steps
211 ms.

**Why:** `frontend/src/features/bookings/BookingsPage.tsx:316-355` sorts and renders all per-person
rows on every totals change; `:142-150` renders a `<select>` with one `<option>` per person on
every render of the page.

**Fix direction:** as F1 (cap or virtualize, memoized rows); replace the `<select>` with the person
picker – S/M.

### F6 – First start on slow Wi-Fi: about 1 MB, nothing compressed

**Measured (U11: phone, 5 Mbit/s down, 2 Mbit/s up, 50 ms RTT):** Buchen cold start 2.15 s
(992 KiB); reload 1.08 s (434 KiB, 418 KiB of it the persons list); Personen 3.19 s (1,237 KiB);
Buchungen 2.23 s (1,308 KiB).

**Why:** every Buchen start loads all persons for the picker
(`frontend/src/features/book/BookPage.tsx:44` → `frontend/src/api/queries.ts:57-62`, 3 requests of
up to 1000), and again whenever the query is older than the 30-s `staleTime`
(`frontend/src/app/queryClient.ts:32`); the JS bundle (≈ 0.6 MB) and all JSON go out uncompressed.

**How it scales:** linear in the number of persons.

**Fix direction:** compression (F2, item 1) – S; estimate: a Buchen cold start from ≈ 1 MB to
≈ 0.25 MB. Keep the persons list cached (`staleTime: Infinity` for `['persons']`; realtime already
invalidates it on every person change and after every reconnect) – S.

### F7 – PocketBase delays empty filtered lists by up to 0.5 s

**Measured (A1-empty, WARN):** within one 3-s window per client IP the first 3 empty filtered lists
answer in ≤ 0.8 ms; from the 4th on, PocketBase sleeps a random 0–500 ms (max 484 ms, median 320 ms).

**When:** lists with a filter and no result – the recent bookings of a person without bookings
(Buchen card and person detail, `frontend/src/api/queries.ts:124-138`), Buchungen with "Heute", a
person or "nur meine" before a matching booking exists. The allowance is per client IP and
collection: all devices behind one NAT or proxy address share it (a proxy without the trusted
client-IP header, or a hosted instance reached from the bar's one public IP), and a realtime event
that makes several devices refetch empty views uses it up at once. Users see "Keine Buchungen" up
to 0.5 s late – never wrong data.

**Why:** an anti timing-attack measure (*PocketBase* `apis/record_crud.go:104-122`, rule `:130`,
sleep `:132-142`), active even with the rate limiter switched off; superusers are exempt.

**Fix direction:** don't request lists that are known to be empty (skip the recent bookings when
the person's totals count is 0, the Buchungen list when the filtered count is 0) – S; make the
reverse proxy pass the client IP (`deploy/reverse-proxy.md`, "Client IP") – S.

### F8 – The "nur meine" filters depend on planner statistics; a composite index is missing

**Measured:** on a database that has not yet seen PocketBase's nightly `PRAGMA optimize` with data
(a new installation, a restored backup), totals "Heute + nur meine" take 3.6 ms instead of 0.7 ms
(5.1×) and the lists "… + nur meine" are 1.3–1.5× slower – small numbers today. G1 (10× the
bookings): even with statistics, totals "Heute + nur meine" take 36.5 ms (SQLite reads all ≈ 30,000
bookings of the user through `idx_bookings_createdBy`), the "nur meine" list 16 ms, the lists
"… + nur meine" on a fresh database 13–16 ms.

**Why:** the bookings table has single-column indexes only
(`backend/pb_migrations/1790550000_init_schema.js:193-197`), and the app tables get planner
statistics only from the first nightly optimize (*PocketBase* `core/base.go:1451-1466`).

**Fix direction:** one migration adding an index on `(createdBy, created)` – S; it keeps both
states and a long history fast (expected).

### F9 – Server sizing and memory per realtime stream

**Measured (A3: one laptop per 8 devices, every phone books every 2 s):** no failed request up to 80
devices; fine up to 40 devices (17.5 bookings/s, propagation p95 232 ms); the first degraded level
is 60 devices (26 bookings/s: p95 519 ms – laptops 634 ms, phones 201 ms), so the knee lies between
40 and 60 devices on this host. PocketBase used 0.2 / 0.4 / 2.2 / 5.1 / 8.2 / 9.1 cores at 5 / 10 /
20 / 40 / 60 / 80 devices.

**Measured (A10):** every open realtime stream costs ≈ 0.66 MiB of server memory (RSS 250 MiB at
100 streams, 382 MiB at 300); delivery stays fast (p95 8.4 ms at 300 subscribers).

**Why:** the CPU goes mostly into F2's totals refetches. The memory: `backend/pb_hooks/static.pb.js:8-18`
is a JS `routerUse` middleware that keeps a JS VM for the whole request – including every
`/api/realtime` stream; beyond the pool of 15 VMs PocketBase creates one-off VMs
(*PocketBase* `plugins/jsvm/pool.go:38-73`).

**Analysis:** a 2-core server would reach its limit at roughly 15–20 devices of A3's booking-heavy
mix – still above a club evening (5–10 devices), but with less margin as the history grows (F2) and
on slower cores.

**Fix direction:** F2's fixes; keep `/api/*` out of the JS middleware (set the SPA's cache headers
in the reverse proxy, or skip the middleware for API paths) – S. Low priority.

### F10 – Logins are limited per client IP

**Measured (A9):** login p95 44.8 ms; 10 logins per 60 s per client IP, the 11th gets HTTP 429 – as
configured (`backend/pb_migrations/1790550002_login_throttling_and_backups.js:22`; the key is the
client IP, *PocketBase* `apis/middlewares_rate_limit.go:178`).

**When:** shift start or typos while all devices share one address.

**Fix direction:** configure the trusted client-IP header in the reverse proxy
(`deploy/reverse-proxy.md`) – S; raise the limit if a whole team logs in at once.

## What is fine (measured, comfortable headroom)

- Writes: booking create p95 3.7 ms during a rush; 20 concurrent writers 2,516 creates/s at p99
  21 ms, without a failed request and without `SQLITE_BUSY` (A4); seeding 3,691 bookings/s.
- The booking tap on the phone: toast and new total after 51 ms (desktop 33 ms), "Rückgängig"
  67 ms (U2).
- Propagation: phone → phone 159 ms, phone → laptop 203 ms (U9); A2 p95 177 ms – mostly the
  app's 120-ms debounce.
- Buchen start 281 ms on the phone / 113 ms on the desktop; the person picker opens in 66 ms,
  keystroke p95 31 ms (its 60-row cap works).
- Buchungen: cold start 329 ms on the phone, filter steps ≤ 127 ms, "Weitere laden" ≤ 119 ms; deep
  paging: last page of "Alle" p95 14 ms, refetch of 10 loaded pages 28 ms (A8).
- The persons list: all 2000 in 12.5 ms (3 requests); 20 devices at once p95 62 ms (A6).
- Realtime: delivery p95 3 ms with 20 subscribers, 8.4 ms with 300; no event lost (A10).
- Logins p95 45 ms; the admin screens open in 266 / 229 ms on the phone.
- Memory: PocketBase RSS 111 MiB in the realistic rush, 145 MiB with heavy screens.
- No failed request in any scenario of either baseline run.

## Capacity summary

- Writes are not a limit (≈ 2,500 creates/s). What limits is the read fan-out per booking: each
  big screen costs one unfiltered totals request (≈ 53–110 ms of CPU, 252 KiB) plus its list pages,
  each phone on Buchen two requests of ≈ 1 ms.
- A realistic bar (5–10 devices, ≤ 2 bookings/s): under one core today – 20 % of a core with one
  laptop, 59 % with three big screens; bookings appear elsewhere within ≈ 0.2 s.
- More devices (A3, this host): fine up to 40 devices / 17.5 bookings/s, degrades between 40 and
  60 devices. The big screens degrade first (Buchungen laptops 634 ms at 60 devices, ≈ 1 s at 80);
  phones on Buchen stay at ≈ 0.2 s. PocketBase needs ≈ 0.4 cores at 10 devices, 2.2 at 20, 5.1 at 40.
- The totals endpoint handles ≈ 68 requests/s on this host today, 5 at 10× the history; the
  number of big screens × bookings per second must stay well below that.
- Network: at 2 bookings/s a Personen phone downloads ≈ 0.4 MiB/s, a Buchungen laptop 0.6–1.5 MiB/s
  (1–10 loaded pages); one such laptop saturates a weak 5 Mbit/s Wi-Fi (≈ 0.6 MiB/s).
- Growth: the booking history drives the server cost (G1), the number of persons the rendering on
  phones and the bytes per booking (G2).

## Caveats

- Localhost: network latency and bandwidth were emulated only in U11 (Chrome DevTools Protocol:
  5 / 2 Mbit/s, 50 ms RTT, no packet loss); the KiB/s figures are what a real network has to carry.
- PocketBase, the load generator and Chromium shared 16 threads on 8 fast cores: the knee and the
  core counts are this host's. The host was quiet during the baseline (≤ 0.3 cores of other load
  per scenario).
- The phone is a desktop CPU throttled 4× in Chromium (calibration ×3.5), not a real device (CPU,
  GPU, memory bandwidth, thermal limits differ); Chromium only – no Safari / WebKit, which iPhones
  use.
- A fresh throw-away instance: warm caches after seeding, planner statistics put into the nightly
  steady state, all virtual devices on 127.0.0.1 (PocketBase's per-IP throttles apply to all of
  them together).
- A synthetic, uniform dataset (5–10 bookings per person). The API scenarios model the app's data
  layer (screens, queries, realtime refetches), not the rendering; the 30-s staleness refetches and
  retries are not modelled.
- G1 and G2 are single runs with a selection of scenarios on a slightly busier host (≤ 0.9 cores of
  other load). G1 packs its 150k bookings into the same 60 days, so its period figures (the
  Buchungen filter steps, totals for 7 or 30 days) are 10× denser than in a real history; the
  all-time figures are representative.
- The soak (A11) was not run: memory growth over hours and the reconnects after 5 minutes without
  events (*PocketBase* `apis/realtime.go:69-70`) are not covered.

## How to reproduce

Run on an otherwise idle machine – the report's "Measurement validity" section says whether other
processes disturbed a scenario. Every `make loadtest` writes `test-results/loadtest/` (`report.md`,
`results.json`) and overwrites the previous report.

```sh
make loadtest                    # the baseline: full run, about 12 min, expect PASS with 7 warnings
LOADTEST_QUICK=1 make loadtest   # short smoke run, about 3 min

# G1 – ten times the booking history (≈ 150,000 bookings), about 7 min; ends with FAIL (exit code 1)
LOADTEST_MIN_BOOKINGS=50 LOADTEST_MAX_BOOKINGS=100 \
  LOADTEST_SCENARIOS=A1,A2,A2b,U4,U5,U7,A7 make loadtest

# G2 – twice the persons (4000, ≈ 30,000 bookings), about 4 min; ends with FAIL (exit code 1)
LOADTEST_PERSONS=4000 LOADTEST_SCENARIOS=A1,A2b,U4,U5,U6,U7 make loadtest

make loadtest-dev                # the dataset plus the app for trying it by hand (Ctrl+C stops it)
```

- To keep the baseline report, give a growth run its own report directory (this uses the existing
  `frontend/dist`, built by the previous `make loadtest`):

  ```sh
  cd loadtest && LOADTEST_PERSONS=4000 LOADTEST_SCENARIOS=A1,A2b,U4,U5,U6,U7 \
    npm run loadtest -- --results ../test-results/loadtest-g2
  ```
- With `LOADTEST_DAYS=600` added, G1's bookings are spread over 600 days instead of 60, which keeps
  the period filters realistic (not measured here).
- The Chromium trace behind F1: `cd loadtest && node src/cli/ui.ts --only U4 --profile phone --runs 1
  --trace`.
- The knobs are described in [LOADTEST.md](LOADTEST.md) "Options"; the dataset knobs work the same
  for `make loadtest-dev`.
