# Getränkeliste – Load test

How the app behaves with the data of a big club: 2000 persons, 5 staff users and about
15,000 bookings. The load test consists of

- a **deterministic dataset** that is created through the app's REST API,
- **`make loadtest-dev`** – the dataset plus the app for interactive testing,
- **performance checks** (`make loadtest`, automated): API scenarios and browser timings on a
  throw-away instance with this dataset, checked against budgets, a report in
  `test-results/loadtest/`.

Everything lives in `loadtest/`, an independent npm package like `backend/tests`, `frontend`
and `e2e` (Node 24, TypeScript run directly by Node's type stripping, `npm run typecheck`).

## Dataset

Defaults below; all of them can be changed (see "Options"). The same seed always produces
the same dataset.

| Part | Content |
|---|---|
| Persons | 2000, `number` = `"1"` … `"2000"` (the user-visible ID / QR payload; record ids stay auto-generated). Austrian/German first + last names plus names of a mixed Viennese population – about half contain diacritics (`Jürgen Mühlbacher`, `Ágnes Kovačević`, `Größbacher`) to exercise the diacritics-insensitive search; about a third have a nickname (`Poldi`, `Schurli`, `Nachtschwärmer`) |
| Users | `user1` … `user5`, role `user`, display names `Testbenutzer 1` … `Testbenutzer 5`, password `loadtest`, `mustChangePassword = false` |
| Admin | the seeded `admin` gets password `loadtest` and `mustChangePassword = false` |
| Offerings | the 7 seeded offerings with prices (set before the first booking): Bier/Wein 3.50 €, Redbull 3.00 €, Murelli 2.50 €, Mineralwasser 2.00 €, Fruchtsäfte 2.50 €, Kaffee 2.00 €, Pfand 1.00 € |
| Bookings | per person a uniformly random number in **[5, 10]** (≈ 15,000 in total), quantity 1 (the UI books one item per tap), offering weighted (Bier/Wein 40 %, Mineralwasser 14 %, Murelli 12 %, Redbull 10 %, Fruchtsäfte 10 %, Kaffee 9 %, Pfand 5 %), each assigned uniformly at random to one of the 5 users |
| Timestamps | spread over the **last 60 days** before the seed start, in a bar's rhythm in Europe/Vienna local time: mostly 17:00–24:00, a tail until 02:00, a little during the day, nothing 02:00–10:00. So the periods of the *Buchungen* screen show realistic subsets (at 10:00 for example: Heute ≈ 20, 7 Tage ≈ 1,500, 30 Tage ≈ 7,300, Alle ≈ 15,000) |

How the data gets in – the production path wherever it matters:

1. Superuser (only for the setup): checks that the instance is empty, sets the prices,
   creates/updates the users and the admin password.
2. Persons: `POST /api/collections/persons/records`, logged in as `admin` (like the SPA).
3. Bookings: `POST /api/collections/bookings/records` **logged in as the booking's user**,
   with the SPA's request shape (`createdBy` + `expand=person,offering.group,createdBy`), 10
   requests in flight, **in the chronological order of their planned timestamps**
   (`dataset.ts` `creationOrder`). Production inserts bookings as they happen, so the table's
   row order follows `created`; index range scans – e.g. "nur meine" over
   `(createdBy, created)` – then read neighbouring rows. With 10 requests in flight
   neighbouring creates may land a few rows out of order (mean displacement ≈ 1 row). Until
   2026-10-20 the seeder created the bookings in a shuffled order, which – after backdating –
   left the rows in random `created` order (mean displacement ≈ 5,000 rows at 15k bookings)
   and made such scans look slower than in production (at 150k bookings `parts=perUser`
   97 → 67 ms, "nur meine" totals 127 → 99 ms; same content). The API rules and the
   `createdBy` / `unitPriceCents` hooks run exactly as in production.
4. Backdating: autodate fields (`created`, `updated`) cannot be set through the REST API, so
   a **test-only, superuser-only route** (`loadtest/support/zz_loadtest-routes.pb.js`,
   `POST /api/loadtest/backdate-bookings`) sets both to the planned time with bound SQL
   parameters, batches of 500 in one transaction each. The file is copied into the hooks dir
   of load-test instances only (next to a copy of `backend/pb_hooks`) – never into
   `backend/pb_hooks`, never into an image.
5. Verification: everything is read back through the API and checked – counts, every person
   and booking against the plan, `createdBy` ∈ the 5 users, 5–10 bookings per person (counted from the stored records),
   `unitPriceCents` = offering price, timestamps = plan and inside the window,
   `GET /api/app/totals` as `user1`.

Robustness: failed requests are never hidden and never blindly repeated – every non-2xx
answer is counted and reported. A create request is not idempotent and a failed one may
still have been committed (lost response), so the seeder first asks the server: records a
failed request created anyway are adopted ("found on the server"); only the rest is
retried, once, and looked for again afterwards. More than 10 failures abort the seed, and
after each create step the server's record count must equal "before + created" (also with
`--no-verify`), so a duplicate can never go unnoticed. The seeder refuses an instance that
is not fresh – persons, bookings, users besides `admin`, an `admin` whose password was
changed, or offering prices set – unless `--force` (the dataset is then added: persons with
an existing number are reused, users are updated) and only talks to the URL it is given.

Determinism: one seeded PRNG (sfc32, no `Math.random`) with separate streams for names,
bookings and timestamps. Two runs with the same seed create identical persons, user
assignments, offerings and per-person counts; only record ids and the absolute timestamps
(relative to the seed start) differ. The summary contains two fingerprints: `plan` (the
whole plan with its local times – the creation order follows from it and the seed start)
and `content` (the data read back, without ids and timestamps), and states the creation
order (`creationOrder: "chronological"`; the report's "Dataset" line says "created in
chronological order"). The switch from the shuffled to the chronological creation order
changed the plan fingerprints (default dataset `65a889515ae0` → `772e236b62b4`), not the
content (`8ee11d327ebc` before and after; 150k bookings: `a18dbf8e75f2`).

On the 8-core / 16-thread dev container the whole seed takes about 6 s (bookings ≈ 3,500/s with 10
requests in flight, p95 ≈ 6 ms).

## Interactive testing: `make loadtest-dev`

```sh
make loadtest-dev                    # fresh dataset, app on http://127.0.0.1:8091/
LOADTEST_KEEP=1 make loadtest-dev    # reuse the last dataset (ready in about a second)
```

1. Downloads PocketBase if needed, installs `frontend/` and `loadtest/` dependencies if
   missing, builds the SPA (`npm run build`, after the lock is taken – always, so the served
   app matches the sources).
2. Starts PocketBase with a fresh data dir `.pb/loadtest-data`, the app's migrations, the
   hooks in `.pb/loadtest-hooks` (= `backend/pb_hooks` + the support route) and a snapshot
   copy of the build, `.pb/loadtest-spa/dist`, as public dir – the production setup, served
   on `127.0.0.1:8091` (8090 stays free for `make dev` / `make run`). The copy is taken on
   every start: `make loadtest` rebuilds `frontend/dist` (`vite build` empties it first),
   which would pull the app's lazy-loaded files away from phones that have it open. Restart
   `make loadtest-dev` to serve a new build.
3. Seeds the dataset with the login rate limiter switched off (8 logins within a second: the
   instance's superuser client plus the seed's 7), prints the seed summary, then switches the
   rate limiter **on** again for the interactive session – as in production.
4. Prints the URLs, logins and a data summary and runs in the foreground until **Ctrl+C**
   (or SIGTERM / SIGHUP), which stops PocketBase; a second Ctrl+C a second later exits at
   once.

Logins (password `loadtest` everywhere, no password change asked):

| Where | Login |
|---|---|
| App `http://127.0.0.1:8091/` | `admin` (role admin), `user1` … `user5` (role user) |
| Dashboard `http://127.0.0.1:8091/_/` | superuser `loadtest@example.com` |

| Variable | Default | |
|---|---|---|
| `LOADTEST_PORT` | `8091` | port on 127.0.0.1 |
| `LOADTEST_HTTP` | – | full listen address instead, e.g. `0.0.0.0:8091` to reach it from phones on the LAN – a warning is printed: every password is well-known; the camera (QR scanning) needs HTTPS, see README "Phones and HTTPS" |
| `LOADTEST_KEEP` | – | `1`: reuse the dataset of the last *completed* seed (`.pb/loadtest-data/loadtest-seed.json`) after checking that its users and persons are still there – otherwise the run stops and asks to run without it; an interrupted seed is always redone; dataset variables given together with it are ignored (warning) |
| `LOADTEST_SEED`, `LOADTEST_PERSONS`, `LOADTEST_USERS`, `LOADTEST_MIN_BOOKINGS`, `LOADTEST_MAX_BOOKINGS`, `LOADTEST_DAYS`, `LOADTEST_CONCURRENCY` | see "Dataset" | dataset shape and write concurrency |
| `LOADTEST_SUPERUSER_EMAIL`, `LOADTEST_SUPERUSER_PASSWORD` | `loadtest@example.com`, `loadtest` | dashboard superuser |

Files in `.pb/` (gitignored): `loadtest-data/` (database + `loadtest-seed.json`, the summary
of the completed seed), `loadtest-hooks/`, `loadtest-spa/` (the snapshot of the SPA build),
`loadtest-pocketbase.log` (PocketBase output of the last run) and `loadtest-dev.pid`
(prevents a second run on the same data dir while one is running; created atomically, a stale
one – its process gone – is taken over atomically, so two starts cannot both take it). The
directories carry a `.getraenkeliste-loadtest` marker file: the load test deletes only
directories it created (or of earlier versions) below `.pb/` – also when `.pb` is a symlink to
another disk – or below the OS temp dir, never a symlink itself.

Frontend work with hot reload on the same data: stop `make loadtest-dev`, then
`PB_DATA_DIR=.pb/loadtest-data make dev` (Vite on `:5173`, PocketBase on `:8090` with the
plain app hooks – the support route is not needed for browsing; the same logins work).
Never run both on `.pb/loadtest-data` at the same time – `make loadtest-dev` refuses to start
while another process uses that data dir (Linux).

## Tooling (`loadtest/`)

```
loadtest/
├── support/zz_loadtest-routes.pb.js   # TEST ONLY superuser routes: backdate bookings, planner statistics, EXPLAIN
└── src/
    ├── index.ts      # library entry point (re-exports everything below)
    ├── instance.ts   # startInstance(): throw-away / persistent PocketBase, rate limiter switch
    ├── api.ts        # SDK clients per identity, logins, counts, error descriptions
    ├── dataset.ts    # buildDataset(): the deterministic plan (pure, no I/O)
    ├── names.ts      # name pools
    ├── random.ts     # seeded PRNG
    ├── time.ts       # Europe/Vienna wall clock ↔ UTC, the SPA's period ranges
    ├── seed.ts       # seedDataset(): plan → REST API → backdate → verify → summary
    ├── verify.ts     # read-back checks + content fingerprint
    ├── stats.ts      # latency percentiles, throughput
    ├── pool.ts       # runPool(): n operations in flight
    ├── format.ts     # text output of summaries
    ├── perf/         # performance checks – see "Performance checks" → "Files"
    ├── ui/           # browser checks U1–U11 (runUiScenarios); page-probe.js = in-page timing
                      # (plain JS, type-checked against probe.ts: tsconfig "allowJs"), machine.ts = CPU monitor
    └── cli/          # seed.ts (npm run seed), dev.ts (make loadtest-dev / npm run dev),
                      # run.ts (make loadtest / npm run loadtest),
                      # ui.ts (node src/cli/ui.ts / npm run ui: the UI checks alone),
                      # model-check.ts (npm run model-check: device model vs. the real SPA),
                      # lock.ts (the pid lock of dev.ts)
```

`npm run seed` (in `loadtest/`) seeds a throw-away instance on a free port, prints the summary
and removes the instance – or seeds a running instance with
`--url <url> --superuser-email … --superuser-password …` (instances without the support route,
e.g. `make dev`: add `--no-backdate`). Note that seeding sets the passwords of `admin` and
`user1` … `user5` to `loadtest`. `npm run seed -- --help` lists all options (`--json <file>`
writes the summary, `--dump <file>` the read-back content for diffs).

Library use (e.g. by the performance checks):

```ts
import { seedDataset, startInstance } from './src/index.ts';

const instance = await startInstance();           // throw-away, free port, temp dir
await instance.setRateLimiting(false);            // all logins come from one IP
const summary = await seedDataset({ url: instance.url, superuser: instance.superuser });
// summary.ok, summary.counts, summary.steps.bookings.latency, …
await instance.stop();
```

## Performance checks: `make loadtest`

```sh
make loadtest                                 # full run (about 11 minutes); report in test-results/loadtest/
LOADTEST_QUICK=1 make loadtest                # short smoke run (about 3 minutes)
LOADTEST_SCENARIOS=A1,A2,U4 make loadtest     # only these scenarios (seeding always runs)
LOADTEST_UI=0 make loadtest                   # API scenarios only, no browser
LOADTEST_SOAK=1 make loadtest                 # additionally A11, a 35-minute soak
```

1. Downloads PocketBase if needed, installs the `frontend/` and `loadtest/` dependencies if
   missing and builds the SPA (production build) – like `make loadtest-dev`. The browser checks
   need Chromium for the package's Playwright, which the run never downloads: install it once
   per machine with `cd loadtest && npx playwright install chromium` (without it the browser
   checks fail with exactly that hint; `LOADTEST_UI=0` skips them).
2. Starts a **throw-away PocketBase** on a free port (temp dir; app migrations + app hooks + the
   test-only support routes; a snapshot copy of `frontend/dist` as public dir, so a concurrent
   build cannot change it), switches the login rate limiter off (every virtual device logs in from
   127.0.0.1, as in the other harnesses) and PocketBase's own backup cron (03:00 UTC) off, and
   seeds the dataset above – the seed's own numbers are the first result, `seeding`.
3. Logs in once per account (`admin`, `user1` … `user5`); all scenarios reuse these tokens (only
   A9 logs in again – it tests the login).
4. Puts the planner statistics into the production steady state (see below) and runs the
   scenarios in a fixed order, each isolated: a crash becomes a `fail` result with the error and
   the run goes on; a scenario that exceeds its watchdog (`LOADTEST_SCENARIO_TIMEOUT_S`, default
   10 min, browser checks 20 min) is aborted and fails, and the remaining scenarios are skipped.
5. Writes the report, stops PocketBase and removes the temp dirs – also on Ctrl+C / SIGTERM /
   SIGHUP (the running scenario is stopped; the browser checks get up to 40 s to close the
   browser and delete their bookings; a partial report is written) and on errors. After the
   report the process exits within a few seconds even if a stopped scenario left something
   running.

Exit code: **0** = no FAIL budget violated (warnings are only reported), **1** = a FAIL budget
was violated, a scenario crashed or nothing ran, **2** = usage error (checked before anything
starts – including a `LOADTEST_SCENARIOS` selection that would run nothing), **129 / 130 / 143** =
interrupted (SIGHUP / Ctrl+C / SIGTERM).

The runner only ever measures its own throw-away instance: the scenarios create and delete
bookings, change the planner statistics and finally switch the rate limiter on. There is
deliberately no option to point it at another server.

### Method

- **Requests exactly as the SPA sends them.** `src/perf/requests.ts` mirrors
  `frontend/src/api/queries.ts`, `api/totals.ts`, `lib/dates.ts`, `api/keyset.ts` and
  `api/mutations.ts`: paths, parameter names, order and values (the SDK's
  `page, perPage, filter, sort, expand, skipTotal=true` of the booking lists), page sizes,
  filters (period ranges in Europe/Vienna local time), `parts` of the totals, the keyset
  cursors of the Buchungen list and the CSV export (`created <= c && …`), the realtime head
  request (`created >= c && …`), the booking expand, the persons list via `getFullList`
  (3 sequential pages for 2000 persons). If the frontend changes how it queries, this module
  has to follow – and `npm run model-check` (below) shows where it does not.
- **Virtual devices** (`src/perf/device.ts`) instead of anonymous request loops: every device has a
  real realtime subscription (`/api/realtime`, the SPA's five topics – everyone watches all users),
  the active queries of its screen and the SPA's data layer (`api/realtime.ts`,
  `api/bookingSync.ts`, `api/invalidate.ts`, `api/mutations.ts`, `api/midnight.ts`,
  `auth/session.ts`):

  | Screen | Active queries (cold load) | Per booking made elsewhere |
  |---|---|---|
  | *Buchen* (person P) | persons (3 pages), P on its own (`getOne`, while the list is not there), groups, offerings; once P is known: totals of P (`parts=summary`), recent(P, 8) | booking of P: totals of P + recent(P, 8); cancellation of a shown booking: totals of P (+ recent when the list was full); another person: **nothing** |
  | *Personen* | persons, totals `parts=perPerson` | per booked person `totals?person=<id>&parts=perPerson` (≈ 0.4 KB); > 10 persons in one batch: the full `parts=perPerson` |
  | *Buchungen* list (filter q, k pages) | persons (the person filter), totals(q) `parts=summary`, k keyset pages | matching booking: summary + **one** head request (newer than the newest shown one, merged into the cached pages); cancellation: summary only (removed locally) |
  | *Buchungen* "Pro Person" / "Pro Angebot" | persons, totals(q) `summary,perPerson` / `summary,perOffering` | per booked person a row request + the summary / a refetch of the small totals |
  | *Verwaltung* Angebote / Benutzer | groups + offerings / users, totals `parts=perOffering` / `parts=perUser` | a refetch of that part (≈ 1 KB) |

  Bookings outside a query's filter (period, person, "nur meine") cause nothing; one 120 ms
  debounce timer collects a batch. A list or per-person totals query is never patched while it
  fetches (first load, refetch, "Weitere laden") or while its previous patch runs: the batches
  arriving meanwhile are merged and applied together once it is idle – one head request or one
  round of row requests for any number of batches; a patch whose query changed meanwhile runs
  again on the new data (at most 3 times, then a refetch). Every uncertain state falls back to
  `invalidateSafely` (a running fetch is not cancelled; one refetch follows it, however many
  invalidations arrived): an invalidated / failed query, a relative period that crossed local
  midnight, a head request that returned a full page or missed a new booking, a failed request,
  > 10 persons, an `update` event. Person and user events reload only the persons / users list
  (the new names are patched into cached rows). Own mutations: a booking tap = POST + the
  person's summary (the recent list is merged from the response), "Rückgängig" = DELETE +
  summary (+ recent when the list was full) – the realtime echo is skipped (one round, not two).
  Lists known to be empty (the cached summary of the same filter is 0) are not requested.
  Session: `auth-refresh` at the start and 60 s after the last check (one per device and
  minute), at once after a guest-style denial (401/403/404). The first realtime connect
  refetches – after the session check – the queries that had loaded before it (on a cold start
  a few small ones); a reconnect refetches every active query (a Buchungen list all its pages,
  one after the other). While connected nothing goes stale by time; a second after local
  midnight the "Heute" / 7 / 30 Tage queries are refetched. Not modelled: rendering (that is
  what the browser checks measure), retries, focus / visibility / `online` events.
- **Model check** (`cd loadtest && npm run model-check`, ≈ 3 min; needs a build in
  `frontend/dist` or `--public-dir`): starts a throw-away instance with the dataset and runs the
  same 11 screens twice – as real pages of the built SPA in Chromium and as virtual devices –
  through the same 17 steps (bookings and cancellations elsewhere, an own tap and its
  "Rückgängig", batches within one debounce, a person without bookings, a batch of 12 persons,
  a renamed person, a renamed user, a quiet minute). Per step and screen the requests (method,
  path, decoded parameters in order; ids and timestamps of the bookings created in the run as
  tokens) must be the same multiset. Session checks run by the clock, not by the events: they
  are left out of the steps and checked on their own (every screen at the start and then every
  60 s, on both sides). The cold loads are compared as sets of distinct requests (without the
  realtime subscription and the session checks) – which queries the first realtime connect
  refetches depends on timing, so the repeats are listed, not compared (Chromium connects later
  than a device, which opens its stream at once: there the first connect repeats up to three
  small requests per screen, ≈ 2 KiB, before any measurement window). Exit code 1 lists every
  difference. Run it after every change to `frontend/src/api/**`; on 2026-10-21 (the final
  application code) it found no difference.
- **Open loop.** Bookings follow a seeded Poisson schedule and are sent at their scheduled time no
  matter how long earlier requests take; latencies count from the scheduled time, so queueing
  shows up instead of silently lowering the load (coordinated omission). Closed-loop loads (A4,
  A6, A7) are reported as throughput and latency *at a concurrency*.
- **Propagation** = scheduled time of a booking → another device whose screen shows it has
  finished the update (every patch, head request and refetch the realtime batch caused for it).
  Devices whose screen does not show the booking – a Buchen phone of another person – need no
  update and are not counted ("unaffected"); the booking device itself is not counted either.
  Realtime events that never arrived and updates that never completed count as missing
  deliveries.
- **Warm-up.** The fleets (A2, A2b, A3, A5's rush) and the closed-loop throughput levels (A7)
  discard a warm-up phase; A1 and A1-planner discard the first requests of every type. A4's burst,
  A10's bookings and A11's soak are measured from the start (A4 reports its first quarter
  separately).
- **Isolation between scenarios.** Before every scenario the runner checkpoints the WAL exactly
  like PocketBase's nightly job (`PRAGMA wal_checkpoint(TRUNCATE)`, test-only route), so every
  scenario starts from the same WAL state whatever ran before it (A3 leaves 30–40 MiB behind). The
  report lists the WAL each scenario found ("WAL left by the predecessor"). Whether a large WAL
  slows later writes was not established – A4's p99 varies between bursts either way.
- **Exact statistics.** Every request is recorded (type, device, start, latency, bytes, status);
  percentiles are nearest-rank over all samples – no histogram buckets – plus throughput, bytes
  and errors grouped by type and message.
- **Load generator health.** For every load-generating thread the event-loop lateness
  (`monitorEventLoopDelay` minus its 10 ms sampling interval) and the thread's CPU time are
  recorded; above p99 50 ms or 70 % of a core the scenario is marked **CLIENT-BOUND** – its
  latencies then contain client-side delay. The
  heavy levels run in up to 4 worker threads (A3's devices, A4's writers, A7's clients).
- **Bandwidth** figures (KiB/s per device, KiB per booking) count response bodies and the realtime
  stream; response headers and requests (≈ 0.3–0.5 KB each) are not included – about 5 % more for
  the small requests of a Buchen phone, negligible for the big screens.
- **Server and machine.** PocketBase's CPU (mean and the busiest second) and memory (RSS) from
  `/proc/<pid>` every 250 ms, the database file sizes, the load average at the start and the end
  of the run, and the CPU used by *other* processes (`/proc/stat` minus PocketBase minus the load
  generator; host-wide, so it also sees other containers on the same host). When other processes
  keep more than a quarter of the logical CPUs busy (at least one core; 4 of 16) during a scenario
  – the same rule as the browser checks – the report marks it **BUSY MACHINE**: compare with a
  run on a quiet machine before trusting small differences. A3 shows these cores per level as
  well, since a busy level alone can move the knee down.

#### Planner statistics: freshly seeded vs. steady state

PocketBase runs `PRAGMA optimize` by itself: daily at 00:00 UTC (cron job `__pbDBOptimize__`,
`core/base.go`) and after every collection schema change
(`core/collection_record_table_sync.go`). In a new database the app tables are still empty when the
migrations create them, so `sqlite_stat1` covers PocketBase's system tables only (the index
migration `1790550003` deletes the seed-state rows its own optimize would record for the app
tables – 1 user, 1 group, 7 offerings –, which the nightly optimize would not correct); bookings,
persons, users, offerings and groups get statistics in the first night with data. Pooled read
connections load the statistics when they are opened – an `ANALYZE` into an existing
`sqlite_stat1` does not reach connections that are already open – and PocketBase closes
connections that were idle for 3 minutes, so after a night every connection plans with them.

The difference mattered for the combined filters: with only single-column indexes SQLite
answered "Heute / 7 Tage / 30 Tage + nur meine" without statistics through
`idx_bookings_createdBy` (all of the user's bookings, sorted), with statistics through
`idx_bookings_created` (the date range). Since the composite index `(createdBy, created)`
(migration `1790550003`, F8) both states use it – A1-planner shows no plan difference any more.
The load test measures the **steady state of a production database**: after seeding, the
test-only route runs exactly the nightly `PRAGMA optimize` and then makes every pooled connection
reload the schema. Before that, A1 measures the list and totals filter variants in the freshly
seeded state (result `A1-planner`, including `EXPLAIN QUERY PLAN` of both states).

#### PocketBase's throttle for empty searches

PocketBase sleeps a random 0–500 ms before answering a list request that has a `filter` and
returns no record, once more than 3 such requests came from the same client IP in its current
3-second window (per collection; a fixed window starting at a whole second; `apis/record_crud.go`,
an anti timing-attack measure – active even with the rate limiter off, superusers excepted). All
virtual devices of the load test share 127.0.0.1, so the scenarios keep their filtered views
non-empty (A1 creates its own "today" bookings before it measures "Heute + nur meine") and
`A1-empty` measures the throttle on its own, inside one window. In production every
phone behind the same NAT / proxy address shares that allowance (see `deploy/reverse-proxy.md`
"Client IP" for the proxy side). Since the F7 fix the SPA does not request a list that the
cached summary of the same filter says is empty (the recent bookings of a person without
bookings, an empty Buchungen filter) – the first load still sends both in parallel; the
throttle itself is PocketBase's, so A1-empty keeps its WARN.

### Scenarios

Default order: `seeding → A1 → A2 → A2b → U1 … U11 → A5 → A6 → A7 → A8 → A10 → A3 → A4 → A9`
(A11 with `LOADTEST_SOAK=1` – or when selected explicitly – before A3). A1 runs first to see the freshly seeded database; the
browser checks run after the rushes so that "Heute" has bookings; A3 (stress) and A4 (≈ 4,500 extra
bookings) come late; A9 last, because it switches the rate limiter on. Durations are those of the
full run (quick run in parentheses).

| ID | Simulates | Load | Budgets (WARN / FAIL) |
|---|---|---|---|
| `seeding` | creating the dataset through the REST API | persons as `admin`, bookings as their user, 10 in flight | booking create p95 25 / 250 ms · creates/s WARN < 1,000 · person create p95 25 / 250 ms · failed requests or read-back checks FAIL > 0 |
| `A1` | one device on an otherwise idle server: every request type of the SPA – the totals with the `parts` each screen sends (summaries per period / "nur meine", per person, Pro Person, per offering, per user, the Buchen card, a realtime row), list page 1, the keyset page 2 and the realtime head request; for comparison the totals with all four parts (what the big screens requested before the fixes, no budget) | sequential, 5 warm-up + 30 per type (3 + 10) | p95: small requests (≤ 10 KB: one person's totals, recent, groups …) 25 / 100 ms · list page 50 / 200 ms · persons list (3 pages) 150 / 500 ms · totals over many bookings (per person, periods, nur meine, per offering / user) 100 / 300 ms · size of the per-person totals WARN > 400 KiB |
| `A1-planner` | the list / totals filter variants without and with planner statistics | 3 + 15 per variant and state (3 + 5) | information only (p50/p95 per state, query plans) |
| `A1-empty` | devices behind one IP showing filtered views without results | the same empty request back to back inside one of PocketBase's 3-s windows (aligned to a whole second) | max of the throttled requests (4th … of the window, ≥ 5 of them) WARN > 200 ms; median and requests 1–3 reported |
| `A2` | bar rush: 5 phones on *Buchen* (user1–5, a person selected), 1 laptop on *Buchungen* "Alle" | exactly 2 bookings/s per window (Poisson spacing, round-robin over the phones, offerings weighted), 10 % undone after 1–3 s; 10 s warm-up + 60 s (3 + 25 s) | create and delete p95 (from the scheduled time) 50 / 250 ms · propagation p95 500 / 1,500 ms · failed requests FAIL > 0 · laptop download WARN > 1 MiB/s · PocketBase CPU (mean) WARN > 100 % |
| `A2b` | A2 with heavy screens: + 2 phones on *Personen*, the laptop with 10 list pages loaded (before the fixes: every booking → the complete totals on each Personen phone, all 10 pages + totals on the laptop; now one row per Personen phone, summary + one head request on the laptop) | as A2; 10 s + 45 s (3 + 20 s) | as A2, plus Personen phone download WARN > 512 KiB/s; download per booking reported (normalizes for the rate) |
| `U1` … `U11` | the browser checks | see "UI checks (browser)" | |
| `A5` | the accountant exports all bookings as CSV | the SPA's keyset export (500 per page, expand, `created <= c && …`), alone 3× (1×) and 2× (1×) during an A2-like rush; once with the pre-fix cursor condition for comparison | total time (median) 3 / 10 s, alone and during the rush · keyset page p95 WARN > 100 ms · size WARN > 25 MiB · projected total at 10× the bookings WARN > 10 s (fit of the full pages' cost over their older rows) · failed requests FAIL > 0 |
| `A6` | all devices load the persons list at once (reconnect storm) | 5 devices × 10 bursts, 20 devices × 5 bursts (3 / 2) | time to the complete list p95 150 / 500 ms |
| `A7` | several big screens load the totals at the same time | closed loop with 1 / 5 / 16 clients, 2 s each, variants as the SPA sends them: per person (all bookings), 30 / 7 Tage / Heute / nur meine summaries, the Buchen card, a realtime row, plus all four parts for comparison (quick: per person + person at 1 / 5) | per-person totals p95 with 5 clients 100 / 500 ms (before the fixes: the totals with all four parts); the throughput curve is reported |
| `A8` | someone scrolls far back on *Buchungen* | keyset pages 1 … 20 ("Weitere laden", each cursor from the previous page), the last page of "Alle" and "nur meine", the full refetch of k = 1 / 5 / 10 / 20 loaded pages (reconnect / realtime fallback) | refetch of 10 pages p95 300 / 1,000 ms · last page of "Alle" p95 50 / 200 ms |
| `A10` | many browsers left open that only listen | 6 / 20 / 100 / 300 realtime subscribers (6 / 20 / 100), 40 (20) bookings created one by one, then deleted | event delivery p95 with 20 subscribers 50 / 250 ms (all streams are read by one client thread: at 300 the delivery values are upper bounds) · delete p95 with 100 subscribers FAIL > 50 ms · undelivered events FAIL > 0 |
| `A3` | a growing crowd up to the knee | 5 / 10 / 20 / 40 / 60 / 80 devices (5 / 20), one laptop (3 pages) per 8 devices, each phone books every 2 s; 5 s + 30 s per level (2 + 10 s) | knee = first level whose propagation p95 doubles, whose throughput stops rising, that has errors or missing deliveries – it lies between the last good level and that one, and it is this host's knee (PocketBase shares the 16 threads with the load generator; the table shows its CPU per level and the cores other processes took meanwhile – a busy machine moves the knee down, the detail then names the busy levels): WARN < 40, FAIL < 15 devices · failed requests at ≤ 40 devices FAIL > 0 |
| `A4` | many simultaneous booking taps | 20 closed-loop writers (10 % undo), 6 listeners, the per-person totals 5×/s (what a Personen screen loads when a batch holds > 10 persons; before the fixes: all four parts); 20 s or 5,000 creates (5 s / 1,000) | create p99 100 / 250 ms (below 100 ms a tap feels instant; this setup measures 15–51 ms) · failed requests incl. `SQLITE_BUSY` FAIL > 0 |
| `A9` | shift start, then someone mistypes | 6 logins twice one by one and twice at once; then the rate limiter on: 12 logins in a row | login p95 200 / 1,000 ms · the first HTTP 429 must come at exactly attempt 11 (fresh limiter window; earlier, later or none FAIL) |
| `A11` | an evening, opt-in (`LOADTEST_SOAK=1`) | A2's devices for 35 min: rush phases at 1 booking/s and quiet phases of > 5 min (realtime idle timeout) | create p95 50 / 250 ms · propagation p95 500 / 1,500 ms · failed requests FAIL > 0 · PocketBase RSS growth WARN > 100 MiB · auxiliary.db growth WARN > 50 MiB/h |

#### Budgets

**FAIL** marks a user-visible problem (a booking tap that waits more than 250 ms, a screen that
updates more than 1.5 s late, a failed request); **WARN** a noticeable delay, a bandwidth or
capacity concern, or the regression margin (typically 3–10× the baseline). Each budget carries a
one-line rationale (shown in the report). They apply to a load-test instance on localhost – real
networks add their latency on top, and the bandwidth figures (KiB/s per device) are what a bar's
Wi-Fi has to carry. Budgets express user-visible thresholds; they are not tuned to make known
issues pass or fail – the fixes of 2026-10-20 did not move a limit; where a fix made a metric
meaningless, the metric now measures what the app sends instead (A1/A7: the per-person totals
instead of the totals with all four parts, U2: 2 requests per tap instead of 5). Before the
fixes one value sat close to its WARN limit and could flip on a busy machine: A7's totals with
all four parts at 5 clients (p95 79–92 ms, WARN 100 ms); its successor, the per-person totals,
measures ≈ 43 ms. Shared budgets live in `src/perf/budgets.ts`, scenario-specific ones next to
their metric.

### UI checks (browser)

What users feel in the browser with 2000 persons and ~15,000 bookings: screen ready times,
search keystrokes, booking taps, list views, the QR sheet, the CSV export, realtime propagation
between devices, long tasks, JS heap and DOM size. Code: `loadtest/src/ui/` (`runUiScenarios`;
`make loadtest` runs it after the API rush A2/A2b, so "Heute" has bookings).

**Devices.** Chromium from the package's Playwright 1.63 (headless shell, installed once with
`cd loadtest && npx playwright install chromium` – the checks never download it), two profiles:

| Profile | Emulation |
|---|---|
| phone | Playwright's `Pixel 7` descriptor (412×839 viewport, DPR 2.625, touch – the checks tap) plus CDP `Emulation.setCPUThrottlingRate` **4×**, set before the first navigation |
| desktop | `Desktop Chrome` (1280×720), no throttling |

Both use locale `de-AT` and time zone `Europe/Vienna` like the E2E suite, so the period filters
match the dataset's local-time model. At the start the same JS workload runs on both profiles as
a CPU calibration (`data.cpu` in every result). If the phone is not ≈ 4× slower (outside
60–160 %), the throttling did not work and every phone variant FAILs with the metric
`phone.throttling` – its numbers would come from a fast CPU.

**Login.** No login form and no extra logins: the SDK auth store (`pocketbase_auth`) and the
selected guest (`gl.selectedPersonId`) are injected through Playwright's `storageState` from the
runner's one-time logins. The app still does its normal start (auth refresh, realtime
subscription) – that is part of what is measured.

**How a timing is taken.** All times come from the page itself (`performance.now()` in
`src/ui/page-probe.js`, installed with `addInitScript` and type-checked against `probe.ts`), never
from Node – Playwright's polling intervals would add hundreds of milliseconds of jitter:

- *Start*: navigation start for cold loads; for interactions the input event's own timestamp
  (`event.timeStamp`: when the browser received the tap or key press, so a busy main thread
  counts). Every keystroke is a real key event, also "ü".
- *End*: the first animation frame in which the DOM shows the **expected new content**, plus that
  frame's rendering (a `user-blocking` task posted from the frame callback runs after style,
  layout and paint). Elements that fade in – toasts, the person picker – must be **visibly**
  painted (effective opacity ≥ 0.5). Conditions are re-checked after DOM mutations
  (MutationObserver → one `requestAnimationFrame`; every frame while a visibility condition is
  pending), never with fixed sleeps and never with `networkidle` (the realtime stream never ends).
- *Expected content* is computed from API data with the SPA's own rules: exact row counts, the
  first row, amounts in the app's `€ x,yy` format, the Buchungen list's `data-filter` attribute,
  search results from a copy of `frontend/src/lib/search.ts`. A condition that is already true
  when the action starts aborts the measurement – nothing can be satisfied by a skeleton or by the
  previous list.
- Long tasks (`PerformanceObserver('longtask')`) and Event Timing entries are collected in the
  page; requests and bytes on the wire through a CDP Network session.
- Repetitions: cold timings use a fresh browser context per run (empty HTTP cache), median of 3
  runs (quick: 1); "warm" = reload in the same context (JS/CSS from the HTTP cache). Cheap steps
  are repeated too and reported as medians of 3: the picker's opening, the Personen search
  sequence, the cached tab switch, and every Buchungen step (they run on each of the three cold
  pages). Between steps the page must be idle (no request in flight, no long task for 300–500 ms)
  – pacing, not timing; a page that does not settle is noted in the result.
- Bookings created by the checks (U2, U5, U9) are deleted again; a final sweep removes any leftover
  of the booking accounts and checks that the booking count is back to its value before the UI
  part – also after Ctrl+C.

A Chromium trace of a Personen cold load on the phone (before the fixes, all 2000 rows) confirmed
the end point: React committed the 2000 rows at ≈ 610 ms, but the frame with the list was only
produced at 1153 ms – style, layout and paint of 20,800 elements took 540 ms on the throttled CPU.
The probe reported 1155 ms; the trace's screenshots switch from the spinner to the list between
1151 and 1159 ms.

| ID | Simulates | Measured – end = expected content (visibly) painted | WARN phone / desktop | FAIL phone / desktop |
|---|---|---|---|---|
| U1 Buchen cold start | Opening the app with the last guest still selected | navigation → person card with total, latest 8 bookings, all tiles (median of 3); warm reload; requests (11 before the fixes; now ≈ 14: the selected person on its own, and the first realtime connect repeats the few small requests that had loaded before it), bytes | 1.5 s / 1 s | 4 s / 3 s |
| U2 Booking tap | Tapping drinks for the selected guest | tap → toast visible, tap → total and count (5 taps, median; a fresh toast fades in, later taps update it in place); requests per tap (2: POST + the person's summary; 5 before the fixes); "Rückgängig" | 300 ms / 200 ms | 1 s |
| U3 Person picker | Finding a guest by name or number | tap → picker with 60 persons visible (median of 3); every keystroke of "müller", clear, "1234", clear, "a" → result list (p95) | open 300 ms, keystroke 100 ms | open 1 s, keystroke 200 ms |
| U4 Personen | The Personen tab and its search | navigation → the first 100 of 2000 rows with totals and the footer "100 von 2.000 Personen angezeigt"; keystrokes "m", "mü", clear → filtered list (first 100 matches + footer; slowest keystroke, median of 3 sequences); "Weitere 100 anzeigen" → 200 rows (median of 3); tab Buchen → Personen: first time (cold-start budget) and again with cached data (interaction, median of 3) | ready 2 s / 0.8 s, keystroke 300 ms, more 300 ms, tab again 300 ms | ready 5 s / 2 s, keystroke 1 s, more 1 s, tab again 1 s |
| U5 Personen during a rush | A device on Personen while other devices book 1 drink/s | 10 bookings (open loop, as user2–user5) for persons of the first 100 rows: long tasks in each 1-s window (median), time until the row shows the new total, requests and bytes per booking (1 row request ≈ 0.4 KiB; before the fixes the complete totals, 253 KiB) | 100 ms per booking | 300 ms per booking |
| U6 QR sheet | Printing the QR codes of all persons | navigation → all 2000 QR cards painted and the progress hint gone (the cards are added step by step – 100, then up to 400 per step; "Drucken" is enabled only then); the first 100 cards (info); longest main-thread task (median of 3) | ready 3 s / 1 s, task 500 ms | ready 8 s / 3 s, task 2 s |
| U7 Buchungen | Checking the bookings | cold ("Alle"); steps Heute, 7 Tage, 30 Tage, Alle, one person (the filter opens the person picker – timed on its own –, the number is typed as preparation, the step is the tap on the person), Alle Personen ("×"), Nur meine on/off → list, count and sum; "Weitere laden" ×10 (keyset pages); "Pro Person" (first 100 rows; its rows are loaded when the view opens) and its "Weitere 100 anzeigen"; "Pro Angebot" – every step median of 3, the slowest step / click counts | cold 1.5 s / 1 s, step 500 ms, more 300 ms, picker 300 ms, Pro Person 1 s, its "Weitere 100" 300 ms | cold 4 s / 3 s, step 2 s, more 1 s, picker 1 s, Pro Person 3 s, its "Weitere 100" 1 s |
| U8 CSV export | Exporting the whole history | click → "… Buchungen exportiert" visible; the file is checked (one row per booking); requests, MiB | 5 s / 3 s | 15 s / 10 s |
| U9 Realtime propagation | Two phones serving the same guest, a laptop on Buchungen | tap on phone A → phone B shows the new total, the laptop the new count (5 rounds, median) | 1 s | 3 s |
| U10 Admin screens | Verwaltung → Angebote, → Benutzer | navigation → all rows (Angebote incl. the "Gebucht" badges; the screens load only `parts=perOffering` / `parts=perUser`) | 1.5 s / 1 s | 4 s / 3 s |
| U11 Bar Wi-Fi (report only) | A phone on a busy Wi-Fi: 5 Mbit/s down, 2 Mbit/s up, 50 ms RTT (CDP network emulation), served by PocketBase directly (no compressing proxy) | Buchen cold and reloaded, Personen and Buchungen cold, CSV export: time and bytes; how much gzip would save on the largest JSON responses (per-person totals, persons page, CSV page) | – | – |

Before the 2026-10-20 fixes the known slow spots WARNed on the phone: the Personen search ("clear"
brought back all 2000 rows), every switch to the Personen tab (all rows mounted again, even with
cached data), the main-thread block per remote booking on Personen and the QR sheet's single long
task. Personen and "Pro Person" now render 100 rows (+ 100 per "Weitere 100 anzeigen"), memoized,
the QR sheet adds its cards step by step – all of them pass now (see "Baseline results"). Budgets
express what users notice; they were not moved for the fixes and are not moved to make a known
issue pass. A metric that does not apply to the dataset (e.g. "Weitere laden" with ≤ 50 bookings,
"Weitere 100 anzeigen" with ≤ 100 persons) is reported as info with the reason.

Results are one per profile (`U4-phone`, `U4-desktop`); U9 combines two phones and a laptop; U11
is phone-only and runs in the full run only. Quick mode (`LOADTEST_QUICK=1`): one run each and a
subset – U1 and U4 on both profiles, U2, U3, U5 (5 bookings), U6, U7 (3 × "Weitere laden") on the
phone, U8 and U10 on the desktop, U9 with 2 rounds – about 35 s; the full UI part takes about
3 minutes. `LOADTEST_SCENARIOS` selects UI checks by id (`U4`) or variant (`U7-phone`);
`LOADTEST_UI=0` skips them.

**Busy machine.** Browser timings are only as good as the CPU the browser gets. While the checks
run, the CPU use of the machine is sampled every ≈ 500 ms (`src/ui/machine.ts`): the whole
machine (`/proc/stat`, or the cgroup's usage under a CPU quota), the load test's own processes
(this process and its descendants: PocketBase, the browser) and the rest ("foreign"). When a
window that overlaps a measured timing had more foreign load than a quarter of the CPU capacity
(at least one core: 4 of 16, 1 of 4), the result is marked `clientBound` ("machine busy – timings
unreliable") and the detail names the affected timings. The flag is informational – it never
changes a verdict. Note that inside a container, other containers on the same host count as
foreign load (they share the CPUs) although `ps` does not show them: run the checks on an
otherwise idle host. Each result also records `data.loadavg` and `data.busyCores`.

Robustness: every wait has a timeout – also the calibration, closing pages and closing the browser
(a wedged browser is killed); a crashed page or browser fails only the running variant (`error`
in the result; the browser is relaunched for the next one) and the browser is always closed.
Ctrl+C (the runner's abort signal) stops the checks promptly: the running variant fails, the rest
is skipped, the browser is closed and the bookings are cleaned up.

Running the UI checks alone (development):

```bash
cd loadtest
node src/cli/ui.ts                    # throw-away instance, seed, logins, U1–U11, table
node src/cli/ui.ts --quick --only U4  # one scenario, quick
node src/cli/ui.ts --only U4 --profile phone --runs 1 --trace   # plus a Chromium trace
node src/cli/ui.ts --help
```

It prints a table and writes `test-results/loadtest-ui/ui-results.json` (the trace, if asked for,
next to it – open it in Chrome DevTools → Performance). The instance serves a snapshot copy of
`frontend/dist`, so a parallel `make loadtest-dev` rebuild cannot interfere. Ctrl+C waits briefly
for the browser to close and the bookings to be cleaned up, then exits with 130.

Caveats: 4× CPU throttling of a desktop core is a proxy for a mid-range phone, not a real one
(different CPU, GPU, memory bandwidth, thermal limits) – read the phone numbers as relative
indicators. Chromium only (no WebKit / iOS Safari). Localhost network except U11; software
rendering in the container. Expected values depend on Node's and Chromium's ICU formatting the
same `de-AT` amounts and on "Heute" not crossing local midnight during a check – a mismatch fails
loudly (timeout), it never measures the wrong thing.

### Reading the report

`test-results/loadtest/` holds

- `report.md` – the verdict first (**PASS**, **PASS with N warnings**, **FAIL – …**,
  **INTERRUPTED**), the run (date, duration, knobs, git commit + whether the working tree differs,
  machine, load average, Node and PocketBase versions, the instance's settings, dataset, planner
  state; a hint when the run crossed 00:00 UTC, when PocketBase's nightly job may have run), then
  - **Findings**: every WARN / FAIL metric with its value, the limit and what it means for the users,
    failures first;
  - **Measurement validity**: scenarios limited by the load generator (CLIENT-BOUND) or measured
    while other processes kept the machine busy (BUSY MACHINE);
  - **Overview**: one line per scenario (verdict, duration, number of warnings / failures, machine
    load, the WAL the scenario found before its checkpoint);
  - one section per scenario: what it simulates, its metrics with WARN / FAIL limits, notes, the
    budget rationale and tables (request types, per device, per level, page curves, query plans …).
- `results.json` – everything machine-readable: environment, knobs, dataset, planner statistics and
  all scenario results (`src/perf/types.ts`: metrics with value, unit, budget, verdict; notes;
  client-bound flag; raw tables and series in `data`).
- `pocketbase.log` – the PocketBase output of the run.

The console shows one line per scenario while the run goes on and the findings at the end. A run
in which no scenario ran besides the seeding ends with the failure "Nothing ran" (exit code 1),
never with PASS. Note that `make test` deletes `./test-results` – including the load-test
report.

### Options

| Variable | Flag (`npm run loadtest -- …`) | |
|---|---|---|
| `LOADTEST_QUICK=1` | `--quick` | short smoke run: fewer repetitions, shorter phases, fewer levels |
| `LOADTEST_SCENARIOS=A1,A2,U4` | `--scenarios …` | only these scenarios; ids `A1` … `A11` (`A1` includes `A1-planner` and `A1-empty`; `A11` runs the soak), `U1` … `U11` or one variant such as `U4-phone` (any case); seeding always runs. Checked before anything starts: an unknown id, or one that selects nothing in this mode (e.g. `U9-phone` – U9 has no per-profile variants – or `U5-desktop` in a quick run), is a usage error (exit 2) listing the valid ids |
| `LOADTEST_UI=0` | `--no-ui` | skip the browser checks |
| `LOADTEST_SOAK=1` | `--soak` | add A11 to the run; `LOADTEST_SOAK_MINUTES` changes its 35 minutes (8 or more still shows one idle reconnect per device) |
| `LOADTEST_SCENARIO_TIMEOUT_S` | – | watchdog per scenario in seconds (default 600; browser checks 1200; A11 its length + 600): a scenario that exceeds it is stopped and fails, the rest is skipped |
| – | `--results <dir>` | report directory instead of `test-results/loadtest/` |
| – | `--keep-data` | keep the instance's temp dir (debugging) |
| `LOADTEST_SEED`, `LOADTEST_PERSONS`, … | see "Dataset" | a different dataset – the budgets are meant for the default one; at least 5 users (usage error otherwise) |
| `LOADTEST_MIN_BOOKINGS`, `LOADTEST_MAX_BOOKINGS`, `LOADTEST_DAYS` | `--min-bookings`, `--max-bookings`, `--days` | bookings per person (uniformly in [min, max], default 5 … 10) and the days they are spread over (default 60) – e.g. 50 / 100 for ten times the booking history; expect FAILs, the budgets are meant for the default dataset |

Library use (e.g. from another script):

```ts
import { runPerformanceChecks } from './src/perf/runner.ts';

const report = await runPerformanceChecks({
  quick: true, scenarios: ['A1', 'A2'], ui: false, soak: false,
  signal: AbortSignal.timeout(10 * 60_000), log: console.log,
});
// report.verdict, report.results (ScenarioResult[]), report.environment …
```

### Files

```
loadtest/src/perf/
├── types.ts       # result contract shared with the browser checks: ScenarioResult, Metric, Budget, evaluate()
├── runner.ts      # the run: instance, seed, logins, planner state, scenarios in order, UI slot, report
├── report.ts      # report.md / results.json / console summary
├── budgets.ts     # shared budgets with rationale
├── requests.ts    # the SPA's requests (paths, parameters, filters, keyset cursors, totals parts, page sizes, expand)
├── http.ts        # node:http client with keep-alive per device (bodies counted, not parsed)
├── sse.ts         # realtime client (fetch-free SSE parser, SDK-like reconnect)
├── device.ts      # SPA device model: screens, debounce, targeted booking updates (bookingSync) and their lanes,
│                  # invalidateSafely, own mutations + echo, known-empty lists, session checks, connects, midnight
├── fleet.ts       # devices + open-loop booking schedule, optionally in worker threads
├── load.ts        # closed-loop / open-loop helpers (worker-capable), Poisson arrivals
├── worker.ts      # worker-thread entry for fleets and closed loops
├── samples.ts     # raw request samples, exact percentiles, errors grouped
├── analysis.ts    # fleet evaluation: latencies from the scheduled time, propagation, traffic per device
├── health.ts      # load-generator health (event-loop lateness, thread CPU) → client-bound flag
├── server.ts      # PocketBase CPU / RSS and the machine's other load from /proc, database file sizes
├── planner.ts     # planner statistics: fresh vs. steady state (support route)
├── env.ts         # environment of the run (git, machine, versions, load average)
├── scenario.ts    # scenario context, recorder, isolation
├── sleep.ts       # the one abortable sleep
└── scenarios/     # seeding.ts, a01-baseline.ts … a11-soak.ts, index.ts (order)
```

The support file `loadtest/support/zz_loadtest-routes.pb.js` adds two more superuser-only routes
for the performance checks: `POST /api/loadtest/planner-stats` (`status` / `optimize` = the nightly
`PRAGMA optimize` / `reload` = make every pooled connection reload the schema / `checkpoint` = the
nightly `PRAGMA wal_checkpoint(TRUNCATE)`) and
`POST /api/loadtest/explain` (`EXPLAIN QUERY PLAN` of one SELECT, planned on the write connection,
never executed).

## Baseline results

What these results mean for the app – findings ranked by user impact, causes in the code, fix directions, the status after the fixes and growth runs: [LOADTEST-FINDINGS.md](LOADTEST-FINDINGS.md).

Two baselines, each two full `make loadtest` runs (browser checks on) back to back on a quiet
host – run 1 is the baseline, run 2 shows the run-to-run spread:

- **Before the fixes** (2026-10-20, 14:43): the code the findings F1–F10 describe.
- **After the fixes** (2026-10-21, 00:02): the same machine with the fixes of F1–F10 in the
  working tree and the load test adapted to them (the device model checked request by request
  against the SPA with `npm run model-check`; bookings seeded in chronological order). Same
  budgets – no limit was moved; where a fix changed what the app requests, the metric measures
  the new request (named in the cell).

No run has a BUSY MACHINE mark or a client-bound result.

| | Before: baseline (run 1) | Before: run 2 | After: baseline (run 1) | After: run 2 |
|---|---|---|---|---|
| Date | 2026-10-20, 14:43 Europe/Vienna (12:43–12:55 UTC) | 2026-10-20, 14:56 (12:56–13:08 UTC) | 2026-10-21, 00:02 Europe/Vienna (2026-10-20 22:02–22:14 UTC) | 2026-10-21, 00:25 (22:25–22:37 UTC) |
| Code | `feature/multi-user` @ `e7a62a1` + the working tree with the load-test tooling (uncommitted) | the same | `feature/multi-user` @ `206272c` (the load test committed) + the working tree with the fixes of F1–F10 and the adapted load test (uncommitted) | the same |
| Machine | AMD Ryzen 7 7700X (8 cores / 16 threads), 30 GiB, Linux dev container; Node 24.21.0, PocketBase 0.40.4, Chromium 153 (Playwright 1.63; phone CPU calibration ×3.5) | the same | the same machine and versions (calibration ×3.55) | the same (×3.5) |
| Other load on the host | 0–0.3 cores during every scenario (≤ 0.4 cores in every 5-s window) | ≤ 0.15 cores; 1.6 cores during A4 | ≤ 0.2 cores in every 5-s window (mean 0.02) | ≤ 0.2 cores (mean 0.03) |
| Verdict | **PASS with 7 warnings**, exit code 0, 11 min 23 s incl. the frontend build | PASS with the same 7 warnings, 11 min 21 s | **PASS with 1 warning**, exit code 0, 11 min 9 s incl. the frontend build | PASS with the same warning, 11 min 10 s |

| Area | Metric (budget WARN / FAIL) | Before: run 1 | Before: run 2 | After: run 1 | After: run 2 |
|---|---|---|---|---|---|
| seeding | booking creates (10 in flight) | 3,691/s, p95 6.0 ms | 3,777/s, p95 5.8 ms | 4,472/s, p95 5.6 ms (chronological order) | 4,485/s, p95 5.6 ms |
| A1 | totals with every person's row p95 (100 / 300 ms) · size (400 KiB / –) – before: all four parts (every big screen after every booking); after: `parts=perPerson` (Personen / "Pro Person" when they open) | 44.6 ms · 252 KiB | 42.6 ms · 252 KiB | 25.4 ms · 250 KiB (all four parts, no longer sent: 35.3 ms) | 25.2 ms · 250 KiB (35.7 ms) |
| A1 | the totals the Buchungen list / Buchen card request, p95 "Alle" · 30 Tage · nur meine · one person (100 / 300 ms; person 25 / 100 ms) – before: all four parts, after: `parts=summary` | 44.6 · 46.7 · 24.3 · 0.8 ms | 42.6 · 46.8 · 27.3 · 0.7 ms | 2.6 · 2.6 · 1.3 · 0.4 ms | 2.1 · 2.5 · 1.4 · 0.3 ms |
| A1 | list page p95 "Alle" / "nur meine" (50 / 200 ms) · persons list, 3 pages (150 / 500 ms) | 2.9 / 4.1 ms · 12.5 ms | 3.1 / 4.1 ms · 12.4 ms | 3.4 / 3.1 ms · 12.5 ms; keyset page 2 3.1 ms, realtime head request 0.6 ms | 3.0 / 2.8 ms · 13.2 ms; 3.3 / 0.7 ms |
| A1-planner | p50 freshly seeded → with statistics: totals "Heute + nur meine" · lists "… + nur meine" | 3.6 → 0.7 ms (5.1×) · 1.3–1.5× | 3.7 → 0.7 ms (5.3×) · 1.4–1.5× | 0.4 → 0.3 ms · 0.94–1.05×; no plan differs | 0.3 → 0.3 ms · 0.94–1.1×; no plan differs |
| A1-empty | empty filtered list, max of the throttled requests 4 … of one 3-s window (200 ms / –) | **WARN** 484 ms (median 320 ms) | **WARN** 483 ms (median 254 ms) | **WARN** 500 ms (median 394 ms) | **WARN** 490 ms (median 157 ms) |
| A2 | create p95 (50 / 250 ms) · propagation p95 (500 / 1,500 ms) · laptop (1 MiB/s / –) · PocketBase CPU (100 % / –) | 3.7 ms · 177 ms · 605 KiB/s · 20 % | 3.2 ms · 176 ms · 605 KiB/s · 20 % | 3.5 ms · 128 ms (the laptop; the phones show other persons) · 3.5 KiB/s · 2 % | 2.2 ms · 126 ms · 3.5 KiB/s · 2 % |
| A2b | laptop with 10 pages (1 MiB/s / –) · Personen phone (512 KiB/s / –) · propagation p95 · PocketBase CPU | **WARN** 1,513 KiB/s (757 KiB per booking) · 432 KiB/s (216 KiB per booking) · 216 ms · 59 % | **WARN** 1,513 KiB/s · 432 KiB/s · 215 ms · 58 % | 3.5 KiB/s (2 KiB per booking) · 1.1 KiB/s (1 KiB per booking) · 125 ms · 2 % | 3.5 KiB/s · 1.1 KiB/s · 125 ms · 2 % |
| U1 | Buchen cold start phone / desktop (1.5 s / 4 s, desktop 1 s / 3 s) | 281 / 113 ms | 271 / 103 ms | 275 / 102 ms | 283 / 115 ms |
| U2 / U3 | phone: booking tap → toast (300 ms / 1 s) · picker open (300 ms / 1 s) · picker keystroke p95 (100 / 200 ms) | 51 · 66 · 31 ms; 5 requests per tap | 52 · 65 · 31 ms | 51 · 65 · 33 ms; 2 requests per tap | 53 · 65 · 32 ms |
| U4 | Personen phone: ready (2 s / 5 s) · slowest search keystroke (300 ms / 1 s) · tab switch with cached data (300 ms / 1 s) – after: the first 100 rows; "Weitere 100 anzeigen" (300 ms / 1 s) | 1,299 ms · **WARN** 697 ms · **WARN** 682 ms | 1,269 ms · **WARN** 694 ms · **WARN** 676 ms | 334 ms · 74 ms · 102 ms; more 75 ms | 346 ms · 77 ms · 100 ms; more 80 ms |
| U4 | Personen desktop: ready (0.8 s / 2 s) · slowest keystroke · tab switch with cached data · more | 336 · 183 · 191 ms | 330 · 170 · 187 ms | 118 · 31 · 40 ms; 18 ms | 110 · 31 · 40 ms; 19 ms |
| U5 | Personen phone: main thread blocked per remote booking (100 / 300 ms) · booking → row updated | **WARN** 117 ms · 336 ms (253 KiB per booking) | **WARN** 131 ms · 348 ms | 0 ms · 138 ms (0.4 KiB per booking) | 0 ms · 139 ms |
| U6 | QR sheet phone: ready (3 s / 8 s) · longest task (500 ms / 2 s) – after: all cards added step by step, first 100 cards (info) | 1,315 ms · **WARN** 743 ms | 1,291 ms · **WARN** 735 ms | 1,492 ms (first 100: 333 ms) · 84 ms | 1,503 ms (335 ms) · 86 ms |
| U7 | Buchungen phone: cold (1.5 s / 4 s) · slowest filter step (500 ms / 2 s) · "Weitere laden" (300 ms / 1 s) · Pro Person (1 s / 3 s) – after: person filter picker (300 ms / 1 s), Pro Person "Weitere 100" (300 ms / 1 s) | 329 · 127 · 119 · 642 ms | 314 · 127 · 119 · 667 ms | 292 · 86 · 117 · 155 ms; picker 80 ms, more 67 ms | 299 · 85 · 116 · 154 ms; 81, 67 ms |
| U8 | CSV export phone / desktop (5 s / 15 s, desktop 3 s / 10 s) | 1,779 / 1,249 ms (18.7 MiB) | 1,746 / 1,265 ms | 1,313 / 848 ms (18.7 MiB) | 1,330 / 832 ms |
| U9 / U10 | propagation phone A → phone B / → laptop (1 s / 3 s) · Angebote / Benutzer on the phone (1.5 s / 4 s) | 159 / 203 ms · 266 / 229 ms (257 KiB of totals each) | 161 / 196 ms · 259 / 228 ms | 158 / 164 ms · 242 / 225 ms (5.7 / 4.8 KiB of API data) | 159 / 165 ms · 242 / 227 ms |
| U11 | bar Wi-Fi (report only, no compression): Buchen / Personen / Buchungen cold · CSV export · JSON size with gzip | 2.15 / 3.19 / 2.23 s · 33.7 s · 10.3 % | 2.15 / 3.21 / 2.23 s · 33.7 s · 10.3 % | 2.18 / 2.56 / 1.61 s · 33.7 s · 10.3 % | 2.19 / 2.56 / 1.62 s · 33.8 s · 10.3 % |
| A5 | export total (3 / 10 s) · keyset page p95 (100 ms / –) · 10× projection (10 s / –) · size (25 MiB / –) | 0.99 s · 44 ms · **WARN** 51.2 s · 18.7 MiB | 0.98 s · 43 ms · **WARN** 51.8 s · 18.7 MiB | 0.57 s · 18 ms · 6.5 s · 18.7 MiB (the pre-fix filter: 0.96 s) | 0.56 s · 18 ms · 6.5 s · 18.7 MiB (0.96 s) |
| A6 | persons list, 5 / 20 devices at once, p95 (150 / 500 ms) | 26 / 62 ms | 24 / 59 ms | 24 / 59 ms | 22 / 58 ms |
| A7 | totals with every person's row, 5 clients p95 (100 / 500 ms) · best throughput – before: all four parts; after: `parts=perPerson` | 79.4 ms · 68.5 req/s | 81.7 ms · 68.5 req/s | 42.6 ms · 150 req/s (all four parts: 66.8 ms) | 44.1 ms · 147 req/s (69.4 ms) |
| A8 | last page of "Alle" p95 (50 / 200 ms) · refetch of 10 pages p95 (300 / 1,000 ms) – after: keyset pages | 13.9 · 27.6 ms | 14.3 · 26.9 ms | 1.4 · 30.6 ms | 2.2 · 28.8 ms |
| A10 | delivery p95 at 20 / 300 subscribers (50 / 250 ms at 20) · delete p95 at 100 (– / 50 ms) · RSS at 100 → 300 | 3.0 / 8.4 ms · 5.5 ms · 250 → 382 MiB | 2.9 / 8.7 ms · 5.6 ms · 246 → 377 MiB | 1.7 / 7.2 ms · 5.4 ms · 248 → 245 MiB | 1.8 / 8.2 ms · 5.5 ms · 226 → 248 MiB |
| A3 | knee (WARN < 40, FAIL < 15 devices) · 40 devices: propagation p95, req/s, PocketBase · 60 devices · 80 devices | between 40 and 60 · 232 ms, 564/s, 5.1 cores · 519 ms (laptops 634 ms), 8.2 cores · 808 ms (phones 232, laptops 998 ms), 1,141/s, 9.1 cores | between 40 and 60 · 232 ms, 564/s, 5.1 cores · 530 ms (laptops 648 ms), 8.0 cores · 823 ms (laptops 1,015 ms), 1,146/s, 9.1 cores | no knee up to 80 · 127 ms, 100/s, 0.25 cores · 128 ms, 164/s, 0.5 cores · 133 ms, 217/s, 0.8 cores | no knee up to 80 · 126 ms, 100/s, 0.25 cores · 128 ms, 163/s, 0.5 cores · 131 ms, 218/s, 0.77 cores |
| A4 | create p99 (100 / 250 ms) · creates/s · failed requests incl. `SQLITE_BUSY` (– / 0) | 20.9 ms · 2,516/s · 0 | 21.4 ms · 2,270/s · 0 | 15.7 ms · 3,396/s · 0 | 14.7 ms · 3,409/s · 0 |
| A9 | login p95 (200 / 1,000 ms) · first HTTP 429 (exactly at attempt 11) | 44.8 ms · attempt 11 | 44.8 ms · attempt 11 | 45.7 ms · attempt 11 | 45.6 ms · attempt 11 |

The seven warnings before the fixes (no FAIL) were known costs of that code, not measurement
problems:

- **A1-empty** – PocketBase sleeps 0–500 ms before answering an empty filtered list once more than
  3 came from the same IP within 3 s; all devices behind one NAT / proxy address share the allowance.
- **A2b** – after every booking a Buchungen laptop with 10 loaded pages reloaded all pages and the
  complete totals: 757 KiB per booking, ≈ 12 Mbit/s at 2 bookings/s (PocketBase does not compress).
- **U4-phone** (two metrics) – the Personen search re-rendered every matching row ("clear" brought
  back all 2000), and every switch to the Personen tab mounted all 2000 rows again, even with cached
  data.
- **U5-phone** – every booking made elsewhere refetched the complete totals (253 KiB) on a Personen
  phone and re-rendered all 2000 rows.
- **U6-phone** – the QR sheet rendered 2000 QR codes in one main-thread task.
- **A5** – every keyset page of the CSV export sorted all older bookings again (O(n²)): ≈ 1 s then,
  ≈ 51 s projected at 10× the history.

**What changed.** After the fixes one warning is left: **A1-empty** – PocketBase's own throttle,
unchanged by design; the SPA now skips lists its cached summary knows to be empty, so it sends
fewer such requests. The other six are gone: a booking costs the 10-page Buchungen laptop its
summary and one head request (757 → 2 KiB, 1,513 → 3.5 KiB/s), a Personen phone the booked
person's row (216 → 1 KiB) without blocking the main thread (117 → 0 ms); the Personen search,
tab switch and cold start render 100 rows instead of 2000 (697 → 74 ms, 682 → 102 ms, 1.30 →
0.33 s); the QR sheet adds its cards step by step (longest task 743 → 84 ms; complete after
1.49 s instead of 1.32 s, the first 100 after 0.33 s); the CSV keyset pages use a range scan
(export 0.99 → 0.57 s, 10× projection 51 → 6.5 s, linear). Server side, PocketBase needs 2 %
of a core for the realistic rushes (A2 20 %, A2b 59 % before), A7's per-person totals cost
≈ 43 ms at 5 clients (the totals with all four parts 79 ms before, 67 ms now with the
aggregate-first SQL), A3 shows no knee up to 80 devices (40–60 before; 0.8 instead of 9.1 cores
at 80 devices), and a realtime stream no longer holds ≈ 0.66 MiB (RSS 250 → 382 MiB from 100 to
300 streams before, flat now). Propagation p95 is 125–128 ms (the 120 ms debounce plus a few ms)
– measured on the screens that show a booking: a Buchen phone of another person has nothing to
update any more (A2: 480 of 600 device/booking pairs). Unchanged (and not the target of the
fixes): the persons list (A6), logins (A9), Buchen cold start (U1 – it still downloads the 416 KiB
persons list), the bar Wi-Fi numbers of uncompressed responses (U11 – compression is configured in
the reverse proxy, which the load test does not use; Personen and Buchungen cold got faster from
rendering 100 rows and not loading the complete totals), U2, U3 and U9 phone → phone within
± 2 ms (U9's laptop is 40 ms faster: one head request instead of its page and the complete
totals). The Personen /
"Pro Person" per-person totals remain O(history) (25 ms at 15k bookings, see the growth runs in
LOADTEST-FINDINGS.md).

**Run-to-run spread.** Both before-runs used identical datasets and booking schedules (same seeds),
so bytes, KiB/s, request counts and rates, the export size and the knee came out the same (within
about 1 %). Latencies agreed within ± 5 % – A2 propagation 177 / 176 ms, A1 totals 44.6 / 42.6 ms,
A7 79 / 82 ms, A3 at 60 devices 519 / 530 ms, A5 export 0.99 / 0.98 s and its projection 51.2 / 51.8 s,
U1 phone 281 / 271 ms, U4 phone keystroke 697 / 694 ms and ready 1,299 / 1,269 ms, U7 phone cold
329 / 314 ms. Larger relative differences only where values are small or random: U5 phone 117 /
131 ms (median of 10 bookings), A1-empty's median (random sleeps), sub-millisecond requests, and
A4 (2,516 / 2,270 creates/s, p95 12.6 / 15.1 ms, p99 21 ms in both), which in run 2 shared the
machine with ≈ 1.6 cores of other load. The after-runs agree just as closely: bytes and request
rates identical (A2 8.3 req/s, A2b 11.8 req/s, 3.5 / 1.1 KiB/s), latencies within ± 5 % (A1
per-person totals 25.4 / 25.2 ms, A7 42.6 / 44.1 ms, U4 phone ready 334 / 346 ms and keystroke
74 / 77 ms, U6 1,492 / 1,503 ms, U8 phone 1,313 / 1,330 ms, A5 0.57 / 0.56 s); larger only for
small values (A2 create p95 3.5 / 2.2 ms, A8 last page 1.4 / 2.2 ms, A3 create p95 at 80 devices
16 / 8 ms) and A1-empty's random median. Quick runs (`LOADTEST_QUICK=1 make loadtest`): before the
fixes on a busier host (≈ 3 cores of other load, 3 browser timings flagged) PASS with 6 warnings in
3 min 0 s; after the fixes on a quiet host PASS with 1 warning (A1-empty) in 2 min 45 s.

**Conditions and caveats.** Localhost: no network latency or bandwidth limit except U11's
emulation – the KiB/s figures are what a real network has to carry. PocketBase, the load
generator and Chromium share the 16 threads, so A3's knee is this host's: before the fixes
PocketBase needed ≈ 2.2 cores at 20 devices and ≈ 5 cores at 40 devices of A3's mix – a 2–4-core
server reached its limit much earlier; after the fixes 0.1 cores at 20 and 0.8 cores at 80. The
phone profile is a desktop CPU throttled 4× (calibration ×3.5), not a real phone; Chromium only. A
fresh throw-away instance: warm OS caches after seeding, planner statistics put into the
production steady state, all virtual devices on 127.0.0.1 (one IP for PocketBase's per-IP
throttles). "Heute" had 32 seeded bookings at the start of the before-baseline (14:43 local time),
none at the start of the after-baseline (00:02) – plus the rushes' bookings in both. The
after-runs seed the bookings in chronological order (the before-runs: shuffled, see "Dataset") –
same content; at 15k bookings this changed the "nur meine" timings by fractions of a millisecond
(at 150k: tens of ms, see LOADTEST-FINDINGS.md). A11 (soak) was not run. Development runs during
the implementation (shared host) gave the same warnings; these baselines supersede their numbers.
