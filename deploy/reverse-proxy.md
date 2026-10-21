# Reverse proxy

The container serves plain HTTP on port `8090` (published on the host by
`docker compose`, `make run` or the Quadlet unit). TLS is terminated by your existing
reverse proxy. Requirements:

1. **One origin** – forward everything (`/` SPA, `/api/`, `/_/` dashboard) to the app.
2. **Realtime** – `/api/realtime` is a Server-Sent-Events stream: no response
   buffering, **no compression**, read timeout well above 5 minutes (PocketBase closes
   idle streams after 5 min, clients reconnect automatically). Every event has to reach
   the phones the moment it is sent.
3. **Compression** – compress everything else (JSON, JavaScript, CSS, HTML, SVG, the
   manifest, WebAssembly): PocketBase sends the API and the app uncompressed (it only
   compresses its own dashboard). Every booking makes the big screens reload their data,
   so this matters on Wi-Fi: the totals shrink about 4.5×, booking list pages about 13×,
   the app's first load from about 1 MB to about a quarter.
4. **Client IP** – send `X-Real-IP`/`X-Forwarded-For` and tell PocketBase to trust it
   (see below), otherwise PocketBase sees every phone as the proxy's IP. Two per-IP
   limits then apply to all phones together: the login throttle (10 attempts per minute –
   **without the trusted proxy header all phones share one login budget**) and
   PocketBase's empty-search throttle (from the 4th filtered list without results within
   3 s it delays each answer by up to 0.5 s – e.g. "Keine Buchungen" for a person without
   bookings).
5. **Dashboard** – restrict `/_/` to your admin network and set *Superuser IPs*.
6. **HTTPS is required for the QR camera** on phones – use the proxy URL there.

Examples use `getraenke.example.com`, the app on `127.0.0.1:8090` and `192.168.1.0/24`
as admin network – adjust.

## Docker Compose

`compose.yaml` publishes the app on `127.0.0.1:8090` (change it in `.env`) – right for
a proxy installed on the host; use the snippets below as they are.

If the proxy runs in a Docker container itself, don't publish a port: put the app on
the proxy's network with a `compose.override.yaml` next to `compose.yaml` (merged
automatically by `docker compose`, gitignored) and point the proxy at
`http://getraenkeliste:8090` instead of `127.0.0.1:8090`:

```yaml
services:
  getraenkeliste:
    ports: !reset []
    networks: [proxy]

networks:
  proxy:
    external: true
    name: proxy   # your proxy's network (docker network ls)
```

Then `docker compose up -d`. PocketBase sees the proxy container's IP as the client
address – configure the trusted proxy header (below) as usual.

## nginx

```nginx
upstream getraenkeliste {
    server 127.0.0.1:8090;
    keepalive 16;
}

server {
    listen 443 ssl;
    http2 on;                      # nginx < 1.25.1: "listen 443 ssl http2;"
    server_name getraenke.example.com;
    ssl_certificate     /etc/letsencrypt/live/getraenke.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/getraenke.example.com/privkey.pem;

    # inherited by all locations below (none of them sets its own headers)
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # compression (text/html is always included; text/event-stream must never be)
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 5;
    gzip_min_length 256;
    gzip_types application/json text/javascript application/javascript text/css
               image/svg+xml application/manifest+json application/wasm;

    location / {
        proxy_pass http://getraenkeliste;
    }

    # realtime (SSE): unbuffered, uncompressed, long-lived
    location /api/realtime {
        proxy_pass http://getraenkeliste;
        proxy_buffering off;
        proxy_cache off;
        gzip off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }

    # PocketBase dashboard: admin network only
    location /_/ {
        allow 192.168.1.0/24;
        allow 127.0.0.1;
        deny all;
        proxy_pass http://getraenkeliste;
    }
}
```

PocketBase trusted header: `X-Real-IP` (nginx overwrites it with the connecting address).
`text/event-stream` is not in `gzip_types`, so the stream stays uncompressed anyway – `gzip off`
keeps it that way if the list is ever extended. `gzip_proxied any` also compresses for
clients that come through another proxy (requests with a `Via` header); Brotli needs the
separate `ngx_brotli` module – gzip is enough here.

## Caddy

```caddyfile
getraenke.example.com {
	# PocketBase dashboard: admin network only
	@dashboardOutside {
		path /_/*
		not remote_ip 192.168.1.0/24 127.0.0.1/8
	}
	respond @dashboardOutside 403

	# compress everything except the realtime stream
	@compressible not path /api/realtime
	encode @compressible zstd gzip

	reverse_proxy 127.0.0.1:8090 {
		# stream responses immediately (SSE on /api/realtime)
		flush_interval -1
	}
}
```

Caddy obtains the certificate, sets `X-Forwarded-For`/`-Proto`/`-Host` itself (incoming
values from untrusted clients are replaced) and has no upstream read timeout by default.
`encode` alone compresses the realtime stream too (its default types include `text/*`; it
still flushes every event) – the events are tiny, compression gains nothing there and the
stream should not depend on how a proxy flushes its compressor, hence the matcher.
PocketBase trusted header: `X-Forwarded-For`, *Use rightmost IP*.

## Traefik (v3, file provider)

```yaml
http:
  routers:
    getraenkeliste:
      rule: Host(`getraenke.example.com`)
      entryPoints: [websecure]
      service: getraenkeliste
      middlewares: [compress-except-sse]
      tls:
        certResolver: letsencrypt
    getraenkeliste-dashboard:           # longer rule => higher priority
      rule: Host(`getraenke.example.com`) && PathPrefix(`/_/`)
      entryPoints: [websecure]
      service: getraenkeliste
      middlewares: [admin-network-only]
      tls:
        certResolver: letsencrypt

  middlewares:
    compress-except-sse:
      compress:
        excludedContentTypes: [text/event-stream]
    admin-network-only:
      ipAllowList:
        sourceRange: ["192.168.1.0/24", "127.0.0.1/32"]

  services:
    getraenkeliste:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:8090"
```

Traefik flushes `text/event-stream` responses immediately; keep the entry point's
`transport.respondingTimeouts.writeTimeout` at its default `0` (no limit). `compress` alone
would compress the realtime stream too, hence `excludedContentTypes` (responses below 1 KiB
stay uncompressed anyway). It sets
`X-Forwarded-For` and `X-Real-Ip` (untrusted incoming values are replaced unless
`forwardedHeaders.trustedIPs` says otherwise). PocketBase trusted header: `X-Real-Ip`.
If Traefik itself runs in a Podman container, `127.0.0.1` is the Traefik container: attach
both containers to one Podman network and use `http://getraenkeliste:8090` (Quadlet unit:
`Network=` instead of `PublishPort=`). `http://host.containers.internal:8090` only reaches
a port published on all interfaces – not the Quadlet unit's default `127.0.0.1:8090`.

## PocketBase settings (dashboard `/_/` → Settings → Application)

- **IP proxy headers** → *Trusted IP proxy headers*: the header from above
  (`X-Real-IP` or `X-Forwarded-For`). With `X-Forwarded-For` choose **Use rightmost
  IP** – the leftmost entries can be forged by clients. The section shows the detected
  real IP (also returned by `GET /api/health` for superusers) to verify the setup.
  Only trust the header if port 8090 is not reachable except through the proxy – a
  client that reaches it directly could forge its IP (login throttle, *Superuser IPs*).
  `compose.yaml` and the Quadlet unit publish on `127.0.0.1` by default; `make run`
  publishes on all interfaces unless `BIND=127.0.0.1` is given.
- **Superuser IPs** → *Superuser IPs and subnets*: e.g. `192.168.1.0/24` – superuser
  logins/API calls from elsewhere are rejected (needs the trusted proxy header).
  CLI alternative (restart afterwards; Podman: `podman exec …`):
  `docker exec getraenkeliste pocketbase superuser ips 192.168.1.0/24 --dir=/pb_data --encryptionEnv=PB_ENCRYPTION_KEY`
  (`--encryptionEnv` is needed when `PB_ENCRYPTION_KEY` is set and harmless otherwise).
- **Rate limiting** is enabled by the app's migrations: rule `*:auth` = 10 login
  attempts (password/OTP/OAuth2) per 60 s per client IP; token refresh, realtime and
  normal API calls are not limited. It relies on the trusted proxy header – without it
  PocketBase only sees the proxy's IP and all phones share one login budget (and one
  allowance of the empty-search throttle, see requirement 4).
- Optional: **Application URL** = `https://getraenke.example.com`.

Check the proxy – the realtime stream must show `PB_CONNECT` at once and no
`Content-Encoding`; the app and the API must come compressed:

```sh
curl -N -H 'Accept-Encoding: gzip' -D - https://getraenke.example.com/api/realtime
curl -s -o /dev/null -D - -H 'Accept-Encoding: gzip' https://getraenke.example.com/ | grep -i '^content-encoding'
```

The three snippets were checked with nginx 1.29, Caddy 2.11 and Traefik 3.6 in front of
the app with the load-test dataset: compression of the app and the API (totals ≈ 4.5×,
booking list pages ≈ 13×, the persons list ≈ 7.5×, JavaScript ≈ 3×), `Cache-Control`
passed through unchanged, the realtime stream uncompressed with events after a few
milliseconds, and the trusted header yielding the client's address (forged
`X-Real-IP` / `X-Forwarded-For` values from the client are ignored).
