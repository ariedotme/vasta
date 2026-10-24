# Self-hosting

**English** · [Português](deploy.pt-BR.md) · [Español](deploy.es.md) · [简体中文](deploy.zh-CN.md) · [日本語](deploy.ja.md)

Vasta runs as one Docker image, `ghcr.io/ariedotme/vasta` (for `linux/amd64` and `linux/arm64`):
the API plus the built web app on port 5174, with the data directory mounted at `/data`
(`vasta.db`, and `media/` unless media live in an S3-compatible bucket). Every release publishes
`:<version>` (e.g. `:0.2.0`), `:<major>.<minor>` and `:latest`.

## Quick start

```sh
mkdir vasta && cd vasta
curl -O https://raw.githubusercontent.com/ariedotme/vasta/main/compose.example.yml
curl -o .env https://raw.githubusercontent.com/ariedotme/vasta/main/.env.example
mv compose.example.yml compose.yml
# edit .env: at least VASTA_TIMEZONE and VASTA_WEB_URL
docker compose up -d
docker compose logs vasta      # shows the setup code for the first account
```

Open the web app (by default `http://127.0.0.1:5174`) and create the first account with that
setup code. The first account owns the server's spaces. To give someone else an account, make an
invite link in Settings › Server accounts and send it to them ([accounts.md](accounts.md)).

The settings are environment variables, all described in [`.env.example`](../.env.example).

## HTTPS and a reverse proxy

Use HTTPS for anything beyond your own machine: the session cookie, the service worker (offline
use and installing the app on a phone) and the desktop app all expect it. Put Vasta behind a
reverse proxy and pass `X-Forwarded-Proto`, so the session cookie is marked `Secure`. With
[Caddy](https://caddyserver.com):

```caddy
vasta.example.org {
	reverse_proxy vasta:5174
}
```

Caddy sets `X-Forwarded-Proto` itself; behind another proxy that ends TLS before it (a Cloudflare
tunnel, for example), add `header_up X-Forwarded-Proto https`. Server-Sent Events (`/api/events`)
need no extra settings: the server pings every 25 s. The server compresses its JSON answers and the
web app's assets itself. The compose file publishes the port only on
127.0.0.1; when the proxy runs in Docker too, put both on a shared network instead.

On a phone, open the address and use "Add to Home Screen" (Safari) or "Install app" (Chrome): it
opens full screen and keeps working offline.

## Upgrading and backups

```sh
docker compose pull && docker compose up -d
```

Schema changes run when the new version opens the database, and there is no way back to an older
version afterwards except a backup. Before upgrading, and regularly:

```sh
docker exec vasta vasta backup /data/backups/vasta-$(date +%Y%m%d).db
```

`vasta backup` makes a consistent copy of the database while the server runs. It does not copy
media: back up `<data>/media` (or the bucket) as well. Media files never change once written
(their names are content hashes), so an older media backup only lacks newer files, and
`vasta media check` lists what objects point at and the store lacks.

## Media in an S3-compatible bucket

Uploads, captured files and link previews live in `<data>/media` unless the `VASTA_S3_*` settings
name a bucket: [Garage](https://garagehq.deuxfleurs.fr/) or MinIO next to Vasta, or Cloudflare
R2, Backblaze B2, AWS S3. The server streams them at `/media/:key` (with the login check, and
`Range` for audio and video seeking). Use a key limited to that bucket. Path-style addressing is
the default; `VASTA_S3_PATH_STYLE=0` puts the bucket in the host name (needed by AWS for new
buckets), and the region is `auto` for R2.

To move existing files into a bucket, set the `VASTA_S3_*` settings and run
`docker exec vasta vasta media push` until it copies nothing, then `vasta media check`.

## Other settings worth knowing

- **Telegram**: a bot can only be polled by one process, so give each server (and local
  development) its own bot ([capture.md](capture.md)).
- **Services on your network**: the server refuses to fetch links and calendars on private
  addresses, so accounts cannot reach your LAN through it. Allow the ones you need (a Nextcloud
  calendar, an ntfy server for reminders) with `VASTA_ALLOW_PRIVATE_FETCH`
  ([accounts.md](accounts.md#how-it-is-protected)).
- **Moving a database**: copy it with the server stopped, or with
  `sqlite3 vasta.db ".backup copy.db"`, and copy `media/` next to it.

## Building the image yourself

```sh
docker build -t vasta .
```

The `Dockerfile` builds the web app and installs the server's dependencies on the build machine,
so images for another architecture build without emulation. `compose.example.yml` can use
`build: .` instead of `image:`.
