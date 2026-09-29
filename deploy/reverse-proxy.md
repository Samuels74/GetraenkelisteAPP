# Reverse proxy

The container serves plain HTTP on port `8090` (published on the host by `make run`
or the Quadlet unit). TLS is terminated by your existing reverse proxy. Requirements:

1. **One origin** – forward everything (`/` SPA, `/api/`, `/_/` dashboard) to the app.
2. **Realtime** – `/api/realtime` is a Server-Sent-Events stream: no response
   buffering, read timeout well above 5 minutes (PocketBase closes idle streams after
   5 min, clients reconnect automatically).
3. **Client IP** – send `X-Real-IP`/`X-Forwarded-For` and tell PocketBase to trust it
   (see below), otherwise logs and rate limits only see the proxy's IP. The app
   throttles logins to 10 attempts per minute per client IP – **without the trusted
   proxy header all phones share one login budget.**
4. **Dashboard** – restrict `/_/` to your admin network and set *Superuser IPs*.
5. **HTTPS is required for the QR camera** on phones – use the proxy URL there.

Examples use `getraenke.example.com`, the app on `127.0.0.1:8090` and `192.168.1.0/24`
as admin network – adjust.

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

    location / {
        proxy_pass http://getraenkeliste;
    }

    # realtime (SSE)
    location /api/realtime {
        proxy_pass http://getraenkeliste;
        proxy_buffering off;
        proxy_cache off;
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

## Caddy

```caddyfile
getraenke.example.com {
	# PocketBase dashboard: admin network only
	@dashboardOutside {
		path /_/*
		not remote_ip 192.168.1.0/24 127.0.0.1/8
	}
	respond @dashboardOutside 403

	reverse_proxy 127.0.0.1:8090 {
		# stream responses immediately (SSE on /api/realtime)
		flush_interval -1
	}
}
```

Caddy obtains the certificate, sets `X-Forwarded-For`/`-Proto`/`-Host` itself (incoming
values from untrusted clients are replaced) and has no upstream read timeout by default.
PocketBase trusted header: `X-Forwarded-For`, *Use rightmost IP*.

## Traefik (v3, file provider)

```yaml
http:
  routers:
    getraenkeliste:
      rule: Host(`getraenke.example.com`)
      entryPoints: [websecure]
      service: getraenkeliste
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
`transport.respondingTimeouts.writeTimeout` at its default `0` (no limit). It sets
`X-Forwarded-For` and `X-Real-Ip` (untrusted incoming values are replaced unless
`forwardedHeaders.trustedIPs` says otherwise). PocketBase trusted header: `X-Real-Ip`.
If Traefik itself runs in a Podman container, `127.0.0.1` is the Traefik container –
use `http://host.containers.internal:8090` or attach both containers to one Podman
network and use `http://getraenkeliste:8090`.

## PocketBase settings (dashboard `/_/` → Settings → Application)

- **IP proxy headers** → *Trusted IP proxy headers*: the header from above
  (`X-Real-IP` or `X-Forwarded-For`). With `X-Forwarded-For` choose **Use rightmost
  IP** – the leftmost entries can be forged by clients. The section shows the detected
  real IP (also returned by `GET /api/health` for superusers) to verify the setup.
  Only trust the header if port 8090 is not reachable except through the proxy
  (e.g. `PublishPort=127.0.0.1:8090:8090` when the proxy runs on the same host).
- **Superuser IPs** → *Superuser IPs and subnets*: e.g. `192.168.1.0/24` – superuser
  logins/API calls from elsewhere are rejected (needs the trusted proxy header).
  CLI alternative (restart afterwards):
  `podman exec getraenkeliste pocketbase superuser ips 192.168.1.0/24 --dir=/pb_data`
- **Rate limiting** is enabled by the app's migrations: rule `*:auth` = 10 login
  attempts (password/OTP/OAuth2) per 60 s per client IP; token refresh, realtime and
  normal API calls are not limited. It relies on the trusted proxy header – without it
  PocketBase only sees the proxy's IP and all phones share one login budget.
- Optional: **Application URL** = `https://getraenke.example.com`.

Check the realtime path through the proxy – the `PB_CONNECT` event must appear at once:

```sh
curl -N https://getraenke.example.com/api/realtime
```
