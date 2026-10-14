# Map — webapp-deploy: the hosted deployment stack

Product: both · Instance: hosted servers, not :3000

Last verified: 2026-10-14 at 73db3c3 + the uncommitted `fix/hosted-downloads` tree, for the `encode` match on the app and portal sites (`webapp-deploy/Caddyfile`, and the k8s copy in `k8s/base/caddy/security.caddy`, which the rehearsal does not parse for it). Read against the file; Caddy itself not run on this box, so the syntax is unvalidated. Before that: 2026-10-05 at 0b61a29 + the uncommitted working tree, except one gotcha corrected on 2026-10-07 (ffmpeg is in the image since `5bec532`; the bullet under Gotchas was written before that). Re-read that day: the build and runtime
description, the HEALTHCHECK paragraph, the components-check cites, the ignore-file rows and the
dependencies gotcha, against `webapp-deploy/Dockerfile` as it stands after the SR-113 change. The rest
of the page keeps the caveat in the note below. On 2026-10-11 the *Run: five services* sentence about `portal-entry.sh` was re-read against the script at 2df34be plus the SH-005 fix on branch `fix/sh-005-portal-entry-exit-code` (2026-10-11 at 2df34be, before merge); nothing else on the page changed that day.

**Phase 0 pilot additions (2026-10-01, working tree on top of 0b61a29):** the sections marked
*(pilot)* below were re-verified on that date, with the compose stack driven on a developer machine
(`webapp-deploy/pilot-local.mjs`). The rest of the page keeps the date above, and its `file:line`
citations into `compose.yml`, the `Caddyfile` and the scripts predate the pilot edits and the Phase 8
`/healthz` probe: read them as pointers, not coordinates, until the page is next re-verified.

## Overview

`webapp-deploy/` is how the repo becomes a running server: a Dockerfile that builds `apps/web` and its
workspace dependencies into one image, a five-service compose stack (the app, its Caddy proxy, and the
portal stand-in with its Postgres and a one-shot prepare step; *pilot*), a Caddy reverse proxy that
terminates TLS for two names, and eight shell scripts for build / deploy / backup / restore / logs /
portal operations. A second image, `portal.Dockerfile`, builds the portal (*pilot*). The target host
for the Phase 0 pilot is one Tencent Lighthouse box in Jakarta (owner decision, 2026-10-01); the
design target is a Tencent Cloud CVM.

It is **additive**. Nothing in `apps/`, `packages/`, the root `package.json`, `pnpm-workspace.yaml` or
`turbo.json` is touched by it, which is what keeps the frozen Electron desktop (0.14.27) and the
mobile app building unchanged (`webapp-deploy/README.md:8-10`).

It is not a deployment *guide* and not the product's security model. The step-by-step runbook for a
fresh CVM is [`../tencent-cvm-setup.md`](../tencent-cvm-setup.md); the server-mode rules the app
itself enforces are [`hosted-server-mode.md`](hosted-server-mode.md). This page is the map of the
folder: what each file does, what depends on what, and the things about it that surprise people.

## How it works

### Build: one image, the whole workspace source, production dependencies

`webapp-deploy/Dockerfile` is four stages over `node:22-bookworm-slim`, and the **build context is
the repo root**, not this folder (`Dockerfile:5-6`).

1. **`base`** (`Dockerfile:34-48`) enables corepack and pins pnpm `9.15.9` (`:29`, `:40-41`), matching the
   root `packageManager` field. It then `chmod a+x`es every `.py` under the corepack home — without that,
   `better-sqlite3`'s regenerated Makefile re-runs `gyp_main.py` directly and dies with `EACCES`
   (`:43-48`).
2. **`build`** (`:60-87`) is the **full** install, dev dependencies included, because `vite build` needs
   `vite`, `tailwindcss` and `postcss`. It installs `python3`, `make` and `g++` for `better-sqlite3`'s
   node-gyp fallback (`:61-63`), runs `pnpm install --frozen-lockfile --filter "@agentforge/web..."`
   (`:73`) — the web app and its workspace dependencies only, so `apps/desktop` and `apps/mobile` are
   never installed — then `pnpm --filter @agentforge/web build` (`:76`), which is `vite build` into
   `apps/web/dist`, and `node scripts/build-sandbox-runtime.mjs --out /opt/sandbox-runtime` (`:87`), the
   Pyodide and QuickJS folder `run_code` reads (SR-111). Nothing from this stage's `node_modules` reaches
   the runtime image; what leaves it is `apps/web/dist` and `/opt/sandbox-runtime`.
3. **`prod`** (`:102-147`) is the tree that ships: a second, fresh `COPY . .` (`:108`) and
   `pnpm install --frozen-lockfile --prod --filter "@agentforge/web..."` (`:113`), so only `dependencies`
   and `optionalDependencies` of the web app and its workspace packages are installed (the root
   package's dev dependencies are skipped too). It takes the renderer from the build stage
   (`COPY --from=build`, `:117`), runs the components check (`:137-138`, see *Components* below), and
   then a **load check** (`:145-147`) that imports `@agentforge/host/http` — the router, every handler,
   `core` and `db` — from `apps/web` under this tree, so a server import of a package the tree lacks
   fails the build with `ERR_MODULE_NOT_FOUND` instead of failing the first container start. It is a
   second install rather than a prune of the build tree on purpose (`:92-95`); see the dependencies
   gotcha below.
4. **`runtime`** (`:152-223`) sets the environment (`:157-161`), copies the production tree wholesale
   (`COPY --from=prod --chown=node:node /app /app`, `:167`) and the sandbox folder, root-owned and
   read-only, to `/app/sandbox` (`:172-173`), creates and chowns `/data` and declares it a volume
   (`:175-176`), does the same for the components root (`:188-189`), drops to the non-root `node` user
   (`:191`), and starts `./node_modules/.bin/tsx server.ts` (`:223`).

The image still carries the TypeScript source of every workspace package, because they export `.ts`
(`:8-12`; SR-49 half 1). Since 2026-10-05 it no longer carries the dev toolchain (SR-113).

Debian rather than Alpine is deliberate: `pnpm-lock.yaml` resolves `@firecrawl/anydoc` to the
`-linux-x64-gnu` / `-linux-arm64-gnu` packages, and musl would pick different ones and force a
`better-sqlite3` rebuild (`Dockerfile:24-26`).

The container's own `HEALTHCHECK` (`Dockerfile:220-221`) calls `GET /healthz` on loopback with
`node -e fetch` — there is no curl in the image. `/healthz` is answered in the HTTP adapter before routing
(`isLiveness`, `packages/host/src/http-adapter.ts:548-551`; `respondLiveness`, `:402`, called at `:621`), so it
never reaches `dispatch`, never opens the database and sits outside the session gate by construction. Its
body is the frozen `{"status":"ok"}` (`LIVENESS_BODY`, `packages/host/src/handlers/health.ts:51`; the path is
`LIVENESS_PATH`, `:44`). It is the one request exempt from the TLS-hop rule: `transportRejection` is called with
`allowPlaintext = isLiveness` (`:612`, `:469-472`), so the probe needs no `x-forwarded-proto` header, while the
request-line filter, method allowlist, header cap and per-IP bucket still run over it. Every other request
without that header answers `403 https_required` (`rejectPlaintext`, `:452-455`); see
[hosted-server-mode.md](hosted-server-mode.md).

### Components are the image's, not a download

The app can install a native component at runtime — that is how a desk gets `@firecrawl/anydoc` on
first use. A server does not. The component directory and the binary in it are shared by every
tenant, so `handlers/components.ts` answers `403 install_disabled` to the install route whenever
`isServerMode()`, and the image is expected to carry what the server needs instead.

Two lines in this folder make that true rather than hoped for:

- The `prod` stage runs `scripts/components.ts check` (`Dockerfile:137-138`), which loads every id in
  `packages/host/src/components/server.ts` `SERVER_COMPONENT_IDS` the way a request would and exits
  non-zero if one does not. A filter change or an unpublished platform package fails the build
  instead of shipping a container that boots healthy and silently reads every document with the
  reduced fallback extractor. It runs with `AGENTFORGE_SERVER=1` and the runtime stage's
  `AGENTFORGE_COMPONENTS_DIR` so its printout is the container's.
- The runtime stage puts that directory at `/opt/agentforge/components` (`Dockerfile:160`,
  `:188-189`) — **outside** `/data`, on its own volume (`compose.yml:64-68`). See the `noexec`
  gotcha below for why that separation is the point.

`components.sh install` is a **repair**, not an upgrade path: a newer version arrives in a newer
image. It exists for the box whose bundled copy stopped loading, and an install there needs an app
restart before the running process uses it — the loader memoises its answer, failure included
(`packages/host/src/file-extract/anydoc.ts:136-150`). Full picture:
[`component-installer.md`](component-installer.md).

### Run: five services, one network namespace for two of them *(pilot)*

`webapp-deploy/compose.yml` defines `app`, `proxy`, `portal`, `portal-db` and `portal-prepare`. One of
each: the app's and the portal's limiters and the portal refresh lock live in process memory (SR-29,
SR-66). The portal side has its own image (`portal.Dockerfile`, allowlist context
`portal.Dockerfile.dockerignore`), its own env file (`portal.env`, loaded only by those three services; the
app's `.env` never holds the signing key, the database passwords or the SMTP login; the proxy has no env
file at all and gets only `NULTRON_DOMAIN` and `PORTAL_DOMAIN`), and a database network (`portal-db`,
`internal: true`) that the app is not on. `portal-entry.sh` refuses a missing, empty or URL-unsafe password by name and exits 1 under dash and bash (`webapp-deploy/portal-entry.sh:20-21` and `:30-31`; explicit checks, because a failed `${VAR:?}` exits 2 under dash), then builds the portal's two DSNs from the two
passwords; `portal-prepare` runs the Kubernetes rehearsal's `prepare-db.mjs` from inside the image
(migrate as the schema owner, set `portal_app_login`'s password, SR-56). The app reaches the portal over
https through the proxy: `extra_hosts` resolves `PORTAL_DOMAIN` to the app's own loopback, where Caddy
(same namespace) listens on 443 (SR-26). Only the app publishes ports, and only as `0.0.0.0:`, so Docker
never binds `[::]` (SR-79).

The older description of `app` and `proxy` follows.

`app` builds from the repo root, runs with `read_only: true` and a `/tmp` tmpfs (`compose.yml:60-62`),
`no-new-privileges` and `cap_drop: ALL` (`:88-91`), `init: true` to reap ffmpeg and SQL worker children
(`:94-95`), and `pids_limit` / `mem_limit` caps (`:96-98`). Two mounts are writable and no others:
`/data` for tenant work and `/opt/agentforge/components` for the operator's components
(`:64-68`). Logs are json-file, 10 MB × 5.

`proxy` is `caddy:2.11-alpine` (pinned to the minor, because the sign-in log filters need Caddy 2.8 or
later) with `network_mode: "service:app"`. It joins the app
container's network namespace rather than talking to it over a bridge, because the app binds
`127.0.0.1` inside the container. A service sharing another's namespace cannot publish ports of its
own, which is why `80`, `443` and `443/udp` are published on **`app`** (`compose.yml:109-112`). `proxy`
gets `NET_BIND_SERVICE` back — the only capability it needs — to bind those ports.

The app binds whatever `resolveBindHost` returns (`apps/web/server.ts:146-147`,
`apps/web/lib/bind-host.ts:17-27`), which defaults to loopback and throws on a non-loopback value
unless `AGENTFORGE_SERVER` is on. The stack does not set `BIND_HOST`, so the default holds.

### Front: Caddy

**(pilot)** The Caddyfile now serves two names and filters two log streams. A `(sign_in_filters)` snippet
(defined above the global block, because a snippet is read only after it is defined) deletes `Cookie`,
`Authorization` and `Set-Cookie`, and `code` and `state` from `request>uri`, from `request>headers>Referer`
and from `resp_headers>Location` (the portal's 302 to `/auth/callback?code=...&state=...`, which Caddy logs in
the response headers). It is imported by both the `(access_log)` snippet (stdout, one per site) and a global
`log default` (stderr), where the error line for a failed upstream request, with the request's full URI, is
written (SR-72; driven against real Caddy with a forced upstream error, 2026-10-01). The app's site has a
`@billing_webhook path /api/v1/billing/webhook*` that answers `404` before `reverse_proxy` until a payment
provider is bound (SR-03, owner decision 2026-10-01), and a second site, `{$PORTAL_DOMAIN}`, proxies to
`portal:4000` with transport and identity headers only (the portal sets its own CSP).
`k8s/base/caddy/security.caddy` carries a copy of the filter list and `scripts/pilot-deploy.test.mjs` fails if
the two drift.

What follows is the older description of the app's site. `http://{$NULTRON_DOMAIN}` does nothing but a
permanent redirect to HTTPS (now `http://{$NULTRON_DOMAIN}, http://{$PORTAL_DOMAIN}`). The HTTPS site sets TLS 1.2 as the floor (`:28-30`), compresses
(`:32`), and sends the security header block — CSP, HSTS, `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, the COOP/CORP pair and a fully-off `Permissions-Policy` (`:46-59`) — while stripping
`Server` and `X-Powered-By` (`:65-66`). The access log is JSON on stdout with `Cookie`,
`Authorization` and `Set-Cookie` deleted before the line is written (`:72-83`).

`reverse_proxy 127.0.0.1:3000` (`Caddyfile:114`) carries one directive, `flush_interval -1` (`:135`),
which stops Caddy buffering the SSE job stream.

Two commented lines under *Incident response* (`Caddyfile:87-88`) take the site read-only on a proxy
restart.

### Operate: the scripts

All of them source `scripts/_common.sh`, which resolves the folder and repo root, defines `dc()` as
`docker compose -f compose.yml` (plus `$DC_ARGS`, empty on a server, used by the local rehearsal) with a
legacy fallback, and reads `.env` values with `sed` rather than by sourcing the file — a stray backtick in
a value would otherwise execute. **(pilot)** Added: `portal.sh` (run `apps/portal/scripts/<name>.ts` inside the
running portal through `portal-entry.sh`; `otp` is refused, SR-10), `restore-portal.sh` (`--scratch` drill, or
the destructive restore of the portal database), `backup.sh` now also writes `nultron-portal-<stamp>.dump.enc`
(`pg_dump -Fc`, same cipher) and rejects an archive with no entries, `build.sh` and `deploy.sh` build and wait
for the portal as well, and `cos_upload` moved into `_common.sh`.

| Script | What it does |
|---|---|
| `build.sh` | `dc build app`, then prints the image size |
| `deploy.sh` | With `USE_SSM=1`, reads the wrap key and `BACKUP_KEY` from Secrets Manager with the instance role and exports them for that process only; `git pull --ff-only`; build; `up -d`; polls the container health for up to five minutes; appends a row to `DEPLOY-LOG.md` |
| `backup.sh` | Consistent SQLite snapshot via `VACUUM INTO`; tar of `/data` minus `components/`, `logs/` and `.master-key`; `openssl enc -aes-256-cbc -pbkdf2 -iter 200000` before the bytes leave the host; decrypt-and-list verification; upload with `coscli`, else `tccli cos`, else a loud warning; local retention prune |
| `restore.sh` | Checks the archive decrypts **before** deleting anything; stops both services; empties `/data`; unpacks; promotes the consistent snapshot over `agentforge.sqlite` and drops the stale `-wal`/`-shm`; starts back up |
| `logs.sh` | Prints container health, then follows logs for one or both services |
| `components.sh` | Phase 7. `status` / `check` / `install` against the running container, through `dc exec -T app ./node_modules/.bin/tsx ../../scripts/components.ts` (`webapp-deploy/scripts/components.sh:54-55`). Nothing here reaches the install HTTP route, which answers `403 install_disabled` on a server for every caller |

Failure modes worth knowing: `deploy.sh` exits non-zero and dumps 80 log lines if health does not go
green in five minutes; `backup.sh` refuses to run at all with an empty `BACKUP_KEY` rather than writing
a plaintext archive; `restore.sh` is destructive and prompts unless given `--yes`.

## Where things live

| File | Role |
|---|---|
| `webapp-deploy/README.md` | The folder's own reference: image contents, the proxy arrangement, transport filtering, the security group, the before-traffic acceptance list, the incident runbook, the restore drill, and *What is not done yet* |
| `webapp-deploy/Dockerfile` | The four-stage image (base, build, prod, runtime). Build context is the repo root |
| `webapp-deploy/.dockerignore` | A byte-for-byte copy of the next file, not read by the documented builds (`scripts/pilot-deploy.test.mjs` fails if the two differ; SR-94) |
| `webapp-deploy/Dockerfile.dockerignore` | The name BuildKit actually reads for `Dockerfile`, because the Dockerfile is not at the context root. Since 2026-10-01 it also excludes `webapp-deploy/k8s`, `*.env` and `.pilot-local`, and since 2026-10-05 `nultron-files` (SR-131) |
| `webapp-deploy/portal.Dockerfile`, `portal.Dockerfile.dockerignore`, `portal-entry.sh` | *(pilot)* The portal image, its allowlist context, and the DSN wrapper baked into it |
| `webapp-deploy/compose.yml` | `app`, `proxy`, `portal`, `portal-db`, `portal-prepare`; hardening, limits, published ports, named volumes. `scripts/release-web.mjs` `composeFile()` generates the released twin; `scripts/pilot-deploy.test.mjs` compares them |
| `webapp-deploy/compose.local.yml`, `pilot-local.mjs` | *(pilot)* The local rehearsal: loopback ports, a throwaway CA, Mailpit with implicit TLS, `up` / `drive` / `down` |
| `webapp-deploy/Caddyfile` | TLS for two names, the security header block, two filtered JSON log streams, the billing block, two `reverse_proxy`s, and a text-only `encode` match on both sites (no `text/event-stream`, `video/*` or `audio/*`; `packages/host/src/caddy-encode.test.ts` pins it) |
| `webapp-deploy/.env.example`, `portal.env.example` | The app's env (every var the host reads) and the portal's (signing key, database passwords, Tencent SES login) |
| `webapp-deploy/DEPLOY-LOG.md` | date / sha / env / who / notes. Mirrors the log in `../web-pivot-2026-09-18.md`, which is the one of record |
| `webapp-deploy/scripts/_common.sh` | Shared helpers. Sourced, not run |
| `webapp-deploy/scripts/{build,deploy,backup,restore,logs,components}.sh` | As above |
| `../tencent-cvm-setup.md` | The step-by-step runbook for a fresh CVM |
| `../web-data-placement-tencent.md` | Which Tencent service holds which data; sizing; the price tables |
| `../web-security-spec.md` | The numbered rows (`N2`, `S2`, `H2`…) this folder keeps citing |

## Gotchas

- **Three ignore files, and only two are read.** BuildKit looks for `<dockerfile-path>.dockerignore`
  before `<context>/.dockerignore`. The Dockerfiles live in `webapp-deploy/` and the context is the repo
  root, so the files Docker actually reads are `Dockerfile.dockerignore` (the app image) and
  `portal.Dockerfile.dockerignore` (the portal image, an allowlist). `.dockerignore` is read by nothing in
  the documented builds; it is a byte copy of `Dockerfile.dockerignore`, pinned by
  `scripts/pilot-deploy.test.mjs` (SR-94), so an edit goes into both. Editing only the unread one
  silently does nothing, and the context goes from small to several GB (about 1.4 GB, plus the 4.5 GB
  `nultron-files/` before SR-131).
- **Never restart or recreate `app` alone *(pilot)*.** `proxy` shares its network namespace, so after
  `restart app`, `up -d app` or `up -d --force-recreate app` Caddy sits in a namespace that no longer
  exists and the site is down while the app reports healthy. `restart app proxy`, or a full `up -d` with
  no service names (which recreates the proxy), repairs it. Driven 2026-10-01.
- **The image holds production dependencies only, and `tsx` is one (SR-113).** `tsx` is the production
  entrypoint and every `@agentforge/*` package exports TypeScript source rather than a build, so `tsx`
  moved from `devDependencies` to `dependencies` of `@agentforge/web` (`apps/web/package.json:20`), and the
  `prod` stage installs with `--prod` (`Dockerfile:113`) instead of the runtime copying the full install.
  The cost: a server-side import of a devDependency no longer resolves by luck. `apps/web/server.ts`
  imports `vite` dynamically, on the non-production branch only (`:114`), and the load check
  (`Dockerfile:145-147`) fails the build if the server imports anything else the tree lacks.
  `scripts/audit-deployed.mjs` audits the same production closure (`LIST_ARGS`, `:55`), and
  `scripts/audit-deployed.test.mjs` fails if the Dockerfile's `--prod` install and the script drift apart.
- **The proxy must not rewrite `Host` or `Origin`.** With `AGENTFORGE_SERVER=1` a mutating `/api` call
  needs both to match `AGENTFORGE_TRUSTED_ORIGINS`. Caddy passes them through by default, which is why
  the `Caddyfile` deliberately has no `header_up Host` line — the loopback-rewriting config an older
  deployment would have used now turns every write into `403 origin_forbidden`
  (`Caddyfile:115-131`).
- **`X-Forwarded-For` is read last-hop-first.** The per-IP rate bucket keys on the **last** entry,
  because a client can send its own header and an appending proxy leaves the forged value first. That
  holds only while this Caddy is the only thing in front of the app. Putting a CDN or load balancer
  ahead of it means declaring its ranges in `trusted_proxies` **and** revisiting the last-hop rule
  (`Caddyfile:91-113`).
- **Rate limiting is not in this folder.** The official `caddy:2.11-alpine` image ships no rate-limit
  module, so the buckets live in the app (`packages/host/src/rate-limit.ts`). See
  [`hosted-server-mode.md`](hosted-server-mode.md).
- **`noexec` on `/data` is correct since Phase 7, and was not before it.** The app used to install
  native modules into `/data/components` and load them from there. It now refuses to load one out of
  `AGENTFORGE_DATA_DIR` in server mode at all (`packages/host/src/components/paths.ts:101-103`,
  `downloadedComponentsAllowed`), and what it does load lives on the separate
  `/opt/agentforge/components` volume, which must stay executable. The code side of spec `H3` is
  therefore closed; the mount flag itself is still an operator action on the CVM
  (`compose.yml:77-86`, `../tencent-cvm-setup.md` §4).
- **`deploy.sh` builds on the production server.** `scripts/release-web.mjs` now builds the app and
  portal images from a sha and pushes them private to ghcr (*pilot*; dry run and unit tests only, never
  run for real), and the released bundle pulls them; but `deploy.sh` still builds in place from a
  checkout — and the build stage's `apt-get` goes to `deb.debian.org` over plain HTTP, which collides
  with the outbound-443-only security group rule (`webapp-deploy/README.md`, *Security group rules*).
- **Rolling code back is a rebuild at an older sha** on the source path; on the released bundle it is the
  previous release tag's `compose.yml`.
- **`caddy-data` is not the app's `/data`.** The proxy's `/data` volume holds the ACME account and the
  issued certificates; they are different volumes in different containers (`compose.yml:123-126`).
- **`restore.sh` hands three capabilities back.** `cap_drop: ALL` takes `CHOWN` away even from root,
  and both `tar -x` and the chown need it, so the one-shot restore container re-adds `CHOWN`,
  `FOWNER` and `DAC_OVERRIDE`.
- **ffmpeg and ffprobe are in the image since 2026-10-06 (`5bec532`).** The `ffmpeg` stage of
  `webapp-deploy/Dockerfile` downloads BtbN's static GPL build `n8.1.3-9-g29e619e767` for the image's CPU, pinned
  by sha256, and the runtime stage copies both programs to `/usr/local/bin` with the licence text. Debian's own
  package (5.1) is below the host's minimum of 6, so there is no `apt-get` route. Every run gets an input
  whitelist, a format gate and hosted timeout caps (`packages/host/src/edit/ffmpeg/input-safety.ts`, in the tree
  after `5bec532`). Record: security register SR-135 and `docs/internal/ffmpeg-attribution.md`.

## Verify

Nothing under `.cursor/skills/verify-agentforge/features/` drives this folder: the verify skill's
surfaces are webdev `:3000` and the packaged desktop, and there is no hosted-environment surface in it
yet (`.cursor/skills/verify-agentforge/SKILL.md`, *Surfaces*). This folder is proved by deploying it
and walking the first-run checks in [`../tencent-cvm-setup.md`](../tencent-cvm-setup.md) §9, and then
by the before-traffic acceptance list in `webapp-deploy/README.md`, signed in `DEPLOY-LOG.md` with the
sha that passed.

**(pilot)** What does drive this folder, on a developer machine: `node webapp-deploy/pilot-local.mjs up`
then `drive` (headless Chromium signs in through the portal with the e-mailed code, restarts the app and
proxy, forces an upstream error on a sign-in URL, and searches both Caddy log streams, the app's and the
portal's for the code and state that really went through; 22 checks, 2026-10-01), `down --purge`. Static
checks: `node --test scripts/pilot-deploy.test.mjs scripts/release-web.test.mjs`. It is a rehearsal, not a
deploy: nothing on a Lighthouse box has been driven.

The closest feature file for the app's own side of the hosted rules is
`.cursor/skills/verify-agentforge/features/security.md`.

## Why

- **The proxy shares the app's network namespace rather than using a bridge.** *Claim:* it was the
  only way to front the app without editing `server.ts`, and it is kept now for tested-ness rather
  than necessity. *Source:* the folder is documented as additive and as not editing `apps/`
  (`webapp-deploy/README.md:8-10`); `BIND_HOST` landed later, in Phase 1
  (`../web-migration-plan.md`, Phase 1), and `apps/web/lib/bind-host.ts:17-27` now allows a
  non-loopback bind in server mode. *Confidence:* `[Supported]` — the original constraint is documented
  and the current capability is in the code; that the arrangement is *kept* for test coverage rather
  than changed is the reading this page takes, not a recorded decision.
- **SQLite on one server, backed up hourly, rather than a managed database.** *Claim:* it is what the
  code runs today and it meets a 1-hour RPO with no new code; Postgres waits for tenancy.
  *Source:* [`../web-data-placement-tencent.md`](../web-data-placement-tencent.md) §3, *Why SQLite
  first*, plus the explicit throw on a `postgres://` URL at `packages/db/src/vault-key.ts:25`.
  *Confidence:* `[Direct]`.
- **Backups are encrypted on the host before upload.** *Claim:* a leaked COS bucket must not be a
  leaked database. *Source:* security spec row `S6`, cited in `webapp-deploy/scripts/backup.sh`'s own
  header and in `webapp-deploy/README.md`, *Back up*. *Confidence:* `[Direct]`.
