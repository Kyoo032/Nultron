# Nultron Enterprise on Kubernetes

> **New deploy path (owner request, 2026-10-01).** The documented way to run the hosted app is still
> one Docker host with [`../compose.yml`](../compose.yml) and [`scripts/release-web.mjs`](../../scripts/release-web.mjs).
> Rizky asked to try Kubernetes first, on his own machine, before anything is published to the web
> app. This folder is that: manifests, plus a rehearsal on Docker Desktop's built-in cluster that is
> reachable on **localhost only**. It adds a way to deploy; it was written without touching `apps/`,
> `packages/` or the Dockerfile. **Later the same day (owner decision, 2026-10-01) Phase 0 went to the
> compose stack instead**, see [Phase 0 pilot](../README.md#phase-0-pilot-compose); that work moved the
> portal Dockerfile out of this folder to `../portal.Dockerfile` (one copy, built by the release script),
> and the Caddy files here gained the default-logger filter and the billing block.
>
> **What is proven and what is not is in [What is proven](#what-is-proven) and [What is not done](#what-is-not-done).**
> `overlays/production` is **not applied and not proven**.

## What runs

```
                      kubectl port-forward (127.0.0.1:8443 only)
                                     |
   namespace nultron                 v
  ┌──────────────────────────────────────────────────────────────────────────────────┐
  │ Service nultron-edge  443 -> 8443                                                 │
  │ ┌─ Pod nultron-app  (1 replica, Recreate) ─────────────────────────────────────┐ │
  │ │  caddy sidecar :8443  ── TLS, CSP/HSTS/Permissions-Policy, JSON log filter    │ │
  │ │      │ nultron.localhost        -> 127.0.0.1:3000   (the app, loopback only)   │ │
  │ │      │ portal.nultron.localhost -> nultron-portal:4000                         │ │
  │ │  app container  tsx server.ts, uid 1000, read-only root, /tmp emptyDir         │ │
  │ │      PVC nultron-data -> /data      PVC nultron-components -> /opt/agentforge/ │ │
  │ └───────────────────────────────────────────────────────────────────────────────┘ │
  │ Deployment nultron-portal (1 replica)  ── initContainer prepare-db, then the portal │
  │      │ StatefulSet nultron-portal-db (postgres:16, PVC)    two roles, no superuser   │
  │      │ Deployment mailpit (LOCAL ONLY)   STARTTLS, inbox read over the API server    │
  │ CronJob nultron-backup (suspended)  VACUUM INTO + tar + openssl -> PVC nultron-backups │
  └──────────────────────────────────────────────────────────────────────────────────┘
```

Why one app replica and `Recreate`, stated once: the app is a single process by design. SQLite allows
one writer and its file must be on a block volume; the portal refresh is single-flight in memory
(SR-66); the rate limiters are in memory (SR-29); a new process fails the old one's running Edit
jobs. Do not raise `replicas`, add an HPA or switch to `RollingUpdate`. The portal is also one
replica, for its rate-limit windows (SR-29).

Why the app is probed with `exec`, not `httpGet`: the app binds `127.0.0.1` on purpose (the proxy
shares the pod's loopback, so nothing else can reach it, [`../README.md`](../README.md) "The loopback
bind"), and a kubelet HTTP probe goes to the pod IP. The probe is the image's own `HEALTHCHECK`:
`GET /healthz` on loopback, answered before routing, never opening the database.

## Layout

```
webapp-deploy/k8s/
├─ README.md
├─ base/                       what every overlay shares (kustomize)
│  ├─ kustomization.yaml       generators for the env and config maps
│  ├─ namespace.yaml           nultron, Pod Security "restricted" enforced
│  ├─ app.yaml                 Deployment (app + caddy) and Service nultron-edge
│  ├─ portal.yaml              Deployment (prepare-db init + portal) and Service
│  ├─ postgres.yaml            StatefulSet + Service for the portal database
│  ├─ storage.yaml             PVCs nultron-data, nultron-components, nultron-backups
│  ├─ backup-cronjob.yaml      encrypted backup, suspended
│  ├─ networkpolicy.yaml       default-deny ingress + the four allows
│  ├─ caddy/                   Caddyfile, security.caddy (headers, log filter), site-tls.caddy (ACME)
│  └─ scripts/                 prepare-db.mjs, snapshot.mjs, encrypt.sh (mounted from ConfigMaps)
├─ overlays/
│  ├─ local/                   Docker Desktop: Mailpit, a throwaway CA, hostAliases, local images
│  └─ production/              Tencent TKE. NOT APPLIED, NOT PROVEN
├─ rehearse-local.mjs          build, apply, seed, forward
├─ teardown-local.mjs          delete the namespace (and its volumes)
├─ forward-local.mjs           the loopback port-forward, restarted when it drops
├─ local-lib.mjs, local-images.mjs   shared helpers: safe build snapshot, secrets, CA
└─ k8s-rehearsal.test.mjs      node --test webapp-deploy/k8s/k8s-rehearsal.test.mjs
```

## Run the rehearsal

Needs Docker Desktop with **Settings > Kubernetes > Enable Kubernetes** on (context `docker-desktop`),
`kubectl`, Node and `openssl` (Git for Windows ships one; the script finds it).

```sh
node webapp-deploy/k8s/rehearse-local.mjs                 # first run: builds both images, a few minutes
node webapp-deploy/k8s/rehearse-local.mjs --skip-build    # re-apply without rebuilding
node webapp-deploy/k8s/rehearse-local.mjs --email me@example.test
node webapp-deploy/k8s/teardown-local.mjs                 # delete the namespace AND its volumes
node webapp-deploy/k8s/teardown-local.mjs --purge-local-files   # also delete secrets.env, pki/, .local/
```

It prints the URL when it is ready: **https://nultron.localhost:8443**. Chrome, Edge and Firefox
resolve any `*.localhost` name to `127.0.0.1` themselves; `curl` needs `--resolve` or a hosts line on
some systems. The certificate is signed by a throwaway CA, so the browser warns once. Do not trust
that CA system-wide.

Sign-in sends the one-time code to **Mailpit**, not to a real inbox. Read it with
`kubectl --context docker-desktop -n nultron port-forward svc/mailpit 8025:8025` and open
`http://127.0.0.1:8025`. The default account is `tester@nultron.test` (`--email` to change it).

`kubectl port-forward` follows one pod, so it ends when the app pod is replaced.
`forward-local.mjs` (started detached by the rehearsal) starts it again; `node webapp-deploy/k8s/forward-local.mjs --stop`
ends it. `kubectl` is always run with `--context docker-desktop`, so your current context is never
touched.

### What the script does, in order

1. Preflight: the `docker-desktop` context answers and every node is Ready; Docker and `openssl` work.
2. Generates `overlays/local/secrets.env` (gitignored; see [Secrets](#secrets)) and `overlays/local/pki/`
   (gitignored; a throwaway CA and two leaf certificates) once. A re-run keeps both.
3. Builds `nultron-ent:local-<sha>-dirty` and `nultron-portal:local-<sha>-dirty` from a **safe
   snapshot**, never pushing them ([Images](#images)).
4. Writes `.local/overlay/kustomization.yaml` (gitignored: the local overlay plus this build's two image
   tags) and runs `kubectl apply -k` on it.
5. Waits for Postgres, Mailpit, the portal and the app. The portal pod's `prepare-db` init container
   waits for Postgres, runs the migrations as the schema owner, then gives `portal_app_login` its
   password as a SCRAM verifier (the plaintext never reaches the server).
6. Seeds one tenant (`nultron`), one org and one account with the portal's seed. The seed prints the
   app's OAuth client secret **once**; the script stores it in `secrets.env`, re-applies and restarts the
   app on it. Until then the app boots on a placeholder, which is enough for it to start.
7. Starts the loopback forward and checks `GET /healthz` through Caddy, **verifying the certificate
   against the throwaway CA** rather than skipping verification.

## Images

- **App:** `webapp-deploy/Dockerfile`, unchanged.
- **Portal:** [`../portal.Dockerfile`](../portal.Dockerfile), the one copy: it moved here from
  `k8s/images/` on 2026-10-01 so that `scripts/release-web.mjs` and the compose pilot build the same
  image. Its context is an allowlist, [`../portal.Dockerfile.dockerignore`](../portal.Dockerfile.dockerignore),
  so it can be built from the whole repo and still holds only the manifests, `apps/portal`, the portal's
  SQL migrations and two scripts (`portal-entry.sh`, and this folder's `base/scripts/prepare-db.mjs`, which
  the compose stack runs from the image). **The task's first choice, running
  the portal from the app image, does not work**, and this is a finding, not a preference: the app
  image is installed with `pnpm install --filter "@agentforge/web..."`, the portal is not one of the web
  app's dependencies, so the image carries `apps/portal`'s source (SR-49) but not its `node_modules`.
  `tsx src/main.ts` there fails with `ERR_MODULE_NOT_FOUND: Cannot find package 'nodemailer' imported
  from /app/apps/portal/src/mail/smtp.ts`. The portal image installs `--filter "@agentforge/portal..."`
  and nothing else.

**The build context is never the checkout.** `local-images.mjs` copies only `git ls-files -co
--exclude-standard` (tracked, plus untracked-and-not-ignored) into a temp directory, so a git-ignored
`.env`, a webdev data dir with its `.master-key`, or `apps/web/.env.local` cannot enter an image layer
(SR-49, half 2: the reason `scripts/release-web.mjs` builds from `git archive <sha>`). It also refuses to
build if an *untracked, un-ignored* file has a secret-looking name (`.env*`, `*.key`, `*.pem`, `*.enc`,
`*.sqlite*`, `.master-key`, a `pki/` folder, `secrets.env`), and it prints which untracked folders will be
in the image. The tag says `dirty` because the snapshot is an uncommitted working tree: **these images
are not release artifacts and are never pushed.** The release path stays `release-web.mjs` from a sha.
The portal image gets a narrower context still: the workspace manifests, `apps/portal`, and
`docs/internal/portal/migrations`.

If you rebuild without committing, the tag does not change but the image id does; the script restarts
the two Deployments when it sees that.

## Secrets

Never committed. The local overlay's `secretGenerator` reads `overlays/local/secrets.env`, which is
**gitignored** (`git check-ignore -v webapp-deploy/k8s/overlays/local/secrets.env` names the rule), and
so are `pki/` and `.local/`. [`overlays/local/secrets.env.example`](overlays/local/secrets.env.example)
lists every name. The rehearsal generates the values:

| Name | How it is made | Used by |
|---|---|---|
| `AGENTFORGE_SECRETS_KEY` | 32 random bytes, hex | app (the wrap key; a new one cannot read old data) |
| `AGENTFORGE_BILLING_WEBHOOK_SECRET` | 32 random bytes, hex | app (required on production) |
| `AGENTFORGE_PORTAL_CLIENT_ID` | `nultron-web`, the seed's default for tenant `nultron` | app |
| `AGENTFORGE_PORTAL_CLIENT_SECRET` | the seed's one-time output | app |
| `PORTAL_SIGNING_KEY` | 32 random bytes, base64url (an Ed25519 seed) | portal |
| `PORTAL_POSTGRES_PASSWORD` | 24 random bytes, base64url | Postgres, portal (schema owner) |
| `PORTAL_APP_DB_PASSWORD` | 24 random bytes, base64url | portal (`portal_app_login`) |
| `BACKUP_KEY` | 32 random bytes, base64url | backup CronJob |

One Secret object, **per-key** `secretKeyRef` in each container, so the app container gets four names
and no database password, the Caddy container gets none (SR-73), and the portal gets its own. The
Secret has a stable name, so changing a value does not restart the database; the script restarts the
Deployment that needs it. Kubernetes Secrets are base64, not encryption: on a real cluster turn on
etcd encryption or use an external secret manager.

## Local versus production

Every place the local overlay differs from the production one, and why:

| | Local | Production | Why they differ |
|---|---|---|---|
| Images | `nultron-ent:local-<sha>-dirty`, `nultron-portal:local-<sha>-dirty`, `IfNotPresent`, never pushed | `ghcr.io/kyoo032/nultron-ent:<ent-tag>` plus a private portal image, `ghcr-pull` registry secret | A rehearsal builds from an uncommitted tree; a release builds from `git archive <sha>` and the image stays private (SR-49). `release-web.mjs` builds and pushes the portal image (`ghcr.io/kyoo032/nultron-portal:<tag>`) with the app image since 2026-10-01; nothing here has pulled it. |
| Site names | `nultron.localhost`, `portal.nultron.localhost` on port 8443 | real DNS names on 443 | `*.localhost` needs no DNS. A `nultron.` parent rather than bare `localhost`, so the HSTS header Caddy sends (`includeSubDomains`) cannot pin `localhost` in your browser and break `http://localhost:3000` webdev. |
| TLS | a throwaway CA; Caddy loads a certificate file | Caddy ACME on `NULTRON_DOMAIN` and `PORTAL_DOMAIN`, state on a PVC | Let's Encrypt cannot issue for `.localhost`, and under `NODE_ENV=production` the app must reach the portal over https (SR-26), so the app and the portal also trust the throwaway CA (`NODE_EXTRA_CA_CERTS`). **The task asked for `tls internal`**: Caddy's own CA would sit in the proxy's private storage, and neither the app nor the portal could trust it at start-up. |
| App to portal | `hostAliases` map `portal.nultron.localhost` to the pod's own loopback, where Caddy listens | the public portal name; how a pod reaches it through the CLB is **not proven** | `*.localhost` does not resolve inside a pod. |
| Mail | Mailpit in the cluster, STARTTLS with the throwaway CA's certificate | a real provider on 587 (STARTTLS) or 465, login from the Secret | The portal refuses a cleartext loopback sandbox and refuses to send a code in the clear in production (SR-39), so even the sandbox has to speak STARTTLS. |
| Exposure | `kubectl port-forward` on 127.0.0.1:8443 | a `LoadBalancer` Service, CLB in TCP passthrough, `externalTrafficPolicy: Local` | Docker Desktop publishes NodePort and LoadBalancer Services on the host's interfaces, which can include the LAN (not measured here). A port-forward binds loopback. |
| Storage | the cluster's default class (Docker Desktop `hostpath`), 10 / 1 / 5 GiB | CBS `nultron-cbs-ssd`, `WaitForFirstConsumer`, `Retain`, 200 / 20 / 50 GiB | Production disks are zone-bound block volumes; SQLite must not sit on a network filesystem. |
| Sizing | 3 GiB / 4 CPU limit on the app | 10 GiB / 7 CPU on a 16 GB node | Fits a 4-8 GB node. |
| Caddy data | emptyDir | PVC | An emptyDir would re-issue certificates on every restart. |
| Secrets | generated here, gitignored | filled from a secret manager, never generated on a laptop | The wrap key must be generated once and kept for the life of the data. |
| Postgres | in-cluster StatefulSet | the same, or a managed database via `PORTAL_DB_HOST`/`PORT`/`OWNER` and deleting `postgres.yaml` | The deck proposes TencentDB; that is a config change, not a manifest rewrite. |
| NetworkPolicy | applied; enforcement depends on the cluster's network plugin | the same | See [What is not done](#what-is-not-done). |

## Backups

`nultron-backup` is a CronJob, **suspended**. It uses the same recipe as
[`../scripts/backup.sh`](../scripts/backup.sh) so [`../scripts/restore.sh`](../scripts/restore.sh)'s
archive layout and cipher still apply (`tar | openssl enc -aes-256-cbc -pbkdf2 -iter 200000`, the snapshot
promoted from `.backup-staging/`): an init container in the app image takes the consistent
`VACUUM INTO` copy (the app image has no `openssl`), and the main container tars and encrypts it onto the
`nultron-backups` volume. Run one now with
`kubectl --context docker-desktop -n nultron create job --from=cronjob/nultron-backup backup-now`.
**Upload to object storage (COS) is not done**: neither image carries `coscli`. A backup on the same
cluster is not a backup against losing the cluster. A restore into Kubernetes is not written either:
`restore.sh` drives Docker Compose.

## Production overlay: what is unproven

`overlays/production` renders (`kubectl kustomize`) and nothing more. Every one of these is a guess
until it meets a real TKE cluster: the CBS provisioner name and `diskType` value; the CLB annotations
(deliberately not written); whether `externalTrafficPolicy: Local` keeps the client address with this
node pool (without it every visitor shares one rate-limit bucket); ACME behind a CLB with Caddy on
8443/8080 (it needs ports 80 and 443 to reach the pod); how the app reaches the portal's public name
from inside the cluster; the portal image (`release-web.mjs` now builds and pushes it, undriven); the registry pull secret.
It also inherits every open row in the security register's "Must be true before the Tencent Cloud
deploy" list.

## Tests

```sh
node --test webapp-deploy/k8s/k8s-rehearsal.test.mjs
```

It pins that the Caddy header block cannot drift from the reviewed [`../Caddyfile`](../Caddyfile), that
the snapshot guard refuses secret-looking files, the shapes of the generated secrets, the SCRAM
verifier format, and the app pod's single replica / `Recreate` / read-only / loopback invariants. It
does not need a cluster.

## What is proven

Driven on Docker Desktop's built-in cluster (Kubernetes v1.34.1, one `docker-desktop` node, Docker
runtime) on 2026-10-01, from a cold start (namespace deleted, then `rehearse-local.mjs`), against the
final manifests in this folder:

- All four workloads came up `Running` and `Ready` (app + Caddy sidecar 2/2, portal, Postgres, Mailpit).
  `GET /healthz` through Caddy answered 200 with the certificate **verified** against the throwaway CA.
- A signed-out visit shows the sign-in screen (`auth-signin`), not the paste-your-key onboarding
  (SR-06, driven in headless Chromium). Pressing `auth-signin-start` goes to the portal, the portal
  e-mails a six-digit code to Mailpit over STARTTLS, and entering it lands back on the app with a
  session and no `code` or `state` left in the address bar. The portal's browser pages and its
  token exchange with the app run over https under `NODE_ENV=production` on both sides.
- Headers through Caddy on the app host: the Content-Security-Policy, `Strict-Transport-Security`, and
  `Permissions-Policy` of the reviewed Caddyfile, and no `Server` or `X-Powered-By`.
- Deleting the app pod: the ReplicaSet replaced it in about 11-13 s. The same browser, with the cookies
  it already held, was still signed in, and a desk created before the restart was still listed. So
  sessions and data survive on the volume.
- The portal boots in production mode as `portal_app_login` (a plain member of `portal_app`, no
  superuser, no `BYPASSRLS`) while the schema owner runs the migrations (SR-56). Its one-time client secret was
  stored and the app restarted on it by the script.
- The backup CronJob, run once by hand: a consistent snapshot, an encrypted archive whose
  decrypt-and-list was repeated from an independent pod, and a wrong key that does not open it.
- Hardening as running, not as written: uid 1000, a read-only root filesystem (`touch` fails), every
  capability dropped from the app container, `NoNewPrivs`, the proxy container's environment holding
  `NULTRON_DOMAIN` and nothing secret (SR-73), the app container holding no database password.
- Exposure: the only listeners the rehearsal opens on the host are `127.0.0.1:8443` and `[::1]:8443`
  (the port-forward). No tunnel, no NodePort, nothing on the LAN.
- Idle, the five containers together used about 385 MiB.

### What the rehearsal found (and the manifests now do)

1. **The portal cannot run from the app image.** `ERR_MODULE_NOT_FOUND: nodemailer`. It has its own image.
2. **An overlay's `namespace:` is its own.** The base's reached only the base's resources: the first run
   put the generated Secrets, Mailpit and the CA ConfigMap in `default`. Both overlays now set it; a test
   pins it.
3. **Caddy will not start with every capability dropped**, even on an unprivileged port: the official
   binary carries a file capability (`exec /usr/bin/caddy: operation not permitted`). It gets
   `NET_BIND_SERVICE` back, as in compose.
4. **An init container that "succeeded" having done nothing.** A ConfigMap volume mounts a file as a
   symbolic link, Node reports `import.meta.url` as the real path, and a `main` guard comparing it to
   `argv[1]` was false, so the script exited 0 silently and the portal then failed to log in to its
   database. The guard resolves the real path now; a test runs the script through a symlink.
5. **The sign-in code was in the access log.** The portal sits behind the same Caddy here, and its 302
   `Location` is `https://<app>/auth/callback?code=...&state=...`, which Caddy logs in the response headers.
   The reviewed filter covers the request URI and the Referer only. `security.caddy` filters
   `resp_headers>Location` too and the log was re-read after a sign-in (no `code=` or `state=` left). The
   reviewed `webapp-deploy/Caddyfile` now carries the same filter (2026-10-01), because the compose pilot puts the
   portal behind it too, plus a filter on Caddy's default logger, where a failed upstream request's error line
   names the request with its full URI (SR-72). Both are imported from one `sign_in_filters` snippet in each file,
   and `scripts/pilot-deploy.test.mjs` fails if the two copies drift.
6. **A stale client secret after a teardown.** Teardown keeps `secrets.env`, and a wiped portal database
   makes the seed mint a new client; the script now stores whatever secret the seed prints.
7. **Two forward supervisors** on a re-run: the supervisor now refuses a second one.

### Product behaviour the rehearsal ran into (decided and changed 2026-10-01)

After a successful portal sign-in the host's gateway gate still reads `needs_key` / `allowed: false`
(`deriveGatewayGate` treats a keyless hosted tenant as closed, `packages/host/src/gateway-gate.ts:288-296`),
and `resolveGate` branched on `allowed` alone, so the app showed the three-step welcome whose second step
asks for a gateway key, and `/research`, `/documents` and the rest showed the same screen. There was no way
to open a mode without pasting a key.

**The owner decided (Rizky, 2026-10-01): "on the onboarding they can choose to put the API key later."**
That is built, hosted only. The key step offers **Add it later** next to Check this key; the host remembers
the choice per person (`POST /api/v1/settings/key-later`); `resolveGate` opens a closed gate only for a
signed-in hosted person who made it; and every pane says a key is missing, with a link to Settings, instead
of failing. The host's gate and every `403 gateway_blocked` are untouched, so no model call can be made
without a key. The Personal app is unchanged. What it is and how it was proven is
[`docs/internal/maps/settings-and-gateway-gate.md`](../../docs/internal/maps/settings-and-gateway-gate.md),
"Add the key later (Enterprise only)". Driven on this cluster on 2026-10-01 in headless Chromium: the
sign-in, the welcome, the key step with the button, the choice (one `POST /api/v1/settings/key-later`,
200), Chat and six more modes (Research, Documents, Market, Legal, Images, Meeting) in their needs-key state with no red error banner, a reload that does not
show the welcome again, Settings with the key form and "No key saved", the Indonesian copy, and a raw call
to a gateway-calling route still answering `403 gateway_blocked`. The page made no call to a model route.

## What is not done

- The production overlay (above).
- **The desk a tenant sees after pasting a real key was not driven in the cluster.** "Add it later"
  (see "Product behaviour" above) opens every mode, but in its needs-key state; no key was pasted, so no
  mode was driven end to end and no model call was made.
- **NetworkPolicy is applied but not enforced on Docker Desktop.** A pod in another namespace reached
  Postgres, the portal and both Mailpit ports through the default-deny and allow policies, so those
  policies are untested here and prove nothing about isolation. Egress is not restricted at all.
- Caddy advertises HTTP/3 (`Alt-Svc: h3=":8443"`) but the Service carries TCP only. compose publishes
  `443/udp`; a production Service would add a UDP port, or Caddy would be told `protocols h1 h2`. Not
  decided, not driven.
- `kubectl port-forward` follows one pod. After the app pod is replaced there is a 2-3 s gap while
  `forward-local.mjs` restarts it; a request in that gap is refused.
- Once in about a dozen sign-ins the browser driver did not find the code e-mail within 60 s although the
  portal had logged `mail_sent` and Mailpit held the message. Not reproduced and the cause was not found
  (the driver's search, not the portal's send, is the likelier side).
- `/data` is not mounted `noexec`. A PVC cannot express mount options; on TKE it would be the
  StorageClass `mountOptions`, and the `nultron-components` volume is separate so that this is possible
  (spec H3). An emptyDir `/tmp` is not `noexec` either, unlike compose's tmpfs.
- Backups: no COS upload, no restore into Kubernetes, no restore drill.
- No HorizontalPodAutoscaler, on purpose (one replica).
- ffmpeg is not in the image (a deck decision), so the Edit desk degrades.
- Postgres traffic inside the cluster is not TLS.
- No model call was made: the test tenant has no gateway key, and with "Add it later" the desk still
  refuses every call that would need one.
- Hosted onboarding still shows the document-reader / ffmpeg set-up panel and the sentence "It stays on this
  computer" under the key field. Both were written for the desktop and read oddly on a hosted tenant. Not
  changed here.
