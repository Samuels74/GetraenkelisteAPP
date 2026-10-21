# Getränkeliste

Multi-user tally app for drinks and other offerings, made for phones at the bar.

- Staff log in on their phones, pick a person (scan the QR code or search by number,
  name, nickname) and tap an offering – booked. A toast offers **Rückgängig** (undo).
- Offerings are organized in groups (starting with *Getränke*) and have prices; bookings
  keep the price at the time of booking.
- *Buchungen* shows totals per period, person and offering and exports CSV (Excel-ready).
- The admin manages users, groups and offerings. Offerings that were already booked
  cannot be deleted – deactivate them instead.

Stack: [PocketBase](https://pocketbase.io) (Go + SQLite: auth, API rules, realtime) serving
a React single-page app – one container, one data volume. Details and design decisions:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Server: Docker Compose

Requirements: Docker with the Compose plugin.

```sh
cp .env.example .env           # port / bind address, optional dashboard superuser
docker compose up -d --build   # build the image (frontend lint, type check and unit tests run inside) and start it
```

The app listens on `127.0.0.1:8090` (plain HTTP) – point your reverse proxy at it; if the
proxy runs in Docker, see [deploy/reverse-proxy.md](deploy/reverse-proxy.md#docker-compose).
Data lives in the volume `getraenkeliste-data`. The container runs with a read-only root
filesystem and without Linux capabilities.

| Command | What it does |
|---|---|
| `docker compose up -d --build` | build and (re)start |
| `git pull && docker compose build --pull && docker compose up -d` | update – `--pull` also fetches newer base images (security fixes) |
| `docker compose logs -f` | follow the logs |
| `docker compose down` | stop and remove the container – the data volume is kept (`down -v` would delete it: all bookings and the backups inside it) |

## Local: Podman

Requirements: Podman and make (the Quadlet unit under "Operation" needs Podman ≥ 5.0).

```sh
make build   # build the image (frontend lint, type check and unit tests run inside)
make run     # start the container on port 8090, data in volume "getraenkeliste-data"
```

`make run` publishes the port on all interfaces – what a development machine needs (a dev
container reaches the host only through its network address, not its loopback), but then the
app is reachable from the whole network, with `admin` / `admin` until the first login. Behind a
reverse proxy on the same host use `make run BIND=127.0.0.1`. As with Compose, the container
runs with a read-only root filesystem and without Linux capabilities. `make run` stores no
settings: pass `PB_ENCRYPTION_KEY` / `PB_SUPERUSER_*` (see "Operation") to every `make run`, or
export them in the shell – values containing `$` only that way (make expands `$` in values
given on its command line).

## First login

Open the app and log in with **`admin` / `admin`** – the app asks for a new password
right away (every user whose password was set by someone else has to choose their own
at the next login). Do this before the app is reachable from outside. Then set the
prices of the offerings under *Verwaltung → Angebote* (they start at 0 €) and create the
user accounts under *Verwaltung → Benutzer*.

## Phones and HTTPS

Browsers only allow camera access – needed for QR scanning – on HTTPS pages. The
container speaks plain HTTP; put it behind your reverse proxy and use the proxy's HTTPS
URL on the phones. Ready-to-use nginx / Caddy / Traefik snippets and the required
PocketBase settings: [deploy/reverse-proxy.md](deploy/reverse-proxy.md) (realtime updates
use Server-Sent Events on `/api/realtime` – the proxy must not buffer them).

On the phone, "Add to Home Screen" installs the app like a native one.

## Operation

- **Updates**: Docker: `git pull && docker compose build --pull && docker compose up -d`;
  Podman: `git pull && make build && make run` – both also fetch newer base images (security
  fixes of Alpine and Node). Give `make run` the same `BIND`, `PB_ENCRYPTION_KEY` and
  `PB_SUPERUSER_*` as before – with a missing or different key the app does not start.
  Database migrations run automatically at startup; the data volume is kept.
- **PocketBase dashboard** (`/_/`, low-level data access, backups, settings): set
  `PB_SUPERUSER_EMAIL` / `PB_SUPERUSER_PASSWORD` in `.env` (Docker) or pass them to
  `make run PB_SUPERUSER_EMAIL=you@example.com PB_SUPERUSER_PASSWORD='…'` (Podman) – the
  superuser is created or updated at start (only one of the two set: just a warning in the
  log). A changed e-mail adds a second superuser, and the old one keeps working until you
  delete it – in the dashboard (collection `_superusers`) or with
  `docker exec getraenkeliste pocketbase superuser delete old@example.com --dir=/pb_data --encryptionEnv=PB_ENCRYPTION_KEY`
  (Podman: `podman exec …`). Restrict `/_/` at the reverse proxy.
  Raw SQL there (SQL editor) bypasses all app rules – no delete guards or admin checks, and a user disabled by SQL stays logged in; edit records through the record forms.
- **Encryption key** (optional): `PB_ENCRYPTION_KEY` encrypts the settings stored in the
  database (e.g. SMTP or S3 credentials). Exactly 32 characters – `openssl rand -hex 16` makes
  one; anything else stops the start with a message. Set it before the first start and keep it:
  the data volume and every backup only start with that key – store it with the off-site
  backups.
- **Backups**: PocketBase creates a consistent snapshot every night (03:00 UTC, the
  last 14 are kept) inside the data volume; dashboard → *Settings → Backups* lists them,
  creates one on demand (do that before an update) and downloads them – keep a copy off
  this machine. Cold backup of the whole volume:
  - Docker: `docker compose stop`, then
    `docker run --rm -v getraenkeliste-data:/data:ro -v "$PWD":/backup alpine tar czf /backup/getraenkeliste-backup.tgz -C /data .`,
    then `docker compose start`
  - Podman: `make stop` (or `systemctl --user stop getraenkeliste` for the service –
    `podman stop` would be undone by its restart policy), then
    `podman volume export getraenkeliste-data -o getraenkeliste-backup.tar`, then start it again
- **Restore**: dashboard → *Settings → Backups* → restore one of the backups (upload an
  off-site copy there first); PocketBase replaces the data and restarts itself. A cold backup
  goes back into the volume while the app is stopped (as above) – into an emptied volume, and
  owned by uid 10001, the container's user (otherwise PocketBase cannot write):
  - Docker:
    `docker run --rm -v getraenkeliste-data:/data -v "$PWD":/backup alpine sh -c 'find /data -mindepth 1 -delete && tar xzf /backup/getraenkeliste-backup.tgz -C /data && chown -R 10001:10001 /data'`,
    then `docker compose start`
  - Podman (`podman volume import` adds to the volume's content, hence a new volume):
    `podman volume rm getraenkeliste-data && podman volume create getraenkeliste-data && podman volume import getraenkeliste-data getraenkeliste-backup.tar && podman run --rm -v getraenkeliste-data:/data alpine chown 10001:10001 /data`,
    then start it again

  Data written with `PB_ENCRYPTION_KEY` – the volume and its backups – only starts with that
  same key.

Podman only:

| Command | What it does |
|---|---|
| `make run` | start / replace the container (`PORT=8090`, `BIND=` all interfaces or `127.0.0.1`, `VOLUME=getraenkeliste-data`) |
| `make stop` | stop and remove the container – the data volume is kept |
| `make logs` | follow the logs |
| `make clean` | remove this project's containers and images and `./test-results` (not the data) |
| `make clean-data` | **delete the data volume** (asks for confirmation) |

Autostart with Podman (≥ 5.0): [deploy/getraenkeliste.container](deploy/getraenkeliste.container)
is a Quadlet unit (systemd user service on `127.0.0.1:8090`, hardened like Compose) –
installation steps are in the file. Use either the service or `make run`, not both.
(With Docker, `restart: unless-stopped` in `compose.yaml` covers this.)

## Development

Requirements: Node 24, make. The PocketBase binary is downloaded to `.pb/` on first use.

```sh
make dev        # PocketBase on :8090 + Vite dev server on :5173 (hot reload)
make test-api   # API/rule/hook tests against a throw-away PocketBase
make test       # full suite in containers: API tests + Playwright E2E (phones + desktop)
```

`make dev` refuses to start while something else answers on port 8090 (e.g. `make run` –
`make stop` it, or use `PB_PORT=…`), and stops both servers when one of them exits.
`make test` copies the reports to `./test-results`. The frontend's own checks run with
`cd frontend && npm run lint && npm run typecheck && npm test`.

```
backend/pb_migrations   schema, API rules, seed data (admin user, "Getränke")
backend/pb_hooks        server-side logic: price snapshot, delete guards, user rules, totals API
backend/tests           API integration tests
frontend/               React app (Vite, TypeScript, Tailwind)
e2e/                    Playwright end-to-end tests
loadtest/               load test: data generator, interactive instance, performance checks
deploy/                 Quadlet unit, reverse-proxy guide
```

## Load test

A deterministic dataset at the size of a big club – 2000 persons (numbers `1`–`2000`), 5 users
and 5–10 bookings per person (about 15,000, spread over the last 60 days), every booking
created through the REST API by one of the users – for trying the app with realistic data
volume, and automated performance checks against it. Method, budgets and results:
[docs/LOADTEST.md](docs/LOADTEST.md).
Where the app slows down and why (findings of 2026-10-20 with fix directions): [docs/LOADTEST-FINDINGS.md](docs/LOADTEST-FINDINGS.md).

```sh
make loadtest-dev                   # seed a fresh dataset, serve the app on http://127.0.0.1:8091/
LOADTEST_KEEP=1 make loadtest-dev   # reuse the last dataset instead of seeding again
make loadtest                       # performance checks (about 12 min), report in test-results/loadtest/
LOADTEST_QUICK=1 make loadtest      # short smoke run (about 3 min)
```

Log in with `user1` … `user5` or `admin`, password `loadtest` (no password change asked); the
dashboard (`/_/`) takes `loadtest@example.com` / `loadtest`. Ctrl+C stops the app. The data
lives in `.pb/loadtest-data`, port 8090 stays free for `make dev`. `LOADTEST_PORT=…` picks
another port, `LOADTEST_HTTP=0.0.0.0:8091` makes it reachable from phones on the LAN (mind the
well-known passwords; the camera for QR scanning needs HTTPS – see "Phones and HTTPS"). For
frontend work with hot reload on the same data: stop it, then run
`PB_DATA_DIR=.pb/loadtest-data make dev`.

`make loadtest` rebuilds the SPA (`frontend/dist`), starts its own throw-away PocketBase on a free
port (8090/8091 stay untouched; it serves a snapshot copy of the build), seeds the dataset and
runs the performance checks: bar rushes with phones and a laptop that keep
real realtime connections and refetch like the app, the CSV export, bursts, a concurrency sweep up
to 80 devices, write contention, realtime fan-out and the login rate limiter (API scenarios
A1–A11), plus screen timings in Chromium on a throttled phone and a desktop (browser checks
U1–U11). Every metric is checked against a WARN / FAIL budget; the report
`test-results/loadtest/report.md` starts with the verdict and the findings, `results.json` holds
the raw numbers. The exit code is 1 when a FAIL budget is violated. `LOADTEST_SCENARIOS=A1,A2,U4`
runs a subset, `LOADTEST_UI=0` skips the browser, `LOADTEST_SOAK=1` adds a 35-minute soak.

## Legacy app

`index.html` in the repository root is the previous single-file version (data only in the
browser's localStorage). It is kept unchanged because GitHub Pages serves it; it is not
part of the new app.
