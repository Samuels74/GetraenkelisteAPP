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
| `docker compose up -d --build` | build and (re)start – also after `git pull` for updates |
| `docker compose logs -f` | follow the logs |
| `docker compose down` | stop and remove the container – the data volume is kept |

## Local: Podman

Requirements: Podman and make.

```sh
make build   # build the image (frontend lint, type check and unit tests run inside)
make run     # start the container on port 8090, data in volume "getraenkeliste-data"
```

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

- **Updates**: Docker: `git pull && docker compose up -d --build`; Podman:
  `git pull && make build && make run`. Database migrations run automatically at
  startup; the data volume is kept.
- **PocketBase dashboard** (`/_/`, low-level data access, backups, settings): set
  `PB_SUPERUSER_EMAIL` / `PB_SUPERUSER_PASSWORD` in `.env` (Docker) or pass them to
  `make run PB_SUPERUSER_EMAIL=you@example.com PB_SUPERUSER_PASSWORD='…'` (Podman) – the
  superuser is created or updated at start. Restrict `/_/` at the reverse proxy.
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

Podman only:

| Command | What it does |
|---|---|
| `make run` | start / replace the container (`PORT=8090`, `VOLUME=getraenkeliste-data`) |
| `make stop` | stop and remove the container – the data volume is kept |
| `make logs` | follow the logs |
| `make clean` | remove this project's containers and images (not the data) |
| `make clean-data` | **delete the data volume** (asks for confirmation) |

Autostart with Podman: [deploy/getraenkeliste.container](deploy/getraenkeliste.container)
is a Quadlet unit (systemd user service) – installation steps are in the file. Use
either the service or `make run`, not both. (With Docker, `restart: unless-stopped`
in `compose.yaml` covers this.)

## Development

Requirements: Node 24, make. The PocketBase binary is downloaded to `.pb/` on first use.

```sh
make dev        # PocketBase on :8090 + Vite dev server on :5173 (hot reload)
make test-api   # API/rule/hook tests against a throw-away PocketBase
make test       # full suite in containers: API tests + Playwright E2E (phones + desktop)
```

`make test` copies the reports to `./test-results`. The frontend's own checks run with
`cd frontend && npm run lint && npm run typecheck && npm test`.

```
backend/pb_migrations   schema, API rules, seed data (admin user, "Getränke")
backend/pb_hooks        server-side logic: price snapshot, delete guards, user rules, totals API
backend/tests           API integration tests
frontend/               React app (Vite, TypeScript, Tailwind)
e2e/                    Playwright end-to-end tests
deploy/                 Quadlet unit, reverse-proxy guide
```

## Legacy app

`index.html` in the repository root is the previous single-file version (data only in the
browser's localStorage). It is kept unchanged because GitHub Pages serves it; it is not
part of the new app.
