# WebApp deploy

> Target host: **Tencent Cloud CVM, Jakarta**. Storage placement: [`docs/internal/web-data-placement-tencent.md`](../docs/internal/web-data-placement-tencent.md). Security requirements and the before-traffic acceptance list: [`docs/internal/web-security-spec.md`](../docs/internal/web-security-spec.md).

The full structure for running Nultron as a hosted web app on Kyo's server: image,
compose stack (the app, its proxy, and the portal stand-in with its database), reverse
proxy, env templates, and the scripts for build / deploy / backup / restore / logs.

**Phase 0 (owner decision, 2026-10-01): a pilot for 10 internal testers on one Tencent
Lighthouse box with this compose stack.** The way to run it is [Phase 0 pilot
(compose)](#phase-0-pilot-compose); the rest of this file is the reference it leans on.

This folder is **additive**. Nothing in `apps/`, `packages/`, the root `package.json`,
`pnpm-workspace.yaml` or `turbo.json` is touched, so the Electron desktop app (retired
2026-10-14; its code stays in the tree) and the mobile app keep building exactly as they did.

The decision behind it is [`docs/internal/web-pivot-2026-09-18.md`](../docs/internal/web-pivot-2026-09-18.md).
The step-by-step path from here to a safe public deployment is
[`docs/internal/web-migration-plan.md`](../docs/internal/web-migration-plan.md).

> **Not production-ready yet.** Read [Before-traffic acceptance](#before-traffic-acceptance)
> and [What is not done](#what-is-not-done-yet) before pointing a domain at this. There is no auth, no tenancy, and mutating `/api` calls are
> rejected behind a proxy today. Treat this as the deployment skeleton the migration
> plan fills in.

## Layout

```
webapp-deploy/
├─ README.md                  this file
├─ Dockerfile                 multi-stage image (build context is the REPO ROOT)
├─ .dockerignore              a byte copy of Dockerfile.dockerignore (see "Why three ignore files")
├─ Dockerfile.dockerignore    the name BuildKit actually reads for Dockerfile
├─ portal.Dockerfile          the portal stand-in's image (the app image cannot run it)
├─ portal.Dockerfile.dockerignore  an ALLOWLIST: the only files the portal image can see
├─ portal-entry.sh            builds the portal's two DSNs from its two passwords, then runs a command
├─ compose.yml                app + proxy + portal + portal-db + portal-prepare, read-only roots, caps dropped, limits
├─ compose.local.yml          LOCAL REHEARSAL ONLY: loopback ports, a throwaway CA, Mailpit
├─ pilot-local.mjs            drives that rehearsal: up, drive (headless sign-in), down
├─ Caddyfile                  TLS for two names, CSP + security headers, filtered logs, the billing block
├─ .env.example               the APP's env: every var the host reads, with one line each
├─ portal.env.example         the PORTAL's env: signing key, database passwords, sign-in mode (password by default), Tencent SES login (code mode only)
├─ DEPLOY-LOG.md              date | sha | env | who | notes
├─ k8s/                       the Kubernetes rehearsal (a second deploy path; its own README)
├─ sites/                     the DPS corporate sites on the same box (dpscloud, tokotoken), static, each off
│                             unless DPS_DOMAIN or TOKOTOKEN_DOMAIN is set (enable-sites.sh). Not Nultron code
└─ scripts/
   ├─ _common.sh              shared helpers (sourced, not run)
   ├─ build.sh                build the app and portal images, print their sizes
   ├─ deploy.sh               secrets from SSM, build, up -d, health, log the sha
   ├─ backup.sh               SQLite snapshot + encrypted tar of /data -> COS
   ├─ restore.sh              decrypt and restore an archive into the volume
   ├─ portal.sh               run an apps/portal script (seed, invite, ...) in the running portal
   ├─ components.sh           status / check / install the server's native components
   └─ logs.sh                 health + follow logs
```

### Why three ignore files

BuildKit looks for `<dockerfile-path>.dockerignore` before it falls back to
`<context>/.dockerignore`. The Dockerfiles live here but the build context is the repo
root, so the files Docker actually reads are `webapp-deploy/Dockerfile.dockerignore` (the app
image) and `webapp-deploy/portal.Dockerfile.dockerignore` (the portal image, an allowlist).
Without them the context is ~1.4 GB (`node_modules` plus `.git`).

`.dockerignore` is the third, and since 2026-10-01 a byte copy of `Dockerfile.dockerignore`
(`scripts/pilot-deploy.test.mjs` fails if they drift, security-register SR-94). Nothing reads it for the
documented builds; it is there so a build with `webapp-deploy/` as the context cannot re-open SR-49.
`Dockerfile.dockerignore` also excludes `webapp-deploy/k8s`, `webapp-deploy/*.env` and
`webapp-deploy/.pilot-local`, so a build from a checkout cannot pick up a throwaway CA's private key or
the pilot's second env file. The release path never builds from a checkout anyway: it archives a sha.

## What the image contains

- `node:22.23.4-bookworm-slim`. The root `package.json` says `"engines": { "node": ">=22" }` and
  `.nvmrc` is `22` (SH-001: the web server refuses an older Node at boot). 22 is in maintenance LTS. Debian, not Alpine, because
  `pnpm-lock.yaml` resolves `@firecrawl/anydoc` to the `-linux-x64-gnu` / `-linux-arm64-gnu`
  packages — musl would pick different ones and force a `better-sqlite3` rebuild.
  The tag names the patch release (22.23.4, which carries the 2026-10-21 Node security release), not just the
  major, so a rebuild cannot start from an older cached 22.x. Bump `NODE_VERSION` in both Dockerfiles, `PREFLIGHT_IMAGE`
  in `deploy.sh` and the mac pack image together after each Node security release.
- pnpm `9.15.9` via corepack, matching the root `packageManager` field.
- Two installs, in two build stages. The `build` stage runs
  `pnpm install --frozen-lockfile --filter "@agentforge/web..."` (the web app and its
  workspace dependencies only; `apps/desktop`, the retired Electron app (Electron, electron-builder, keytar), and
  `apps/mobile` are never installed) and then `pnpm --filter @agentforge/web build` →
  `vite build` → `apps/web/dist`, which `server.ts` serves statically when
  `NODE_ENV=production`. The `prod` stage runs the same install with `--prod`, copies in
  `apps/web/dist`, and is the tree the runtime stage copies. Nothing from the `build`
  stage's `node_modules` reaches the image.
- **Production dependencies only (SR-113, 2026-10-05).** `vite`, `tailwindcss`, `vitest`,
  `typescript`, `biome` and the rest of the dev toolchain are not in the image
  (`/app/node_modules` is about 265 packages and 298 MB, from about 452 and 586 MB).
  That is what takes `braces`, which arrives only through `tailwindcss`, out of
  `scripts/audit-deployed.mjs`. The price: server code may import only what a workspace
  `package.json` lists under `dependencies`. `tsx` moved there for that reason, `vite` is a
  dynamic import on the non-production branch of `apps/web/server.ts`, and the `prod` stage
  loads `@agentforge/host/http` at build time, so a server import of a dev-only package
  fails the build with `ERR_MODULE_NOT_FOUND` instead of the first start.
- **The whole workspace source ships.** Every `@agentforge/*` package exports TypeScript
  directly (`packages/host/package.json` → `./src/index.ts`), and `apps/web`'s `start`
  script is `NODE_ENV=production tsx server.ts`. Compiling that to a bundle is a
  migration-plan item, not something this folder changes (SR-49).
- Runs as the non-root `node` user. `/data` is owned by `node` and declared a volume.
- `HEALTHCHECK` hits `GET /healthz` on `127.0.0.1:$PORT` with `node -e fetch` (there is
  still no curl in the image), **and sends no headers**. Phase 8 changed both halves of
  that line; before it, the probe was `GET /api/v1/components` with
  `x-forwarded-proto: https` stamped on.
  `/healthz` is answered in the HTTP adapter before routing
  (`packages/host/src/http-adapter.ts:534-536`), so it never reaches `dispatch`, never
  opens the database, and is outside the session gate by construction rather than by an
  entry in an exemption list. Its whole body is `{"status":"ok"}` — a liveness route that
  named a version, a path or a component would be handing reconnaissance to the one
  caller on this box that never signs in.
  The header is gone because `/healthz` is the single carve-out from `rejectPlaintext`
  (`packages/host/src/http-adapter.ts:388-391`, reached through `transportRejection` at
  `:398-408`, and the carve-out passed as `isLiveness` at `:529`), which in server mode
  answers `403 https_required` to every *other* request that arrives without it, on every
  path, before routing. The probe runs inside the container against the app's own loopback
  port with no proxy in front of it, so it has no proxy header to forward and stamping one
  on would only prove the app accepts the header. Everything else still runs over the
  probe — the request-line filter, the method allowlist, the header cap and the per-IP
  bucket — and the port is loopback-only.
  If you are looking at an older image and the container never reports healthy while the
  log fills with 403s, it is running the pre-Phase-8 probe against a route that no longer
  gets the header: rebuild.

### Native modules

- **better-sqlite3** (`packages/db`): `python3`, `make` and `g++` are installed in the
  build stage. It normally lands a prebuilt binary; without the toolchain the node-gyp
  fallback fails and the whole install dies. Nothing extra is needed at runtime.
- **anydoc** (`@firecrawl/anydoc`, the component installer's one component): it is a real
  dependency of `packages/host`, so pnpm installs the Linux package at build time and the
  **bundled** loader wins. The component installer therefore has nothing to download —
  `GET /api/v1/components` reports it as present.
  **The build proves it** (Phase 7): a `RUN tsx scripts/components.ts check` step in the build
  stage loads every required component the way a request would and fails the image if one does
  not. Without it, a lost dependency would ship a container that boots, reports healthy, and
  reads every document with the reduced fallback extractor.
  Anything installed later goes to `AGENTFORGE_COMPONENTS_DIR` — `/opt/agentforge/components`,
  on the separate `nultron-components` volume, deliberately **not** under `/data`: in server
  mode the host refuses to load a native module from inside the tenant data volume, which is what
  lets `/data` be mounted `noexec` (security spec H3). `scripts/components.sh` is how an operator
  looks at this; no tenant can, since the install route answers `403 install_disabled`.
  Its `install` is a **repair**, not an upgrade path — it fetches only what does not load, so on a
  healthy image it does nothing, and a new version comes in a new image. A repair needs an app
  restart before the running process uses it.
  See [`docs/internal/web-phase7-component-installer.md`](../docs/internal/web-phase7-component-installer.md)
  and [`docs/internal/maps/component-installer.md`](../docs/internal/maps/component-installer.md).
- **ffmpeg / ffprobe are not in the image.** The Edit desk degrades without them. Adding
  them is a migration-plan decision, not a silent `apt-get`.

## The loopback bind, and why the proxy shares a network namespace

`apps/web/server.ts:114-115` binds whatever `resolveBindHost` returns:

```ts
const host = resolveBindHost(process.env);
server.listen(port, host, () => {
```

`resolveBindHost` (`apps/web/lib/bind-host.ts:17-27`) defaults to `127.0.0.1` and **throws**
on a non-loopback `BIND_HOST` unless `AGENTFORGE_SERVER` is on, so a webdev run can never
go LAN-wide by accident. A container that listens on `127.0.0.1` cannot be reached from
another container over a Docker bridge network.

**Historical note.** Until Phase 1 landed (PR #56) the bind address really was hardcoded
and there was no env for it, which is the reason this stack was built the way it is. The
namespace-sharing arrangement below is kept because it is what has been tested and because
loopback-only means nothing on the host but Caddy can reach the app port — not because
there is no alternative any more. The proxy joins the app container's network namespace:

```yaml
proxy:
  image: caddy:2.11-alpine
  network_mode: "service:app"
```

Both containers then share one loopback interface, so Caddy's
`reverse_proxy 127.0.0.1:3000` reaches the host process. A service that shares another
service's namespace cannot publish ports of its own, which is why `80`, `443` and
`443/udp` are published on the **app** service in `compose.yml`.

Binding `0.0.0.0` inside the container and putting the two services on an ordinary bridge
network is now possible — set `BIND_HOST=0.0.0.0` with `AGENTFORGE_SERVER=1` — but it is
not what this stack ships or what has been driven. Changing it is a deliberate deployment
change, not a tidy-up.

**The proxy must pass `Host` through unchanged.** With `AGENTFORGE_SERVER=1` the app no
longer wants a loopback `Host`: a mutating `/api` call is accepted only when its `Origin`
*and* its `Host` both match `AGENTFORGE_TRUSTED_ORIGINS`, so the public hostname the
browser sent has to arrive exactly as sent. That is Caddy's default, which is why the
`Caddyfile` carries no `header_up Host` line - the earlier `header_up Host 127.0.0.1`
would now turn every `POST` / `PATCH` / `DELETE` into `403 origin_forbidden`, because
loopback is not on the allowlist. So set `AGENTFORGE_TRUSTED_ORIGINS` to this site's
public origin with its scheme (`https://$NULTRON_DOMAIN`, comma-separated for more than
one name); an empty list in server mode accepts no write at all. `Origin` must never be
rewritten by the proxy - that is the CSRF hole the check exists to close.

## Phase 0 pilot (compose)

Owner decision, Rizky, 2026-10-01: Phase 0 is **10 internal testers on ONE Tencent Lighthouse box
(4 vCPU / 8 GB, Jakarta) with docker compose**. Sign-in e-mail, when the e-mailed code mode is chosen, goes through **Tencent SES**; since 2026-10-09 the bundle's default sign-in is a username and a password and needs no mail sender. The
billing webhook is **blocked at Caddy** until a payment provider is chosen. Exactly **one app and
one portal process**. This section is the way to run that; nothing in it is Kubernetes (see
[`k8s/README.md`](k8s/README.md) for that path).

### What runs

```
 internet --80/443/udp443--> [ app container ]  tsx server.ts on 127.0.0.1:3000
                               | shared network namespace
                             [ proxy: Caddy 2.11 ]  443 --> NULTRON_DOMAIN -> 127.0.0.1:3000   (the app)
                               |                          PORTAL_DOMAIN  -> portal:4000       (the portal)
                               |                          POST /api/v1/billing/webhook* -> 404 right here
        default network --------- [ portal ]  apps/portal, one process, NODE_ENV=production
                                      |  (also on) portal-db network: internal, no way out
                                  [ portal-db ] Postgres 16      [ portal-prepare ] one-shot, every `up`
```

- **One compose file, extended, not a second one.** `compose.yml` already was the stack, and the
  hosted app cannot sign anybody in without a portal, so the portal and its database belong in it.
  A separate `compose.pilot.yml` would have meant two files to keep in step with the same app and
  proxy, and a third generated one in the release bundle. The released bundle's compose file
  (`composeFile()` in `scripts/release-web.mjs`) carries the same five services; the test
  `scripts/pilot-deploy.test.mjs` compares the two service by service.
- **The portal has its own image**, `ghcr.io/kyoo032/nultron-portal:<tag>`, built from
  [`portal.Dockerfile`](portal.Dockerfile). The app image cannot run it: it is installed with
  `--filter "@agentforge/web..."`, so it carries the portal's source but not its `node_modules`
  (`ERR_MODULE_NOT_FOUND: nodemailer`, found by the Kubernetes rehearsal). `release-web.mjs` builds
  and pushes both from the same `git archive <sha>` and pins both in the released compose file.
  Its build context is an allowlist ([`portal.Dockerfile.dockerignore`](portal.Dockerfile.dockerignore)):
  the workspace manifests, `apps/portal`, the portal's SQL migrations and two small scripts.
- **Two env files, because the app must not hold the portal's secrets.** `.env` is the app's (and what
  compose interpolates). `portal.env` is loaded only by `portal`, `portal-prepare` and `portal-db`: the
  signing key, the two database passwords, the SMTP login. An app container that held the signing key
  could mint sign-in tokens, and one that held the SMTP password could send mail as Nultron. The proxy
  gets no env file at all, only `NULTRON_DOMAIN` and `PORTAL_DOMAIN` (SR-73). `portal-db` shares
  `portal.env`, so it can read its password; it is on an internal network with no route out.
- **App to portal over https (SR-26).** In production the app refuses an `http://` portal URL. The app
  container resolves `PORTAL_DOMAIN` to its **own loopback** (`extra_hosts`), where the proxy, which shares
  its network namespace, listens on 443 with the portal's real certificate. The browser reaches the same
  Caddy from outside, so the two paths meet at one place. It depends on no public DNS record, no NAT
  reflection and no docker-proxy. `AGENTFORGE_PORTAL_URL` is the bare origin `https://<PORTAL_DOMAIN>`: this
  portal serves `/auth/token` at its root, so the `/api` suffix an earlier template carried is wrong.
- **One process each (SR-29, SR-66).** The portal's rate-limit windows, the app's limiters and the portal
  refresh lock live in memory. Do not add replicas.
- **Sizing.** The limits are ceilings: app 6 GB, database 1 GB, portal 768 MB, proxy 512 MB, which add up to
  more than the 8 GB box. Idle, the four long-running containers used about 395 MiB together on the local
  rehearsal (app 280, portal 58, database 40, proxy 16; `docker stats`, 2026-10-01), so 8 GB is comfortable for
  ten testers. If a model-heavy job ever pushes the app to its ceiling, the kernel's OOM killer, not Docker,
  chooses what dies: lower the app's `mem_limit` before adding testers rather than after. Not measured under
  load.

### The box

1. **Image and Docker.** A current Ubuntu LTS image on the Lighthouse instance, Docker Engine and the
   compose plugin from Docker's own apt repository. **Compose 2.24 or newer**: the stack uses `env_file`
   with `required:` and `depends_on` conditions. Do not enable Docker's IPv6 (`"ipv6": true` in
   `/etc/docker/daemon.json`). A deploy user in the `docker` group, SSH key-only, root login off,
   `unattended-upgrades` on (security-spec H1, I4).
2. **Firewall (Lighthouse console).** Inbound **TCP 80, TCP 443, UDP 443** from IPv4 anywhere; **TCP 22
   from your own address only**; nothing else, and no rule for `::/0`. Port 80 is the ACME challenge and
   the redirect, UDP 443 is HTTP/3. Outbound must reach TCP 443 (the gateway, the registry, Let's Encrypt)
   and **TCP 465 to `sg-smtp.qcloudmail.com`** (SES); check it from the box with
   `nc -vz sg-smtp.qcloudmail.com 465` rather than assuming the console's defaults.
3. **IPv4 only (SR-79).** Every per-IP limit, on the app and on the portal, keys on the full IPv6
   address, and one IPv6 client can mint a fresh bucket per request. So the pilot is reachable over IPv4
   only, and `compose.yml` publishes `0.0.0.0:80`, `0.0.0.0:443` and `0.0.0.0:443/udp`, never a bare
   `443:443` (which makes Docker bind `[::]:443` too). Publish **no AAAA record** for either name. Prove it
   on the box and from outside, and write the result in `DEPLOY-LOG.md`:

   ```sh
   ip -6 addr show scope global                  # expect nothing: the instance has no public IPv6
   docker compose ps                             # PORTS shows 0.0.0.0:443->443/tcp and NO [::]:443
   sudo ss -ltnu | grep -E ':(80|443) '          # only 0.0.0.0:80 and 0.0.0.0:443, no [::]:...
   dig +short AAAA <NULTRON_DOMAIN> <PORTAL_DOMAIN>   # expect nothing
   curl -6 -m 8 -sI https://<NULTRON_DOMAIN>     # from another machine: expect it to fail
   ```

   If `ip -6 addr` does show a global address, either turn IPv6 off for the instance or fix SR-79 in
   `rateLimitKey` and `clientIp` (key an IPv6 address by its /64) before taking testers.
4. **DNS.** Two **A** records to the box's public IPv4: `NULTRON_DOMAIN` (the app) and `PORTAL_DOMAIN` (the
   portal), for example `pilot.example.com` and `pilot-login.example.com`. Caddy obtains and renews a
   certificate for each.
5. **Secrets.** Generate each once; never commit them; keep a copy somewhere that is not this server.

   ```sh
   cd webapp-deploy
   cp .env.example .env && cp portal.env.example portal.env && chmod 600 .env portal.env
   openssl rand -hex 32     # AGENTFORGE_SECRETS_KEY       (the wrap key: a new one cannot read old data)
   openssl rand -hex 32     # AGENTFORGE_BILLING_WEBHOOK_SECRET (required to boot; give it to nobody)
   openssl rand -hex 32     # PORTAL_SIGNING_KEY           (set once: rotating it signs everyone out)
   openssl rand -hex 24     # PORTAL_POSTGRES_PASSWORD
   openssl rand -hex 24     # PORTAL_APP_DB_PASSWORD       (a different value)
   ```

   Hex keeps the passwords URL-safe, which matters because `portal-entry.sh` places them in a DSN and
   refuses anything else. Set `NULTRON_DOMAIN`, `PORTAL_DOMAIN`, `AGENTFORGE_TRUSTED_ORIGINS=https://<NULTRON_DOMAIN>`
   and `AGENTFORGE_PORTAL_URL=https://<PORTAL_DOMAIN>`; leave `AGENTFORGE_PORTAL_CLIENT_SECRET` empty for now.
   On the CVM-style secret manager path, `USE_SSM=1` still applies to the wrap key and `BACKUP_KEY`
   (`deploy.sh`); the portal's secrets have no SSM wiring yet, so they live in `portal.env` on the box.

### Sign-in mail: Tencent SES

Only for `PORTAL_SIGNIN_MODE=code`. The bundle's default since 2026-10-09 is `password`, which sends no mail and does
not need any of this (see "Signing in with a username and a password" below).

SES offers SMTP, and the portal needs no code change for it. What the official documentation says, and
what was checked:

| Fact | Source |
|---|---|
| SMTP service addresses: `smtp.qcloudmail.com` (Hong Kong, China site), `gz-smtp.qcloudmail.com` (Guangzhou), **`sg-smtp.qcloudmail.com` (International site)** | [SMTP Service Address](https://www.tencentcloud.com/document/product/1084/44457) |
| Port **465, SSL encryption**; "port 25 is currently disabled". No 587 and no STARTTLS in the service-address page | same page |
| Every sample opens TLS first: Go `tls.Dial` ("for port 465 a TLS channel must be established first"), Python `SMTP_SSL`, PHP `ENCRYPTION_SMTPS`; PHP adds "use 587 if you set `ENCRYPTION_STARTTLS`" | [Go](https://www.tencentcloud.com/document/product/1084/44455), [PHP](https://www.tencentcloud.com/document/product/1084/49570), [attachments](https://www.tencentcloud.com/document/product/1084/44454) |
| The SMTP user is the **sender address**; the password is a dedicated SMTP password set in the console ("not your Tencent Cloud login password and not the API key"); the sender domain must be verified first | [Go sample](https://www.tencentcloud.com/document/product/1084/44455), [SMTP guide](https://www.tencentcloud.com/document/product/1084/44458) |
| One sender may send up to **10 e-mails an hour to the same recipient**; from 2026-03-02 new accounts under individual real-name verification can no longer send over SMTP | [SMTP guide](https://www.tencentcloud.com/document/product/1084/44458) |
| Regions: the International API supports `ap-singapore` only (endpoint `ses.intl.tencentcloudapi.com`) and "`Region` only indicates the location of the server and does not affect the regions where emails are sent to". There is **no Jakarta SES region**; a Jakarta box sends through the Singapore/International endpoint | [SendEmail](https://www.tencentcloud.com/document/product/1084/39408), [FAQ](https://www.tencentcloud.com/document/product/1084/39656) |

Observed on 2026-10-01, from a developer machine (not from the Lighthouse box): a TLS handshake to
`sg-smtp.qcloudmail.com:465` succeeds immediately with TLS 1.3, a `*.qcloudmail.com` DigiCert
certificate that verifies against a normal trust store, and the greeting `220 sg-smtp.qcloudmail.com ESMTP
ready`. Port 587 accepted the TCP connection and sent no greeting in 8 seconds; port 25 did not connect.
Nothing was sent and nobody was authenticated.

**Portal support: nothing to change.** `apps/portal/src/config.ts` (`readSmtp`, `PORTAL_SMTP_SECURE`)
has exactly two honest modes: implicit TLS from the first byte (`PORTAL_SMTP_SECURE=1`, port 465) and
STARTTLS that must succeed (anything off loopback with it off). So SES is
`PORTAL_SMTP_HOST=sg-smtp.qcloudmail.com`, `PORTAL_SMTP_PORT=465`, `PORTAL_SMTP_SECURE=1`; the SR-39
refusals (no cleartext, no loopback sandbox in production) are satisfied. That path was exercised
against a Mailpit that speaks implicit TLS in the compose rehearsal below.

In the SES console, before the first code can be sent: verify the **sender domain** (add the SPF, DKIM and
DMARC records it shows), create a **sender address** on it, and **set an SMTP password** for that address.
Put the address in `PORTAL_SMTP_USER` and `PORTAL_SMTP_FROM`, and the password in `PORTAL_SMTP_PASS`. Two
limits to plan around: the 10-an-hour-per-recipient ceiling is looser than the portal's own three
sends per fifteen minutes per address, so SES will not be what stops a tester who keeps asking for codes; and
SMTP being closed to new individually-verified accounts means the Tencent account that owns the sender
must be an enterprise-verified one. Unverified: whether SES requires the `From` address to equal the SMTP
user exactly (the docs only say the SMTP user is the sender address), and whether mail to Indonesian
providers lands in the inbox rather than spam. Send a test code to each tester's provider before the pilot.

### First bring-up on the box

```sh
docker login ghcr.io                    # a token that can read packages; both images are private
cd webapp-deploy                        # (or the released bundle's folder: compose.yml is the same shape)
docker compose pull                     # the released bundle; on a source checkout: sh scripts/build.sh
docker compose up -d portal             # starts portal-db, runs portal-prepare, then the portal

# Seed the first tenant, its org, and the first user, and register the app's OAuth client.
# The client secret is printed ONCE: copy it into .env as AGENTFORGE_PORTAL_CLIENT_SECRET.
sh scripts/portal.sh seed --email you@example.com --tenant nultron --org "Nultron pilot" \
  --seat-cap 10 --redirect https://<NULTRON_DOMAIN>/auth/callback

docker compose up -d                    # now the app and the proxy
docker compose ps                       # app and portal "healthy"; portal-prepare "exited (0)"

# portal.env says PORTAL_SIGNIN_MODE=password (the default): give the first owner a password BEFORE anyone
# signs in. Same address as the seed; the generated initial password is printed ONCE.
sh scripts/portal.sh account create --username <name> --email you@example.com --role owner
```

(In the released bundle there is no `scripts/` folder; the seed is
`docker compose exec -T portal sh /app/webapp-deploy/portal-entry.sh node dist/scripts/seed.mjs ...`,
which is what `portal.sh` runs.) `sh scripts/portal.sh <name> ...` runs `apps/portal/scripts/<name>.ts` (compiled as `dist/scripts/<name>.mjs` inside the portal image)
inside the running portal with the same two database DSNs the portal itself uses, so no password is typed
on the host. In `code` mode testers are added with the portal's invite script when it lands (`sh scripts/portal.sh invite
...`, see `apps/portal/README.md`); until then each tester is another `seed --email` for the same tenant, up
to the seat cap. `portal.sh otp` is refused on purpose: manual one-time codes need
`PORTAL_ALLOW_MANUAL_OTP=1`, which the production portal will not boot with (SR-10), and the owner decided
mail goes through SES.

**Signing in with a username and a password (the default since 2026-10-09; owner decisions 2026-10-07 and
2026-10-09 for Nultron Enterprise).**
`portal.env.example` carries `PORTAL_SIGNIN_MODE=password` uncommented, so a portal started from it signs people in
this way. To use the e-mailed one-time code instead, set it to `code`, fill in every `PORTAL_SMTP_*` value (see
"Sign-in mail: Tencent SES" above) and recreate the portal; deleting the line also gives `code`, because that is
the portal's own default when the variable is absent. In `password` mode no e-mail is ever sent, the `PORTAL_SMTP_*` settings are not needed to boot, the e-mail, invite and
code routes answer 404, and nobody signs themselves up: an operator makes each person with
`sh scripts/portal.sh account create --username <name> --email <address> --role owner|admin|member`, which
prints a generated initial password **once** (give it to the person; they must choose their own before the
portal lets them in). `account list` (which also shows how many times each account was locked in the last 24 hours),
`reset-password`, `disable`, `enable` and `set-role` do the rest; `disable`, `reset-password` and a `create` that
gives a password to somebody who already exists end every session the person holds, and `create` and `enable`
refuse when the org has no seat left. For the owner `seed` made, who has no password yet, `account create --email <that address>` gives
them one and keeps their role. `portal.sh invite` and `otp` refuse in this mode. Five wrong passwords lock an
account for 15 minutes, and an address that has not itself failed against that person can still take three more
attempts under the lock (eight a window at most). A second factor is being designed and is **not built**, and there is no self-service
reset: a forgotten password is `reset-password`. The app needs no setting for any of this; it asks the portal.
Spec and residual risks: `docs/internal/portal/device-code-login.md` ("Password sign-in") and SR-165.

Check it from outside, not from the box:

```sh
curl -sI https://<NULTRON_DOMAIN>/healthz | head -1            # 200
curl -sI https://<NULTRON_DOMAIN> | grep -iE 'strict-transport|content-security|x-content-type'
curl -si -X POST https://<NULTRON_DOMAIN>/api/v1/billing/webhook | head -1   # 404, from Caddy
```

then open `https://<NULTRON_DOMAIN>`, press sign in, enter the first owner's username and initial password (in
`code` mode: receive the code on a real inbox instead), choose a new password, and land on the desk.

### Things that are decided or owed here

- **The billing webhook is blocked at the edge (SR-03).** `@billing_webhook path /api/v1/billing/webhook*`
  answers 404 in the `Caddyfile` before the request reaches the app, in the app's site only, case-insensitively
  and with `%XX` decoded. `AGENTFORGE_BILLING_WEBHOOK_SECRET` must still be set (the host refuses to boot in
  production without it): make it a random value, tell nobody, and put an owner and a rotation date on it. When a
  provider is chosen, the rule comes out and the header secret is replaced by a signature check.
- **Rotating `PORTAL_SIGNING_KEY` signs everyone out (SR-24).** The portal publishes only the key held by its
  own process, so the old public key leaves the JWKS the moment the container restarts. Treat the key as
  set-once and tell the testers before changing it.
- **The proxy's logs hold no sign-in code or state (SR-72).** A filter list shared by Caddy's access log and its
  default (error) logger deletes `code` and `state` from the request URI, the `Referer` and the portal's
  redirect `Location`. It needs Caddy 2.8 or later, which is why the image is `caddy:2.11-alpine` and not a
  floating `2-alpine`. Check it again after any Caddyfile edit: `node webapp-deploy/pilot-local.mjs drive`
  does so against real Caddy.
- **Never restart or recreate `app` on its own.** `proxy` shares `app`'s network namespace, so after
  `docker compose restart app`, `up -d app` or `up -d --force-recreate app` Caddy is attached to a namespace
  that no longer exists: the site is down (the edge answers nothing) while the app reports healthy. Driven on
  2026-10-01, all three. Use `docker compose restart app proxy`, or a full `docker compose up -d` with no
  service names, which recreates the proxy when the app was recreated. The same holds for
  `scripts/components.sh install`'s "restart the app" step.
- **A release builds two images from one sha.** `node scripts/release-web.mjs --tag ent-YYYY.MM.DD --sha <sha>
  --dry-run` first. The sha has to carry `portal.Dockerfile`, its ignore file, `portal-entry.sh` and
  `k8s/base/scripts/prepare-db.mjs`, and the script refuses one that does not, before it builds anything: commit
  those files before cutting the release. The released `compose.yml` pins both images to the tag.
- **UDP 443 (HTTP/3) is published**; if the Lighthouse firewall blocks it, browsers fall back to HTTP/2 on
  their own. HTTP/3 itself was not driven.

### Backups and the restore drill

Two things hold state: the app's SQLite and files in the `nultron-data` volume, and the portal's Postgres in
`portal-pgdata`. `scripts/backup.sh` takes both in one run, each encrypted with `BACKUP_KEY` (AES-256-CBC,
PBKDF2) before it leaves the box, and uploads both to the COS backup bucket:

- `nultron-data-<stamp>.tar.gz.enc`: a consistent SQLite snapshot plus `/data`, as before.
- `nultron-portal-<stamp>.dump.enc`: `pg_dump -Fc` of `tokotoken_portal`, taken as the schema owner over the
  container's local socket. Skipped when there is no `portal-db` container (a managed Postgres backs itself up);
  `BACKUP_PORTAL=0` skips it. Every run decrypts and lists what it wrote.

Hourly, as the deploy user (`crontab -e`); the passphrase is fetched with the instance role at each run, as in
[Hourly cron](#hourly-cron):

```cron
17 * * * * BACKUP_KEY="$(tccli ssm get-secret-value ...)" /bin/sh /srv/nultron/webapp-deploy/scripts/backup.sh >> /var/log/nultron-backup.log 2>&1
```

A missed or failed run raises an alert only when `BACKUP_HEARTBEAT_URL` is set: see [Backup alert](#backup-alert).

**Restore drill, monthly (and once before the first tester).** On a scratch box, never the pilot box:
`restore.sh <data archive> --yes` as before, then `restore-portal.sh <portal dump> --scratch`, which restores the
dump into a throwaway database beside the live one, prints the row count of every table in both, refuses a dump
with no tenant row, and drops the copy. The destructive form, `restore-portal.sh <dump> --yes`, stops the
portal, drops and recreates `tokotoken_portal`, restores as the schema owner (owners and the grants row-level
security rests on come back as they were, SR-56) and starts the portal through its prepare step. Record each
drill in [`DEPLOY-LOG.md`](DEPLOY-LOG.md): date, archive names, minutes to green, anything that went wrong. The
cron job, the COS upload and a drill on a second machine have **not** been driven (see below).

### Rehearsal on a developer machine

```sh
node webapp-deploy/pilot-local.mjs up       # a throwaway CA, generated env files, two local images, the stack
node webapp-deploy/pilot-local.mjs drive    # headless Chromium: sign in with the e-mailed code, restart the app, search the logs
node webapp-deploy/pilot-local.mjs down --purge
```

[`compose.local.yml`](compose.local.yml) is layered over `compose.yml` and adds only what a laptop needs:
loopback-only ports (the 0.0.0.0 binds are replaced, not appended to), a throwaway CA, Mailpit speaking implicit
TLS like SES, and local images built from a `git ls-files -co --exclude-standard` snapshot (never pushed, never
from your checkout directly). It uses `https://nultron.localhost` and `https://portal.nultron.localhost` on
127.0.0.1:80 and :443, so those two ports must be free. The scripts in `scripts/` can be pointed at that project
with `DC_ARGS="-p nultron-pilot-local -f compose.local.yml --env-file .pilot-local/.env"`.

### What was driven, and what was not

Driven on 2026-10-01 on a Windows 11 machine with Docker Desktop (Compose 2.40), through the rehearsal above:
the stack comes up from a cold start (two images built from a working-tree snapshot, the portal first, the seed,
then everything); every container runs as its hardening says (read-only root, no capabilities, no new
privileges, limits); the app holds none of the portal's secrets and the proxy only the two names; Postgres's
process environment holds none of the portal's other secrets; a signed-out browser reaches the sign-in screen,
signs in with a code e-mailed over **implicit TLS** to Mailpit (the SES-shaped path), and lands signed in with no
`code` or `state` left in the address bar; `docker compose restart app proxy` and the same browser is still
signed in; the billing webhook answers 404 from Caddy for its spellings and never reaches the app; with the
portal stopped, a sign-in URL gets a 503 and Caddy's error line is written and holds no code or state; the
backup, the scratch restore drill and the destructive restore of the portal database; and the full-tree build
of the portal image holds only what the allowlist names.

**Not driven:** the Lighthouse box itself; ACME certificates on public names; DNS, the firewall and the IPv6
checks above on a real instance; a real SES send or the SES console steps; the `release-web.mjs` run (only its
dry run and unit tests, and a rendered bundle validated with `docker compose config` and `caddy validate`:
nothing was built through it, pushed or logged in to ghcr); the cron job and the COS upload; a restore on a
second machine; the portal's invite script (another change is adding it); HTTP/3; any load.

## Build

```sh
# from the repo root
docker build -f webapp-deploy/Dockerfile -t nultron-web:local .

# or
sh webapp-deploy/scripts/build.sh
```

## Run

```sh
cd webapp-deploy
cp .env.example .env && cp portal.env.example portal.env
# edit both. .env: NULTRON_DOMAIN, PORTAL_DOMAIN, AGENTFORGE_SECRETS_KEY, the portal client
# secret, ... portal.env: the signing key, the two database passwords, the SES login.
openssl rand -hex 32          # -> AGENTFORGE_SECRETS_KEY, generate once, keep forever

docker compose -f compose.yml up -d portal    # the portal first: the app needs the client secret it prints
# seed (see Phase 0 pilot, step 5), put the secret in .env, then:
docker compose -f compose.yml up -d
```

The first bring-up is two steps because the app refuses to boot without the portal's client
secret, and the portal only prints it once, after it exists. [Phase 0 pilot
(compose)](#phase-0-pilot-compose) has the whole sequence.

On the CVM, do not put `AGENTFORGE_SECRETS_KEY` in `.env` at all. Set `USE_SSM=1` and
let [`scripts/deploy.sh`](scripts/deploy.sh) fetch it from Secrets Manager with the
instance role (spec S2); it is exported for that one command and never written to
disk. The `.env` file keeps the non-secret settings.

Caddy obtains and renews TLS automatically for `$NULTRON_DOMAIN` and `$PORTAL_DOMAIN`,
provided ports 80 and 443 reach the server from the internet and a DNS **A** record for each
already points at it. Publish no AAAA record (SR-79, see the pilot section).

**Never start this on `:3000` on a development machine.** `:3000` is the isolated webdev
instance; the container publishes only 80/443 on the host, and `PORT` is the port
*inside* the container.

## Update

```sh
sh webapp-deploy/scripts/deploy.sh
```

Pulls (`git pull --ff-only`), runs the [deploy gate](#deploy-gate), rebuilds, `up -d`, and waits
for the healthchecks. A failed check rolls the stack back to the images from before the deploy.
On success it prints a ready-made row for `DEPLOY-LOG.md`. Append it there **and** to the deploy
log in the decision record. Use `--no-pull` to redeploy the checkout as it stands.

### Back up first when the deploy carries a migration

`ensureSchema` runs pending migrations when the app opens the database, so `up -d` is what
applies them. The runner is **forward-only**: it has no `down`, and SQLite before 3.35
cannot drop a column at all. Recovering from a bad migration means restoring the volume.

So on a deploy that carries a new `packages/db/drizzle/*.sql`, take a backup first and
check it landed:

```sh
export BACKUP_KEY=...                       # from Secrets Manager
sh webapp-deploy/scripts/backup.sh          # see "Back up" below
sh webapp-deploy/scripts/deploy.sh
```

`deploy.sh` does **not** do this for you. It is a deliberate gap: `backup.sh` needs a
running app container and a non-empty `BACKUP_KEY`, so calling it unconditionally would
fail the very first deploy to a fresh server. Whether to automate it behind a flag is
still open.

`0015_tenants` (Phase 3 tenancy) is the first migration this applies to: it adds the
`tenants` table and `organizations.tenant_id`, and is additive but one-way.

## Deploy gate

Every `deploy.sh` run goes through the four steps below. Nothing is called deployed until the last
one passes, and a failure after the swap puts the previous images back.

1. **Preflight, before anything is switched.** `scripts/deploy-preflight.mjs` reads `.env`,
   `portal.env` and `compose.yml`, and checks them offline:
   - every name the release writes into `.env.example` and `portal.env.example` is set. The lists are
     `REQUIRED_ENV` and `REQUIRED_PORTAL_ENV` in `scripts/release-web.mjs`, which the preflight imports.
     The portal's mail settings are needed only in `code` sign-in mode (`apps/portal/src/config.ts`);
   - `AGENTFORGE_PORTAL_URL` and every `AGENTFORGE_TRUSTED_ORIGINS` entry are https origins with no path;
   - the public names agree: `PORTAL_DOMAIN` is the host of `AGENTFORGE_PORTAL_URL`, and `NULTRON_DOMAIN`
     is the host of one trusted origin (`compose.yml` `extra_hosts`, `Caddyfile`);
   - no image is `latest` or untagged, and the release images carry an `ent-YYYY.MM.DD` tag;
   - `docker compose config -q` parses the file, when docker is on the host.

   Each problem is one sentence that names the variable. The preflight never prints a value. It runs
   with the host's node, or in a `node:22.23.4-bookworm-slim` container with no network when the host has
   none (`PREFLIGHT_IMAGE` changes that image). It does **not** judge the secret values. The app's own
   boot guard does (`packages/host/src/hosted-env.ts`), and a value it refuses makes the new container
   fail its health check, which rolls back.
2. **The previous images are kept.** The running app and portal images are tagged `nultron-web:previous`
   and `nultron-portal:previous` before the build, because the build overwrites `:local`. They stay
   until the next deploy.
3. **Health, after `up -d`.** The app's own `HEALTHCHECK` polls `GET /healthz` on its loopback port
   (`Dockerfile`; the route is `packages/host/src/handlers/health.ts`, answered before routing). A
   container that exits, keeps restarting or reports unhealthy fails at once, not at the timeout. Then
   the portal's healthcheck. Then `GET https://$NULTRON_DOMAIN/healthz` through Caddy, with the name
   pointed at loopback, so the probe needs no DNS. `DEPLOY_PUBLIC_PROBE_TRIES` sets its tries (12 by
   default, 5 seconds apart). Without curl on the host this probe is skipped with a warning.
4. **Rollback.** A failure in step 3 retags `:previous` as `:local` and runs
   `docker compose up -d --no-build --force-recreate app proxy portal`. Nothing is built again, and the
   app is waited on again. The proxy is recreated with the app and never on its own, because it shares
   the app's network namespace (`compose.yml`). The script exits 1 in every case, so a run that rolled
   back never reads as a success.

**What rollback does not do.** It restores images, not data. A migration that already ran stays
applied, because the schema runner is forward-only (see "Back up first when the deploy carries a
migration"). A first deploy has no previous image, so a failure there is reported and left for the
operator to fix.

**Where a change goes first.** This gate protects one stack, and that stack runs one app container, so
it has no canary of its own. Two other places take a change before the hosted main instance:

- **The tester staging instance** runs each update before main does. Where that instance runs is
  Rizky's open decision, and this folder does not name a host for it.
- **The preview desks** (`app.nultron-ai.xyz`) are a different stack. They follow "Update the app image
  only: the safe route" in `nultron-files/deploy/tencent/README.md`, which is outside this repo and
  gitignored. That route recreates a tester desk first, then the rest one at a time, and never the proxy.

**Every run on a server needs Rizky's go in the chat for that deploy.** A go for an earlier deploy does
not count, and the gate does not replace that go.

### Preview desks: mount the form before changing Caddy

This is for the separate single-desk preview, not this Enterprise stack. The live preview mounts
`nultron-files/deploy/tencent/edge/app/preview-server.ts` from outside this repo. Updating the app
image alone does not install the form. Keep that entrypoint and its existing startup refusals.

1. In the external preview entrypoint, import `PreviewGate` from the image's
   `apps/web/server/preview-gate.ts`. Construct it with `PreviewGate.requireProduction(process.env)`
   during boot, **before the host/database imports load dotenv** (move those imports behind this
   check or use a bootstrap module). Pass `NODE_ENV=production` and the per-desk
   `PREVIEW_BASIC_USER` and `PREVIEW_BASIC_PASSWORD` in the real process environment from secrets;
   leave `AGENTFORGE_SERVER` unset. Mount `app.use(previewGate.middleware())` ahead of body parsers,
   `handleNodeRequest`, static files and the SPA fallback. Do not catch a boot refusal and continue.
2. Use the existing safe-update runbook to recreate a tester desk first, with Caddy Basic Auth
   still on. Keep each listener on loopback and verify Caddy connects to `127.0.0.1` in the shared
   network namespace. Caddy must set trusted `X-Forwarded-Proto` and append the real client address
   as the last `X-Forwarded-For` hop. Use `GET /healthz` for probes, not a desk API.
3. From the shared network namespace, check the canary upstream directly, without any cookie
   or Authorization header and without following redirects. Repeat for each desk before cutover:

   | Request | Required upstream response |
   | --- | --- |
   | `GET /` | `302` to `/login`, no `WWW-Authenticate` |
   | `GET /api/v1/components` | `401`, not an app response |
   | `POST /chat` | `401` |
   | `GET /healthz` | `200` |

4. **Do not remove Basic Auth if desk selection still depends on the Basic Auth username.** The
   form does not select a desk. Verify that an isolated TLS canary with the proposed routing
   reaches the intended desk for `/login`, the app and the API, and that a session from one desk
   does not open another. For `/login` and `/logout`, preserve the public `Host`, `Origin` and
   `Sec-Fetch-Site` so the gate can validate the form. Scope this exception to those two paths;
   keep the existing Origin checks and loopback header handling for desk writes.
5. Only after those checks pass and the proxy change is approved, remove Basic Auth on the
   approved preview route and repeat the anonymous checks through HTTPS. Sign in and out on the
   intended desk. If any check fails, restore Basic Auth before rolling back any app change; if
   it cannot be restored immediately, take the affected route out of service.

## Back up

```sh
export BACKUP_KEY=...                               # from Secrets Manager, never .env
sh webapp-deploy/scripts/backup.sh [output-dir]     # default webapp-deploy/backups
```

No downtime. In order it takes a consistent SQLite snapshot into `/data/.backup-staging/`,
tars `/data` **minus `components/`, `logs/` and `.master-key`**, encrypts the stream, and
uploads the result to the COS backup bucket.

- **Snapshot.** The image has no `sqlite3` binary, so the snapshot is `VACUUM INTO`
  through `better-sqlite3` - one committed transaction, compacted, with no `-wal`/`-shm`
  of its own. `backup.sh` checks for `sqlite3` first and uses `.backup` if a future image
  ever adds it; both do the same job.
- **Encryption (spec S6).** `openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_KEY`,
  on this host, before the bytes leave it. A leaked bucket is then not a leaked database.
  The script refuses to run with an empty `BACKUP_KEY` rather than writing plaintext.
- **Verification.** Every run decrypts and lists the archive it just wrote. Set
  `BACKUP_VERIFY=0` to skip it on a very large volume.
- **Upload.** `coscli cp` if `coscli` is installed, else `tccli cos put-object`, else the
  file stays in `webapp-deploy/backups/` and the script prints a warning. Local copies
  older than `BACKUP_RETAIN_DAYS` (7) are pruned.

**The key is not in the backup.** `AGENTFORGE_SECRETS_KEY` lives only in Secrets Manager.
Lose it and `settings.enc` is unreadable no matter how good the backup is. `BACKUP_KEY` is
a second, separate secret - losing that one makes the tarballs unreadable instead.

### Hourly cron

RPO is one hour (placement doc section 5). Install on the CVM as the deploy user, with
`crontab -e`:

```cron
# m h  dom mon dow  command
17 * * * * BACKUP_KEY="$(tccli ssm get-secret-value --region ap-jakarta --SecretName nultron/prod/backup-key --VersionStage SSMCurrent | python3 -c 'import json,sys;print(json.load(sys.stdin)["SecretString"],end="")')" /bin/sh /srv/nultron/webapp-deploy/scripts/backup.sh >> /var/log/nultron-backup.log 2>&1
```

The passphrase is fetched with the instance role at each run and never lands in the
crontab or on disk. Spec L3 wants an alert when this job misses; [Backup alert](#backup-alert)
below sets it up.

### Backup alert

A check on the same box cannot report that the box stopped, and a cron job that never fires writes
nothing to its log. So the alert runs the other way round. `backup.sh` pings an external monitor, and
the monitor raises the alarm when the pings stop.

Set `BACKUP_HEARTBEAT_URL` to the ping URL of a check at a monitor you choose (healthchecks.io, or a
self-hosted instance of it). `backup.sh` reads it from the process environment only, never from `.env`.
`.env` is loaded into the `app` container, so a URL kept there would let anyone running code in the app
send fake success pings and hide a dead backup. Set it on the cron line next to `BACKUP_KEY`, fetched
from Secrets Manager the same way. Store it as the secret `nultron/prod/backup-heartbeat-url`, then
replace the cron line above with this one:

```cron
17 * * * * BACKUP_KEY="$(tccli ssm get-secret-value --region ap-jakarta --SecretName nultron/prod/backup-key --VersionStage SSMCurrent | python3 -c 'import json,sys;print(json.load(sys.stdin)["SecretString"],end="")')" BACKUP_HEARTBEAT_URL="$(tccli ssm get-secret-value --region ap-jakarta --SecretName nultron/prod/backup-heartbeat-url --VersionStage SSMCurrent | python3 -c 'import json,sys;print(json.load(sys.stdin)["SecretString"],end="")')" /bin/sh /srv/nultron/webapp-deploy/scripts/backup.sh >> /var/log/nultron-backup.log 2>&1
```

`tccli` prints JSON, so each value goes through the same `SecretString` extraction. Without it the
value holds quotes and spaces, the guard refuses it, no ping is sent, and a check that never got its
first ping never alarms.

A file that only the deploy user can read also works: `BACKUP_HEARTBEAT_URL="$(cat ~/.backup-heartbeat-url)"`
with the file at mode 0600.

| What happened | What `backup.sh` sends | What the monitor does |
|---|---|---|
| The run exited 0 | `GET <url>` | Marks the check up and restarts the clock |
| The run exited non-zero | `GET <url>/fail` | Alarms at once |
| Cron or the box stopped | Nothing | Alarms when the period and the grace window run out |
| `BACKUP_HEARTBEAT_URL` is empty | Nothing | Not applicable. The script behaves as it did before |

Create the check like this:

1. New check, **period 1 hour**, **grace 30 minutes**. The job runs at minute 17 and a run takes
   minutes, so 30 minutes of grace absorbs a slow run and a missed hour still alarms about 90 minutes
   after the last good one.
2. Point its alert at a channel you read (e-mail or Lark).
3. Store the ping URL where the cron line fetches it (Secrets Manager, or the 0600 file). Never in `.env`.
4. Run `backup.sh` once by hand with `BACKUP_KEY` and `BACKUP_HEARTBEAT_URL` exported, exactly as the
   cron line sets them, and watch the check turn up. Without `BACKUP_KEY` the script exits 1 and sends
   `/fail`.

The ping cannot make a good backup fail. Each attempt has a 10 second timeout and it retries twice, so a
dead monitor costs about 30 seconds at most. It ignores every error and does nothing when `curl` is
missing or the value is not an `http://` or `https://` URL. The URL is the monitor's secret. The script
never prints it and hands it to `curl` on stdin, so it stays out of the log and the process list. A
monitor without a `/fail` endpoint still gets the success ping, and a failed run then shows up as a missed
one.

Two cases send no `/fail`. The `EXIT` trap is set after `_common.sh` and `_heartbeat.sh` are sourced, so
an exit before that point (either file missing or failing to load) is silent, and so is a signal kill
under `dash`. Both show up as a missed run once the grace window passes.

Changing the box is a separate step that Rizky runs: pull the scripts, set the variable on the cron line,
create the check. Nothing here has been deployed.

## Restore / roll back

```sh
# data
sh webapp-deploy/scripts/restore.sh backups/nultron-data-20260918T120000Z.tar.gz

# code, one step back: the images from before the LAST deploy (run from webapp-deploy/)
docker image tag nultron-web:previous nultron-web:local
docker image tag nultron-portal:previous nultron-portal:local
docker compose -f compose.yml up -d --no-build --force-recreate app proxy portal

# code, an older sha: a rebuild, since no image is kept for it
git -C .. checkout <previous-sha>        # run on the server, by hand
sh webapp-deploy/scripts/deploy.sh --no-pull

# code, a server that runs the released bundle instead (in the bundle folder), as its DEPLOY.md says
git checkout <previous-ent-tag>          # its compose.yml pins both ghcr images to that tag
docker compose up -d                     # DEPLOY.md step 6
```

`restore.sh` stops both services, empties the volume, unpacks the tarball, promotes the
consistent snapshot over `agentforge.sqlite` (dropping the stale `-wal`/`-shm` so they
can never be replayed on top of it), and starts back up. It asks for confirmation unless
you pass `--yes`.

`:previous` holds the images from before the **last** deploy only, so it is one step back. This
source stack (`scripts/deploy.sh`) builds `nultron-web:local` and `nultron-portal:local` on the server and
pulls no Nultron image, so an older sha here is a rebuild. It still runs `git pull --ff-only`
(`scripts/deploy.sh:234-235`), and compose pulls the stock `caddy` and `postgres` images (`compose.yml:153`,
`:225`).

The released bundle is the path with a registry. Every release from `scripts/release-web.mjs` pushes
`ghcr.io/kyoo032/nultron-ent:<tag>` and `ghcr.io/kyoo032/nultron-portal:<tag>` and commits a bundle
whose `compose.yml` pins both images to that tag (`scripts/release-web.mjs:19-26` at the repo root). A server that runs the
bundle rolls back the way the bundle's own `DEPLOY.md` says (`scripts/release-web-docs.mjs:173-175`).
Check out the previous release tag of the release repo, then repeat its step 6, `docker compose up -d`.
No release has been cut yet. `Kyoo032/Nultron-Releases` had no GitHub Release on 2026-11-06, so there
is no older tag to pull.

The restore above brings back the data, not the code. A migration that ran is not undone.

## Migrating from the DPSBuddy names

The product is called Nultron now, and this folder follows: compose project `nultron-web`,
image `nultron-web:local`, volumes `nultron-data` and `nultron-components`, `NULTRON_DOMAIN`,
backups named `nultron-data-*`, secrets under `nultron/prod/`. A server that was deployed
under the old names (project `dpsbuddy-web`, volumes `dpsbuddy-data` and
`dpsbuddy-components`, `DPSBUDDY_DOMAIN`) does not pick any of this up by itself. Compose
prefixes every volume with the project name, so the new stack starts on empty volumes
(`nultron-web_nultron-data`, `nultron-web_nultron-components`, `nultron-web_caddy-data`)
and the data has to be copied across once. Nothing below deletes the old volumes.

1. Take a backup with the old scripts, and stop the old stack by project name. Do this
   before pulling the new `compose.yml`, or the old containers keep ports 80 and 443.

   ```sh
   export BACKUP_KEY=...                        # from the old Secrets Manager entry
   sh webapp-deploy/scripts/backup.sh
   docker compose -p dpsbuddy-web -f webapp-deploy/compose.yml down   # no -v: the volumes stay
   ```

2. Pull the new checkout, build, and let Compose create the empty new volumes
   (this creates the containers but starts nothing).

   ```sh
   git pull --ff-only
   cd webapp-deploy
   sh scripts/build.sh
   docker compose -f compose.yml create
   ```

3. Copy each old volume into its new one. `/from/.` includes dotfiles such as
   `.master-key`, and `cp -a` keeps ownership and modes.

   ```sh
   docker run --rm -v dpsbuddy-web_dpsbuddy-data:/from:ro -v nultron-web_nultron-data:/to alpine sh -c 'cp -a /from/. /to/'
   docker run --rm -v dpsbuddy-web_dpsbuddy-components:/from:ro -v nultron-web_nultron-components:/to alpine sh -c 'cp -a /from/. /to/'
   docker run --rm -v dpsbuddy-web_caddy-data:/from:ro -v nultron-web_caddy-data:/to alpine sh -c 'cp -a /from/. /to/'
   ```

   The last one keeps Caddy's certificate and ACME account; skip it and Caddy requests a
   new certificate on first start. Check the copy before going on:
   `docker run --rm -v nultron-web_nultron-data:/d alpine sh -c 'ls -la /d; du -s /d'`,
   and compare with the same command on the old volume.

4. In `.env`, rename `DPSBUDDY_DOMAIN` to `NULTRON_DOMAIN` (same value):
   `sed -i 's/^DPSBUDDY_DOMAIN=/NULTRON_DOMAIN=/' .env`. Nothing else in `.env` changes,
   and `AGENTFORGE_SECRETS_KEY` must keep its current value: a new key cannot read the
   copied `settings.enc`.

5. Rename the secret-manager entries. Create `nultron/prod/agentforge-secrets-key` and
   `nultron/prod/backup-key` with the same secret values as the old `dpsbuddy/prod/...`
   entries, then point `SSM_SECRET_AGENTFORGE_SECRETS_KEY` and `SSM_SECRET_BACKUP_KEY` in
   `.env` at the new names. Update the backup cron line to the new secret name and log
   file (see "Hourly cron"). COS bucket names do not change with the product name, so
   keep the current `COS_BACKUP_BUCKET` and `COS_MEDIA_BUCKET` values. Old
   `dpsbuddy-data-*.tar.gz.enc` backups are no longer matched by the retention prune;
   rename or delete them by hand.

6. Start the new stack and check it.

   ```sh
   sh scripts/deploy.sh --no-pull
   curl -sI https://$NULTRON_DOMAIN | head -1
   ```

   Once the site has been up for a while and a backup from the new stack has landed,
   remove the old leftovers: `docker volume rm dpsbuddy-web_dpsbuddy-data
   dpsbuddy-web_dpsbuddy-components dpsbuddy-web_caddy-data
   dpsbuddy-web_caddy-config`, `docker image rm dpsbuddy-web:local`, the old
   `dpsbuddy/prod/...` secrets, and the old `dpsbuddy-data-*` backups. Until then the old
   volumes and backups hold a full copy of every tenant's data and the old secret entries
   hold a second copy of the wrap key.

The released Enterprise bundle (`Kyoo032/Nultron-Releases`) renames the same things with the
project `nultron-ent` (old: `dpsbuddy-ent`) and the image `ghcr.io/kyoo032/nultron-ent`
(old: `ghcr.io/kyoo032/dpsbuddy-ent`). Substitute those prefixes in the commands above,
run `docker compose pull` in place of `build.sh`, and make sure the token used for
`docker login ghcr.io` can read the new package.

## Logs

```sh
sh webapp-deploy/scripts/logs.sh          # both services
sh webapp-deploy/scripts/logs.sh app      # the host
sh webapp-deploy/scripts/logs.sh proxy    # Caddy / TLS
sh webapp-deploy/scripts/logs.sh portal   # sign-in (also: portal-prepare, portal-db)
```

Caddy writes two streams: the access log on stdout and everything else, errors included, on stderr
(`docker logs proxy 1>access.log 2>runtime.log` keeps them apart). Both are filtered: neither holds a
sign-in `code` or `state` (SR-72).

## Security group rules

Spec N2, applied on the CVM's security group in the Jakarta console. The default
"allow everything outbound" rule is wrong; replace it.

**Inbound**

| Source | Protocol / port | Why |
|---|---|---|
| `0.0.0.0/0`, `::/0` | TCP 443, **UDP 443** | HTTPS, and HTTP/3 which `compose.yml` publishes |
| `0.0.0.0/0`, `::/0` | TCP 80 | ACME HTTP challenge and the redirect to 443. Nothing is served here |
| Kyo's IP allowlist, or the bastion's private IP | TCP 22 | SSH, key only (spec I4) |
| anything else | - | **deny** |

**Outbound**

| Destination | Protocol / port | Why |
|---|---|---|
| `0.0.0.0/0` | TCP 443 | `api.tokotokenai.com`, the portal, `registry.npmjs.org`, Tencent APIs (SSM, COS, CLS), Let's Encrypt, ghcr.io |
| the SES SMTP address, `sg-smtp.qcloudmail.com` | TCP 465 | The portal's sign-in mail, implicit TLS (owner decision 2026-10-01). Port 25 stays closed, and 587 is not used |
| `0.0.0.0/0` | UDP 53 and TCP 53 | DNS |
| anything else | - | **deny**. No plain HTTP out, no cleartext SMTP, no outbound SSH |

> **One conflict to settle before you close port 80 outbound.** `deploy.sh` builds the
> image *on this server*, and the build stage runs `apt-get` against `deb.debian.org`
> over HTTP. Either open TCP 80 outbound only while a build runs, or point apt at the
> HTTPS mirror in the Dockerfile. Moving builds to CI (migration plan) removes the
> question.

Verify from outside the VPC, not from the console:

```sh
nmap -Pn -p 1-65535 <public-ip>      # expect 80 and 443 only; 22 only from an allowlisted source
curl -sI https://$NULTRON_DOMAIN | grep -iE 'strict-transport|content-security|x-content-type'
```

## Transport filtering

Everything below is **server mode only** (`AGENTFORGE_SERVER=1`). Off server mode, webdev
(`:3000`) keeps the loopback rule it has always had: no filter, no limiter, no masking of
error text. Every rejection is the same JSON envelope, `{"error":{"code":"...","message":"..."}}`,
with `X-Content-Type-Options: nosniff`, and is written to stdout as one
`{"event":"request_filtered", ...}` line carrying the code, the method, the *length* of the
path and the client IP - never the path itself and never the body.

The order is cheapest first, and all of it runs **before** the Origin, CSRF and session rules
and long before a handler: TLS hop, request shape, rate, then the existing Origin/CSRF pair.

**Which requests it covers.** The TLS hop, the method allowlist, the path filter, the
header-size cap and the rate buckets run for **every** request, `/api` or not: the page, the
built bundles, every 404 probe. `handleNodeRequest` is the first middleware in
`apps/web/server.ts`, above `express.static` and vite, so a page request meets them before
anything serves it; a clean one falls through untouched. Only the Origin, CSRF, session and
`Content-Type` rules are `/api`-only - those are about a call the renderer makes rather than
about the hop it arrived on. If that mount ever moves, these controls move with it.

### Masked identity

| Rule | Where |
|---|---|
| No `X-Powered-By` (Express sets it on every response) | `app.disable("x-powered-by")`, `apps/web/server.ts`; removed again in `http-adapter.ts` `IDENTITY_HEADERS` |
| No `Server` | `header -Server` and `-X-Powered-By` in the `Caddyfile`; `IDENTITY_HEADERS` in the adapter |
| No stack trace, file path, SQL or module name in a 5xx body | `maskServerError` in `packages/host/src/http-adapter.ts` - the reason code survives, the message becomes fixed text |
| An exception that escapes a handler answers the same masked 500, never Express's HTML error page | `dispatchMasked` in `http-adapter.ts` |
| No directory listing | there is no `file_server` in the `Caddyfile`; the app process serves every path |

### HTTPS everywhere

| Rule | Code |
|---|---|
| HTTP redirects to HTTPS, permanently | `http://{$NULTRON_DOMAIN}` block in the `Caddyfile` (nothing else is served on :80) |
| TLS 1.2 minimum | `tls { protocols tls1.2 tls1.3 }` |
| `Strict-Transport-Security: max-age=31536000; includeSubDomains` (no `preload`: the preload list is a months-long one-way door, so it is a deliberate later step) | `Caddyfile` header block |
| Only `https://` origins can be trusted; a cleartext entry in the allowlist is dropped | `trustedOrigins` in `packages/core/src/server-mode.ts` |
| A request without `X-Forwarded-Proto: https` answers **403 `https_required`** - which is every direct hit on `127.0.0.1:3000` from inside the box | `rejectPlaintext` in `http-adapter.ts` |

### HTTP filter

All in `filterHttpRequest`, `packages/host/src/local-request.ts`.

| Rule | Answer |
|---|---|
| Method must be GET, HEAD, POST, PUT, PATCH, DELETE or OPTIONS (so TRACE, TRACK, CONNECT and the WebDAV verbs are out) | 405 `method_not_allowed` |
| Path may not carry a control character, a raw or encoded NUL, a `..` segment (`%2e` spellings included), a backslash, or an encoded separator `%2f` / `%5c` | 400 `invalid_path` |
| Path may not exceed 2048 characters (`MAX_REQUEST_PATH_LENGTH`) | 400 `invalid_path` |
| At most 32 query parameters (`MAX_QUERY_PARAMS`) | 400 `too_many_query_params` |
| No single header past 8 KB, name plus value (`MAX_HEADER_BYTES`); Node already caps the whole block at 16 KB | 431 `header_too_large` |
| `Content-Length` above `MAX_BODY_BYTES` (26 MB) is refused before a byte of the body is read | 413 `payload_too_large` |
| A body must declare `application/json`, `multipart/form-data` or `text/plain`; `application/x-www-form-urlencoded` - the cross-site form shape - is not one of them | 415 `unsupported_media_type` |
| `Host` must be one of the trusted origins' hosts, and mutating calls need the Origin and the double-submit CSRF token | 403 `origin_forbidden`, `csrf_missing`, `csrf_invalid` |
| `Expect: 100-continue` | handled by Node before any of this |

### Rate limits

Token buckets in memory, `packages/host/src/rate-limit.ts`, bounded at 50 000 keys per
limiter with least-recently-used eviction - so rotating the source IP or the cookie costs
the attacker everything and the server nothing. Over the limit is **429 `rate_limited`**
with `Retry-After` in whole seconds.

| Bucket | Key | Default | Env |
|---|---|---|---|
| Per client IP | **last** `X-Forwarded-For` hop, else the socket address | 600 rpm, burst 100 | `AGENTFORGE_RATE_IP_RPM` |
| Per session | SHA-256 of the session cookie value, truncated - the value itself never becomes a map key or a log field. The name is the one this mode mints: `__Host-agentforge_session` in server mode | 300 rpm, burst 50 | `AGENTFORGE_RATE_SESSION_RPM` |
| `/api/v1/auth/*` | client IP again, tighter, because each of those is a portal round trip | 120 rpm, burst 40 | `AGENTFORGE_RATE_AUTH_RPM` |

Set a value to `0` to switch that bucket off. Junk falls back to the default: a typo in
`.env` must not quietly remove a limit.

Two Caddy defaults the app depends on, neither of which may be removed from the
`Caddyfile`: `X-Forwarded-For` (the limiter's key) and `X-Forwarded-Proto` (the HTTPS
check). `Host` must keep passing through unchanged for the Origin rule, as before.

**Who may set `X-Forwarded-For`.** The limiter reads the **last** hop, because a client can
send a header of its own and an appending proxy leaves that forged value first - reading the
first hop would let one machine mint a fresh bucket per request. The last entry is the one
the proxy in front wrote, which holds only while Caddy is the only thing that can reach the
app port. Caddy 2.7 and later *replace* `X-Forwarded-For` for a client that is not a declared
trusted proxy (the default trusted set is empty); verify the build on the box with
`caddy version` rather than assuming it. Putting a CDN or a load balancer in front means
declaring its ranges in `trusted_proxies` **and** revisiting the last-hop rule, since an extra
appending hop moves the client address away from the end. See the comment block above
`reverse_proxy` in the `Caddyfile`.

## Before-traffic acceptance

Spec section 9: every row below has to hold before the first user other than Kyo signs
in. Kyo signs the list in [`DEPLOY-LOG.md`](DEPLOY-LOG.md) with the sha that passed.
Rows marked *(code)* are **not** satisfiable from this folder - see
[What the spec asks that this folder cannot do](#what-the-spec-asks-that-this-folder-cannot-do).

- [ ] **N2** Security group: inbound 443/80/22-allowlist, outbound 443 + DNS only. Port-scanned from outside
- [ ] **N3** TLS 1.2+, HSTS `max-age=31536000`, certificate auto-renewing. `curl -I` and SSL Labs
- [ ] **N5** Only the proxy is reachable; the host still binds loopback. `ss -ltnp` on the CVM
- [ ] **I1** Root account: MFA on, no API keys, billing only
- [ ] **I2** Kyo on a CAM sub-account with MFA; the CVM uses an instance role. No `SecretId` in any file on the box
- [ ] **I3** Role policy is `PutObject`/`GetObject` on the two buckets and `GetSecretValue` on the one secret, nothing more
- [ ] **I4** SSH key-only, password auth off, root login off, `fail2ban` running. `sshd -T`
- [ ] **H1** Ubuntu LTS with `unattended-upgrades` on and a weekly reboot window
- [ ] **H2** Container runs as `node`, `read_only: true`, `/data` the only writable mount, `no-new-privileges`, `cap_drop: ALL`. In `compose.yml`; confirm with `docker inspect`
- [ ] **H4** Image built from a pinned sha, and the sha is in `DEPLOY-LOG.md`. `deploy.sh` appends it
- [ ] **A1** *(code)* Mutating `/api` accepts a trusted-origin allowlist and **rejects a missing Origin**
- [ ] **A3** CSP, `X-Content-Type-Options`, `Referrer-Policy: same-origin`, `Permissions-Policy` served by Caddy. In `Caddyfile`
- [ ] **A6** Every 4xx/5xx is the `{code, message}` envelope - no stack traces, paths or SQL
- [ ] **T4** *(code)* The gateway gate fails **closed** on the hosted build
- [ ] **T8** *(code)* "Start over" is scoped to the caller's tenant, or disabled on the web build
- [ ] **S1** *(code)* `AGENTFORGE_SECRETS_KEY` is mandatory; the `.master-key` fallback throws in server mode
- [ ] **S2** The wrap key comes from Secrets Manager at deploy time and is not in `.env`, the image, or git. `deploy.sh` with `USE_SSM=1`
- [ ] **S5** CBS disk encryption on; COS SSE-KMS on both buckets
- [ ] **S6** Backups encrypted before upload. `backup.sh` with `BACKUP_KEY`
- [ ] **L1** *(code)* No prompts, bodies, keys or tokens in any log line; tenant id and request id as fields
- [ ] **L2** Proxy access log with IP, path, status, latency, shipped to CLS with 30-day retention. In `Caddyfile`
- [ ] **L3** Alerts wired: disk > 80 %, 5xx > 1 % over 5 min, health check failing 3 times, backup job missed, certificate < 14 days
- [ ] **L5** This README's incident-response section read and the read-only switch rehearsed

## Incident response

Spec L5. One page, in the order you will actually want it at 03:00.

**Who.** Kyo is on call and is the only escalation. There is no second responder yet; say
so out loud rather than pretending otherwise.

**1. Take the site read-only, first, before diagnosing.** It costs about a second and it
stops an active abuser from writing anything else. In [`Caddyfile`](Caddyfile), uncomment
the two lines under *Incident response*:

```caddyfile
@mutating not method GET HEAD OPTIONS
respond @mutating "Nultron is temporarily read-only." 503
```

```sh
docker compose -f webapp-deploy/compose.yml restart proxy
curl -si -X POST https://$NULTRON_DOMAIN/api/v1/workspaces | head -1   # expect 503
```

Reads keep working, so nobody loses access to their own work while you look. Comment the
lines back out and restart the proxy to restore writes.

**2. Preserve evidence before you restart anything else.** `sh scripts/logs.sh proxy 5000
> /tmp/incident-proxy.log` and the same for `app`, plus `sh scripts/backup.sh` for a
point-in-time copy. Docker's json-file logs rotate at 10 MB x 5; a busy hour can age out
the thing you need.

**3. Rotate the wrap key (spec S4)** if there is any chance `AGENTFORGE_SECRETS_KEY`
leaked - a copy of `.env`, a shell history, a leaked image layer, an SSM audit line you
cannot account for:

1. Generate the new key and put it in Secrets Manager as a **new version** of
   `nultron/prod/agentforge-secrets-key`. Do not overwrite the current one yet.
2. Take a backup (`scripts/backup.sh`). This is the rollback.
3. Re-wrap: with both keys available, decrypt every `settings.enc` envelope with the old
   key and re-encrypt with the new one. **There is no script for this yet** - writing and
   drilling it is the Phase 4 item S4 names, and it is the single biggest hole in this
   runbook.
4. Swap `SSMCurrent` to the new version and redeploy (`scripts/deploy.sh --no-pull`).
5. Verify a gateway call still works, then delete the old version.
6. Treat every tenant gateway key the old wrap key protected as exposed: rotate them with
   the provider too.

**4. Notify affected tenants within 72 hours.** UU PDP 27/2022 expects it, and the clock
starts when you become *aware*, not when you finish the investigation. Send: what
happened, what data was involved, when, what you have done, what they should do. Send it
even if the investigation is incomplete - a second message is fine, a late first one is
not. Contact addresses come from the portal tenant list.

**5. Write it down.** A row in [`DEPLOY-LOG.md`](DEPLOY-LOG.md) with the sha, and the
narrative in the decision record.

## Restore drill

Monthly, on the first working day. Placement doc section 5: RTO 2 hours, RPO 1 hour. An
untested backup is a hypothesis.

1. Start a scratch CVM in Jakarta from the same base image. Do **not** drill on the
   production box.
2. Pull the newest object from the COS backup bucket.
3. `export BACKUP_KEY="$(...tccli ssm get-secret-value...)"` - the same fetch the cron
   line uses.
4. `sh webapp-deploy/scripts/restore.sh <archive>.tar.gz.enc --yes`
5. Wait for the healthcheck, open the app, and check three things by hand: a thread's
   messages are there, Settings still decrypts the gateway key (so the wrap key in SSM
   matches the archive), and a media file opens.
6. Record the date, the archive, the wall-clock time to green, and anything that went
   wrong in [`DEPLOY-LOG.md`](DEPLOY-LOG.md).
7. Destroy the scratch CVM.

A drill that was not written down did not happen.

## What the spec asks that this folder cannot do

These are **before-traffic** rows that no amount of compose, Caddy or shell can satisfy.
Each is a source change in [`docs/internal/web-migration-plan.md`](../docs/internal/web-migration-plan.md),
and this folder is deliberately additive - it does not edit `apps/` or `packages/`.

| Row | What it needs | Where |
|---|---|---|
| **A1** | **Landed 2026-09-18.** With `AGENTFORGE_SERVER=1` mutating `/api` needs an Origin and a Host from `AGENTFORGE_TRUSTED_ORIGINS` (a missing Origin is rejected) plus the CSRF token (`__Host-agentforge_csrf` cookie, `x-agentforge-csrf` header). The proxy passes `Host` through unchanged. | `packages/host/src/local-request.ts`, `http-adapter.ts`, `csrf.ts` |
| **T4** | **Landed 2026-09-18.** The gate fails closed on the hosted build (meta marker injected by `server.ts`), and in server mode the host takes no key on trust and the stub runtime does not open it | `apps/web/lib/gateway-gate.ts`, `packages/host/src/gateway-gate.ts` |
| **T8** | **Landed 2026-09-18.** Both reset scopes answer `403 reset_disabled` in server mode; per-tenant reset is Phase 3 | `packages/host/src/handlers/settings.ts` |
| **S1** | **Landed 2026-09-18.** With `AGENTFORGE_SERVER=1`, `getLocalVaultKey` throws `SERVER_VAULT_KEY_REQUIRED` when `AGENTFORGE_SECRETS_KEY` is unset and `SERVER_VAULT_KEY_TOO_WEAK` when it carries under 32 bytes of entropy; the `.master-key` fallback is unreachable on the server. The gate is server mode, not `NODE_ENV` | `packages/db/src/vault-key.ts:123-134` |
| **L1** | No prompts, message bodies, keys or tokens in any log line, with tenant id and request id as fields. Caddy's access log is filtered here, but the application logger is the one that sees prompts | host logger |

**A4** rate limiting has no Caddy module in the pinned `caddy:2.11-alpine` image, so it is
done in the app instead - per IP, per session and tighter on `/api/v1/auth/*`; see
[Transport filtering](#transport-filtering). **L2**/**L3** produce the log lines but
nothing ships them to CLS or raises an alarm yet.

## Environment

Full list with a line of meaning each in [`.env.example`](.env.example). The ones that
matter:

| Var | Meaning |
|---|---|
| `NULTRON_DOMAIN` | Public hostname Caddy serves and gets a certificate for |
| `PORTAL_DOMAIN` | The portal's public hostname, the second name Caddy serves. Also the app's hairpin target and the portal's `PORTAL_PUBLIC_URL`. The only new variable the proxy gets (SR-73) |
| `portal.env` (a second file) | The portal side's secrets and settings: `PORTAL_SIGNING_KEY`, `PORTAL_POSTGRES_PASSWORD`, `PORTAL_APP_DB_PASSWORD`, `PORTAL_SMTP_*`. See [`portal.env.example`](portal.env.example). Loaded only by `portal`, `portal-prepare` and `portal-db` |
| `AGENTFORGE_SECRETS_KEY` | 32-byte hex wrap key for `settings.enc` and sealed prompts (`openssl rand -hex 32`). Generate once. Changing it makes the vault unreadable |
| `AGENTFORGE_DATA_DIR` | `/data` — SQLite, settings, media, logs. On the volume |
| `AGENTFORGE_COMPONENTS_DIR` | `/opt/agentforge/components` — native components, on their own volume. Must not be inside `AGENTFORGE_DATA_DIR`: a server refuses to load a module from there |
| `NODE_ENV` | `production` — anything else starts Vite dev middleware |
| `PORT` | `3000` inside the container only |
| `AGENTFORGE_RUNTIME` | `ai` or `stub`. `stub` answers without a model **and** disables the component installer's auto-download. Leave unset for normal gateway-first behaviour |
| `DATABASE_URL` | Leave unset. SQLite under the data dir. A `postgres://` URL throws on boot — Postgres is an open decision, not a supported mode |
| `USE_SSM` | `1` on the CVM: `deploy.sh` fetches the wrap key and `BACKUP_KEY` from Secrets Manager with the instance role and exports them for that one command. `0` reads them from `.env` (local and staging only) |
| `SSM_SECRET_AGENTFORGE_SECRETS_KEY` / `SSM_SECRET_BACKUP_KEY` | Secret **names** in SSM, never values |
| `BACKUP_KEY` | Passphrase for `openssl enc` over the backup tarball (spec S6). Separate from the wrap key. Empty in `.env` on the server |
| `TENCENT_REGION` | `ap-jakarta`. SSM, COS and the CVM. Personal data stays in-country; `ap-singapore` is the backup replica only |
| `COS_BACKUP_BUCKET` / `COS_MEDIA_BUCKET` | `<name>-<appid>` as the console shows them. Both private, both SSE-KMS |
| `AGENTFORGE_SERVER`, `AGENTFORGE_TRUSTED_ORIGINS`, `BIND_HOST`, `AGENTFORGE_PORTAL_URL`, `AGENTFORGE_MAX_FFMPEG`, `AGENTFORGE_MAX_SQL_WORKERS`, `AGENTFORGE_JOB_QUEUE_TIMEOUT_MS`, `AGENTFORGE_LOG_LEVEL`, `AGENTFORGE_RATE_IP_RPM`, `AGENTFORGE_RATE_SESSION_RPM`, `AGENTFORGE_RATE_AUTH_RPM` | Hosted mode (Phase 1 and 2). See the comments in `.env.example`; the switch is `AGENTFORGE_SERVER=1` |
| `AGENTFORGE_APPLY_PENDING_RESET` | **Never set by hand.** `apps/web/server-env.ts` sets it to apply a queued "Start over" wipe |

## What is not done yet

Nothing in this folder makes the app safe to expose. These are the gaps, and they belong
to [`docs/internal/web-migration-plan.md`](../docs/internal/web-migration-plan.md) and the
open decisions in [`docs/internal/web-pivot-2026-09-18.md`](../docs/internal/web-pivot-2026-09-18.md).

1. **Writes behind the proxy: landed 2026-09-18.** With `AGENTFORGE_SERVER=1` the host checks
   Origin and Host against `AGENTFORGE_TRUSTED_ORIGINS` and requires the CSRF token, so the
   `Caddyfile` no longer rewrites `Host`. Set the public origin in `.env` or every write answers
   `403 origin_forbidden`.
2. **Sign-in: backend landed 2026-09-18, no screen yet.** In server mode every `/api` call
   except `/api/v1/auth/*`, `GET /api/v1/ping` and `GET /api/v1/components` answers
   `401 session_required` until a portal session exists (`packages/host/src/auth/`). The
   browser sign-in screen and the portal's browser-login endpoint are still open (decision 2).
3. **No tenancy.** Every row is the single owner's. `one server, many tenants` is the
   target, not the state; the schema has no tenant column. Open decision 1, and until it
   is answered a public deployment is a shared, single-tenant desk.
4. **No CSRF protection.** See (1).
5. **No seat / plan enforcement server-side.** The 20-seat paywall and the two-plan
   pricing model are decided in principle; the host does not check a plan row yet.
6. **Single SQLite file, single server.** Fine for the first deployment by the decision
   record. No replication, so the backup tarball is the only copy.
7. **No CI build.** `scripts/release-web.mjs` builds the app and portal images from a sha and pushes them,
   private, to ghcr, and the released bundle pulls them; `deploy.sh` still builds on the server from a checkout.
8. **No log shipping, no metrics, no alerting.** `docker compose logs` is all there is.
9. **ffmpeg / ffprobe absent**, so Edit export degrades.
10. **The image runs the TypeScript source through `tsx`, not a compiled bundle.** Dev
    dependencies no longer ship (SR-113); the source tree does (SR-49).
