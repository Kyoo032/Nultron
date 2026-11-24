# Map — Hosted security controls

Product: both · Instance: hosted (review :3443 for live proof; no :3000 drive)

Last verified: 2026-11-24 on `main`, for Caddy `?Content-Security-Policy` default-if-absent sandbox preservation (`packages/host/src/security-headers.ts`, SR-132) and outbound `minVersion: "TLSv1.2"` (`safe-fetch.ts`). Before that: 2026-11-10 at fc855d7d (tester branch) for the `packages/host/src/http-adapter.ts` exports shared with the live voice WebSocket upgrade handler only (`transportRejection` at `http-adapter.ts:482`, `requestWorkspaceId` at `:538`, `hostRejection` at `:806`, `parseCookies` at `:120`, `FILTERED_EVENT` at `:72`, called by `packages/host/src/voice/upgrade.ts`; `header` and `FORWARDED_FOR_HEADER` stay private to `http-adapter.ts` and `upgrade.ts` has its own `header` at `:45`; see [`voice-mode.md`](voice-mode.md) and [SR-209](../security-register.md#sr-209)). Unit-tested in `packages/host/src/voice/relay.test.ts`; not driven on a hosted server. Nothing else on the page was re-read. Before that: 2026-11-09 at 6080cbba plus the working tree on `fix/safe-fetch-undici-fetch`, for § 7 (the default fetch of the SSRF guard) only; the `safe-fetch.ts` lines cited there were re-read and the guard was driven on Node 22.23.4 and 24.13.0 (SR-201). Nothing else on the page was re-read. Before that: 2026-11-09 at 6080cbba plus the working tree of `fix/desk-key-warn`, for the desk wrap-key check at the end of section 1 only (SR-203). Before that: 2026-11-06 at 39cd5f0c plus the working tree on `fix/request-array-caps`, for the request cost caps subsection of § 5 and its file row only; nothing else on the page was re-read. Before that: 2026-11-06 at f6c9acc1 for the desk wrap-key check at the end of section 1 only (SR-203). Before that: 2026-11-06 at 30f92eab for § 7 (the SSRF guard), the resolution gotcha and the `safe-fetch.test.ts` row only; the new code was read at the lines cited and driven once against a loopback listener and against real DNS and TLS (SR-201). Nothing else on the page was re-read. Before that: 2026-11-06 at 01a88fba, for the Host rule only (row 6a of the admission table and § 3; the other `http-adapter.ts` line numbers on this page are from 2026-09-23 and have shifted six lines below `:632`). Before that: 2026-10-09 at 9121f295 for the new Touches / Do not touch section only (file lists checked against the tree and the imports named there; nothing else re-read). Before that: 2026-10-06, branch `feat/hosted-run-limits` over 6105c5c, not committed, for the run-limits subsection of § 5 and its row in the file table; nothing else on the page was re-read. Before that: 2026-10-05, working tree over 0b61a29, not committed, for two lines only (the `audit-deployed.mjs` row of the file table and the audit-gate gotcha, which now describe the production closure after SR-113); nothing else on the page was re-read. Before that: 2026-10-02, working tree over 0b61a29, not committed, for one row (the operator-fields row of § 8, which now says who may write a provider key: M4, an owner or an admin, a member is answered `403 settings_key_forbidden`); nothing else on the page was re-read. Before that: 2026-10-01, working tree over 0b61a29, not committed, for two rows only: the `ci-local.mjs` row of the tests table (a vitest step now needs its `Tests N passed` summary, not just exit 0) and the per-tenant model cache bullet of § 10 (the background refill and its log line). Before that, the same day, for the new § 10 (where a tenant's provider key may go: Enterprise BYOK Phase A) and the corrected operator-keys row of § 8, whose "provider keys" claim was wrong before it (`requestsOperatorOnlySettings` lists `toolKeys`, `toolBackends` and `injectionGuardBypass` only). Nothing else on the page was re-read that day. Before that: 2026-09-23 at d4561b8 + working tree for sections 1-4 and every
`http-adapter.ts` citation on this page (the auth pass: the production https rule for the portal
URL, the malformed Host / request-target 400, the gate's portal re-check, digest session ids). The
response headers, the ffmpeg failure detail and the top-up link keep their 2026-09-21 reading at
4938747 ([SR-14](../security-register.md#sr-14), [SR-04](../security-register.md#sr-04)); anything
else was last walked on 2026-09-20 at `a053245`, on the Phase 4 branch.

## Overview

Everything that is true of a Nultron request on the hosted web app and not true of the same
request on a desk. One environment variable decides which of the two the process is, and roughly
a dozen controls hang off it: the session gate, CSRF, the Origin and Host allowlist, the
HTTPS-only refusal, three rate limiters, the response headers, error masking, and the routes that
are simply turned off.

The thing to hold onto: **`isServerMode()` is the whole switch, and it is read at the point of
use rather than captured once.** There is no `SecurityConfig` object, no middleware stack, no
registry of controls. Each control asks the environment itself. That makes the controls easy to
read one at a time and makes the switch a single point of failure, which is why
`apps/web/server/hosted-mode-guard.ts` exists to refuse a production build that answers `false`.

This page is the hosted perimeter: how a request is admitted and what a response carries, **as it
stands after the OWASP pass**. Four neighbouring pages own the parts it does not:

- [`hosted-server-mode.md`](hosted-server-mode.md) describes the same perimeter **as PR #56 built
  it**, commit by commit. Where the two disagree about a detail, this page is the newer reading —
  the OWASP pass changed several of these controls — but that page carries the history and the
  reasoning behind the original design, which is not repeated here.
- [`portal-session-auth.md`](portal-session-auth.md) owns the session itself: minting, verifying,
  refreshing and revoking. This page covers only where the gate sits in the admission order.
- [`pii-and-key-security.md`](pii-and-key-security.md) owns secrets at rest.
- [`settings-and-gateway-gate.md`](settings-and-gateway-gate.md) owns the gateway key gate.

Tenant scoping *inside* an admitted request is Phase 3's and is not described here.

## How it works

### 1. The switch

`packages/core/src/server-mode.ts:12` — `isServerMode(env = process.env)` is true when
`AGENTFORGE_SERVER` is set to `1`. `trustedOrigins` (`:52`) reads `AGENTFORGE_TRUSTED_ORIGINS`,
a comma-separated list normalised by `normaliseOrigin` (`:88`).

Three things pin the flag on for a real deployment, and check that the deployment behind it is
usable:

| Where | What it does |
|---|---|
| `webapp-deploy/compose.yml:44` | `AGENTFORGE_SERVER: "1"` under `environment:`, which beats `env_file:` — and `.env` is `required: false`, so it can be absent |
| `apps/web/server.ts:41` | `assertHostedModeCoherent(process.env)`, the first statement of `main()`, throws before `server.listen` if `NODE_ENV=production` and server mode is off |
| `apps/web/server.ts:45` | `assertHostedEnvComplete(process.env)`, the second statement, throws before `server.listen` when the server mode flag IS on but the environment behind it is not usable |

The second exists because the first only covers this compose file. A `NODE_ENV=production` build
that is not in server mode serves every `GET /api/v1/*` without a session **and passes its health
check**, because that is exactly how the desktop app is meant to behave.

The third exists because a *correctly* flagged server was still allowed to start with nothing
behind the flag. Every hosted variable was read at first use, so a container with no wrap key
answered `/healthz` (which routes before anything and opens no database), passed Caddy's active
check, and failed for the first person who signed in — `../security-register.md` SR-04. Since
2026-09-21 the check is `packages/host/src/hosted-env.ts`: in server mode it refuses to listen
unless `AGENTFORGE_SECRETS_KEY` passes `getLocalVaultKey`, at least one https origin survives
`trustedOrigins`, `AGENTFORGE_PORTAL_URL` passes `portalBaseUrl` → `assertAllowedEndpointUrl`, both
portal client credentials pass `portalClientCredentials`, an explicitly set `AGENTFORGE_PUBLIC_URL`
passes `publicBaseUrl`, and — on `NODE_ENV=production` only — `AGENTFORGE_BILLING_WEBHOOK_SECRET`
is set. Off production a missing billing secret is a startup warning instead. **It borrows every
rule from the code that will later enforce it and restates none**, which is the point: a second
copy of "what a good wrap key looks like" is how two answers to the same question appear. One rule
is added on top, and it is only ever stricter than the one it sits on: since 2026-09-23
([SR-26](../security-register.md#sr-26), owner decision) `AGENTFORGE_PORTAL_URL` must be https on
`NODE_ENV=production` even on loopback (`portalUrlProblem`, `packages/host/src/hosted-env.ts:128`),
while `tls.ts` keeps the loopback exemption for the desk and the review instance. A review instance
started with `-Production` and the default `http://127.0.0.1:<port>` portal URL now refuses to boot
until it is given an https portal origin. The
message names every broken variable at once and never prints a value. It lives in the host package
rather than in `apps/web` because those rules sit in three packages and `apps/web` can see only
two; `apps/web/server/hosted-mode-guard.ts:28` re-exports it so `server.ts` reaches both guards
through one module. Off server mode both calls return immediately. A third call, `warnWeakDeskVaultKey`
(`packages/db/src/vault-key.ts:178-187`, re-exported by `hosted-env.ts` and run from
`apps/web/server-env.ts` and `main()`), is the one check a desk meets: it warns once about an
`AGENTFORGE_SECRETS_KEY` under 32 bytes, refuses nothing and reads no file ([SR-203](../security-register.md#sr-203)).
Webdev and the e2e run set no key, so they are untouched, and `hostedEnvProblems` still returns an empty
list off server mode.

### 2. Admission — the order in `handleNodeRequest`

`packages/host/src/http-adapter.ts` is mounted as the **first** middleware in
`apps/web/server.ts`, above `express.static` and the vite middlewares, so the page, the built
bundles and every 404 probe pass through it before anything serves them. The order below is
load-bearing; if that mount ever moves, the controls move with it.

| # | Line | Control | Applies to |
|---|---|---|---|
| 1 | `:572` | `applySecurityHeaders(res, serverMode)` | every request, before any handler writes a header |
| 2 | `:584` | `mintRequestId()` → `X-Request-Id` | every request (header in server mode only) |
| 3 | `:612` | `transportRejection` — TLS, method allowlist, path filter, header cap, per-IP and per-session buckets | **every** request, not only `/api` |
| 4 | `:617` | a request target that will not parse → 400 `invalid_path`; a `Host` that is not `host[:port]` → 400 `invalid_host` | **every** request, in both modes (decided at `:556`, before the page / API split at `:562`) |
| 5 | `:624` | non-`/api` paths return `false`; Express serves the page | — |
| 6a | `:633` | `hostRejection` — loopback `Host` off server mode, allowlisted `Host` in server mode; a missing `Host` is refused | **every** method on `/api` (GET, HEAD and OPTIONS included), minus the billing webhook path; `/healthz` is answered before it |
| 6 | `:639` | `mutatingRejection` — Origin allowlist, double-submit CSRF, `x-agentforge-transport` | non-safe methods on `/api` |
| 7 | `packages/host/src/router.ts:456` | `gate` → `requireSessionFor` — the session row, then the portal re-check on a due session, before the route table | `/api` minus the exempt paths |
| 8 | `:706` | `logAuthFailure` | a 401 coming back out |
| 9 | `:495` | `maskServerError` | any 5xx, in server mode |

Step 3 covering non-`/api` traffic is the part people get wrong: the TLS rule, the method
allowlist and the per-IP bucket would otherwise be off for the bulk of the traffic. Only the
Origin / CSRF / session rules are API-only, because those are about a call the renderer makes
rather than about the hop it arrived on.

Step 4 is new on 2026-09-23. The path used to be parsed as `new URL(req.url, "http://" + Host)`,
so a malformed `Host` (`a b`, `[`, an empty value) or a target such as `//[` threw
`ERR_INVALID_URL` straight out of the adapter before any rule ran, and only `apps/web/server.ts`'s
`.then(…, next)` kept it from being an unhandled rejection. The target is now parsed against a
fixed base (`TARGET_PARSE_BASE`, `:150`; `requestTargetOf`, `:167`), so the `Host` never reaches the
URL parser, and `isMalformedHostHeader` (`:203`) judges the header on its own: empty, whitespace,
`/ \ ? # @`, or anything the URL parser refuses as an authority. An absent `Host` is not malformed
here — the mutating rules already refuse a write without one. In server mode the 400 comes after
the TLS rule and the buckets, so a malformed request is still counted and a plaintext one still gets
`https_required` first.

### 3. Origin, Host and CSRF

`hostRejection` (`packages/host/src/http-adapter.ts:778`, called at `:633`) runs for every `/api`
request, GET, HEAD and OPTIONS included (SR-207, 2026-11-06; before that only a mutating request was
checked, so a DNS-rebinding page could read the API). It answers 403 `forbidden` off server mode when
the `Host` is not loopback or is absent, and 403 `origin_forbidden` in server mode when it is not one of
the allowlisted origins' hosts. `/healthz` never reaches it (answered at `:620`), and the billing
webhook path is skipped as it is for CSRF. In server mode the TLS rule and the buckets still run first.

`mutatingRejection` (`:787`) then chooses between two rules for non-safe methods:

- **Off server mode**, unchanged from the desk: a missing `Origin` means same-machine, and a present
  one must be loopback.
- **In server mode**: `Origin` must be on the allowlist and a missing one is refused; and the
  double-submit CSRF token must match — cookie
  `__Host-agentforge_csrf` against header `x-agentforge-csrf` (`packages/host/src/csrf.ts`).

HTTPS is required via `X-Forwarded-Proto` (`:62-64`, `HTTPS_REQUIRED` at `:100`); a direct hit on
the app's own loopback port with no such header is refused in server mode.

**Two routes are exempt from the session gate and from CSRF**, because their caller is a machine with no
cookie: the billing webhook and, since 2026-11-02, the WhatsApp webhook `/api/v1/channels/whatsapp/webhook`
(`CSRF_EXEMPT_PATHS`, `http-adapter.ts:793`; `UNGATED_GETS` / `UNGATED_POSTS`, `auth/routes.ts:81,98`). Each
authenticates by its own secret instead, and each is a literal path, never a prefix. The WhatsApp one reads
its body raw under a 1 MB cap (`readBody`, `:247`) so its HMAC is checked over the exact bytes before
anything is parsed, and forwards the `x-hub-signature-256` header on that path only. Its map is
[`customer-inbox.md`](customer-inbox.md); the risk is [SR-191](../security-register.md#sr-191).

### 4. Sessions

`packages/host/src/auth/session.ts`. Opaque 32-byte ids (`SESSION_ID_BYTES` at `:16`) — no JWT,
nothing signed, nothing the client can forge or read. Since 2026-09-23 `auth_sessions` stores the
SHA-256 of the id, never the id (`hashSessionId`, `:125`; migration 0021), so a copy of the table
replays no session. Cookie is `__Host-agentforge_session` in server mode, `agentforge_session` off
it (chosen by `sessionCookieName`).

`verifySession` (`:155`) enforces 12 hours idle (`IDLE_TIMEOUT_MS`) and 30 days absolute
(`ABSOLUTE_LIFETIME_MS`), sliding at most every 5 minutes (`SLIDE_INTERVAL_MS`) so a busy tab does
not write a row per request. On top of the row, the gate re-checks a session with the portal once
its last portal check is ten minutes old (`packages/host/src/auth/portal-check.ts`): a session the
portal has revoked, a disabled user or an organisation past due is refused with the portal's reason;
an unreachable or rate-limiting portal refuses nobody, and neither does the portal rejecting this
deployment's own client id or secret. The portal refresh token behind each session is kept on its
row sealed under a key derived from the wrap key (HKDF, info `auth-session-refresh-v1`), so a
restart signs nobody out; the access token is never stored, and the wrap-key drill re-seals the
stored tokens. Details in [`portal-session-auth.md`](portal-session-auth.md).

The gate runs in `gate`, `packages/host/src/router.ts:456`, **before the route table is consulted**
— an unauthenticated caller learns nothing about which paths exist.

### 5. Rate limits

`packages/host/src/rate-limit.ts`. Three token buckets, all server-mode only:

| Bucket | Rate | Burst | Keyed on |
|---|---|---|---|
| per-IP | 600 rpm (`:23`) | 100 (`:24`) | client IP from `X-Forwarded-For` |
| per-session | 300 rpm (`:25`) | 50 (`:26`) | session cookie |
| auth routes | 120 rpm (`:27`) | 40 (`:28`) | client IP |

Each is overridable by env (`:30-32`). `MAX_RATE_KEYS` (`:35`) caps the map at 50 000 so the
limiter cannot itself become the memory exhaustion.

#### In-flight run limits (SR-138, 2026-10-06)

`packages/host/src/run-limits.ts`. The buckets above count requests, so they do not stop one signed-in
account from opening a hundred streams, or fifty `POST /api/v1/videos`, at once. This counts runs in
flight instead, server mode only:

| Cap | Default | Variable | Refused with |
|---|---|---|---|
| per tenant | 6 (`:36`) | `AGENTFORGE_MAX_RUNS_PER_TENANT` (`:33`) | 429 `too_many_runs` |
| whole server | off | `AGENTFORGE_MAX_RUNS_TOTAL` (`:34`) | 503 `server_busy` |

- **Parsing.** A whole number sets the cap; `off`, `none` or `unlimited` remove it; anything else is
  the default, so a typo never removes a limit (`parseRunCap`, `:53`). **`0` is not an off switch**: it
  is a cap of zero, and every run is refused with `server_busy`, the operator's stop for an incident
  (`admit`, `:111`). Off server mode `runCapsFromEnv` (`:71`) returns no caps and `admitRun`
  (`:172`) counts nothing, whatever the variables say.
- **What "tenant" counts.** The organisation inside its white-label partner (`runLimitKey`, `:160`).
  `TenantContext.tenantId` is the partner, shared by every company of one deployment, so keying on it
  alone would make all of them share one cap. With the per-tenant cap off and only the server cap set,
  one customer can take every slot.
- **Where it is taken: every route that calls the gateway gate**, right after it and before any work,
  so a refusal is the host's ordinary JSON error. Three shapes:
  - answers when the work is done: `withRunSlot` (`:185`) around the work, in the Images, Videos,
    Music, Lyrics, Documents, Presentations, Open Slide, Research, Data, Finance, Market and Knowledge
    (workspace re-index, self-check, map) handlers;
  - answers with a stream: Chat text, image and video at `packages/host/src/handlers/runs.ts:50` and the
    Edit agent, through `guardRunStream` (`:210`); every streaming job through the `tenant` option of
    `streamJob` (`packages/host/src/job-stream.ts:39-43`);
  - outlives the request: Edit `/generate` and an `asr` job on `/jobs` hold the slot from the request
    until the job itself is over, through `onSettled` on `enqueueEditJob`
    (`packages/host/src/edit/jobs.ts`).
  The tenant cap is checked first, so an account that is the reason the server is full is told so.
- **Left out on purpose** (`LEFT_OUT` in `run-limits-routes.test.ts`): prompt enhance, the knowledge
  context read, source ingest from a file or URL, one-source re-index, and the workspace backfill
  (`/knowledge/backend/reindex`, which answers at once and runs in an outbox). Each is one short call and
  bursty by design (a multi-file drop, a read per keystroke), so counting it would refuse a person their
  real work; the 300-a-minute session bucket still bounds them. `generate-defaults`, `documents/check`,
  `market/board` and the `education/*` routes never reach the gateway.
- **Cannot rot.** `packages/host/src/run-limits-routes.test.ts` finds every handler that calls the gate
  and fails unless it takes a slot or is on `LEFT_OUT` with a reason, then drives each counted route
  through the real router at its cap and expects 429.
- **Given back exactly once** (`createRunLimiter`, `:106`; the once-guard is at `:129`) when the work
  ends however it ends: completed, failed, aborted, the client went away (the response is destroyed),
  a consumer that never read a frame, or an error before the first frame. The Chat stream wrapper in
  `handlers/runs.ts` is written by hand so `return()` always reaches the run. A run whose client was
  already gone before it registered its abort listener ends at once (`packages/host/src/runs.ts:238`).
- **What it is not.** In memory and per process: a restart empties it and a second app process keeps
  its own count. Not a billing control and not an allowance. No `Retry-After`: `HostJsonResult` has no
  header field. The 503 keeps its code through error masking (`maskServerError`) and the renderer puts
  the catalog sentence in at `apiFetch` (`apps/web/lib/run-limit-copy.ts`), for both codes.

#### Request cost caps (SR-196 residual, 2026-11-06)

The body is read whole up to `MAX_BODY_BYTES` (26 MB, `http-adapter.ts:43`, `:240`) and then `JSON.parse`d, so the byte cap is the only bound on the read. `packages/host/src/request-limits.ts` bounds what a schema does with the parsed value. `assertRequestWithin` (`:18`) walks it without recursion and charges every value: an object or list `CONTAINER_COST` (6, `:9`), any other value 1. It answers `400 invalid_request` past a per-list length or past the cost budget. The cost, not the item count, is what limits `zod`, because `zod` records one issue per failing leaf and an empty object fails every required field (up to 6 on the request schemas, 12 for an Edit title style). Two profiles (`:11-12`): `REQUEST_LIMITS` (60,000 cost, lists of 10,000) for every route, and `BRIEFING_LIMITS` (250,000 cost, lists of 1,000) for the two Market routes that take a briefing, whose honest body is about 156,000. The worst failing body each profile admits was measured at about 56,000 issues and 60 MB (default) and about 102,000 issues and 71 MB (briefing, after the price chart caps dropped to 504 points and 3 series); SR-196 has the table.

- **Walked once per request**, before any schema: the finance export body (`handlers/finance-export.ts:44`, so `brief`, `result.brief` and `report` share one budget), the finance run, stream, parse, regenerate and Word export bodies (`handlers/finance.ts:17`, `:100`), the document and presentation Word, PowerPoint, check and regenerate bodies (`handlers/jobs.ts:221`, `:280`, `handlers/documents-check.ts:16`, `document-generate.ts:379`, `presentation-generate.ts:490`), saved decks (`handlers/presentation-decks.ts:32`), the Edit ops body (`handlers/edit.ts:165`), and the Market regenerate and Word export bodies with the briefing profile (`handlers/market.ts:57`, `:70`).
- **A `.max()` in the schema** where the data is host-built: the legal `deliverables` list (`legal/input.ts:43-48`), and the six Market packet lists that had none (a ticker's and the macro `failures`, the macro `quotes`, a chart's series and its two value lists; `packages/core/src/market/watch-schemas.ts:46-49`, `:172-180`, `:200`, `:218-222`). The shared finance, document, presentation and Edit schemas also read stored or model-written data, so they are left alone and the walker is their cap.
- **Saved decks** also refuse more than 28 slides or 50 bullets on a slide (`presentation-decks.ts:21-22`, `:41`), in the save so an older deck still opens.
- **Error text** built from `zod` issues is cut to the first 20, each at most 300 characters, by `summarizeIssues` (`packages/core/src/errors.ts:22`): the presentation and document parse helpers and `parseOpPayload`.

The hand-written body readers (`edit.ts` `targetClipIds`, `knowledge.ts`, `agents.ts`) build no issue list and are not covered. `defineTool` (`packages/core/src/tools/define-tool.ts:23-54`) still returns `zod`'s whole message, but takes a model's tool call, not a request body.

### 6. What goes back out

- **Headers.** `packages/host/src/security-headers.ts` writes CSP, HSTS, `X-Frame-Options: DENY`,
  `nosniff`, `Referrer-Policy`, both COOP/CORP and a `Permissions-Policy` that turns every
  powerful feature off **except the two Meeting recording needs**: since 2026-09-21
  (`../security-register.md` SR-14) `microphone=(self)` and `display-capture=(self)` are allowed
  and the other sixteen stay `()`, `camera` included. `(self)` is this origin and nothing else —
  `apps/web` renders no `<iframe>`, so no `allow=` attribute exists to delegate either feature; an
  artifact body is served under `Content-Security-Policy: sandbox` (`handlers/artifacts.ts:72`),
  which puts it in an opaque origin that `self` never matches; and `frame-ancestors 'none'` keeps
  the app out of anyone else's frame. Server mode only: webdev's inline module preloads and the
  desktop's custom protocol would both break under a CSP written for the built bundle.
  `webapp-deploy/Caddyfile` sets the same set; Caddy's `header` directive **replaces** rather than
  appends, so the proxy's value wins on the real deployment and nothing is duplicated. The app is
  the floor, the proxy is the ceiling — and `security-headers.test.ts` parses the Caddyfile and
  fails if the two policies stop agreeing, so "changed one, forgot the other" is a red test rather
  than a header nobody sends.
- **Identity headers stripped.** `X-Powered-By` and `Server` are removed in the adapter
  (`IDENTITY_HEADERS`, `packages/host/src/http-adapter.ts:53`) and again at the proxy.
- **Errors masked.** `maskServerError` (`:495`) replaces any 5xx message with a fixed string and
  keeps only a code matching `/^[a-z0-9_]+$/` (`:59`), so a SQLite error naming a column or a path
  never reaches the client. Off server mode it is a no-op and webdev's error path is untouched.
- **4xx is NOT masked, which is where the leaks live.** `maskServerError` only touches 5xx, and a
  deliberately malformed upload is answered `400`. The one that got through was ffmpeg: a failed
  run put `execFile`'s own message — the absolute path of the binary followed by every argument,
  which for this app is the absolute path of a tenant's media inside the data dir — plus 300
  characters of raw stderr into `ApiError("ffmpeg_failed", …)`, which `jsonError` serialises to the
  browser and Meeting streams as an SSE `job.error` frame. Since 2026-09-21 the detail goes to
  `log.warn("ffmpeg_failed", …)` — redacted, structured, server-side — and the client gets a fixed
  sentence plus a reason class chosen from the failure rather than copied out of it: `unreadable
  input`, `an unsupported codec`, `the tool could not be started`, `an invalid run request`, `too
  much output`, or `exit code N` (`packages/host/src/edit/ffmpeg/run.ts:94-141`, `:215-219`).
  `run-failure-detail.test.ts` asserts that no absolute path, argv fragment or tenant filename
  survives into the message.
- **An operator's string is not a URL.** `AGENTFORGE_BILLING_TOPUP_URL` was echoed to the browser
  verbatim and turned into an `href` on a page inside the tenant's session, so a `javascript:` or
  `data:` value in the deployment's environment would have been script execution. It is validated
  at the source now (`packages/host/src/billing/topup-url.ts`): anything that is not an absolute
  http(s) URL answers `available: false`, and the operator is warned at boot and on first use by
  **variable name only** — never the value, in case a secret was pasted into the wrong slot. The
  renderer's own `safeCheckoutUrl` (`apps/web/lib/plans-api.ts`) stays: a control at the source and
  a control at the sink are the two ends of one string, not a duplicate.
- **Downloads.** `packages/host/src/content-disposition.ts` builds every attachment header —
  quoted ASCII `filename` plus an RFC 5987 `filename*` when the name is not Latin-1. Applied in
  the adapter (`:347`) so a new download route cannot forget it.

### 7. Outbound — the SSRF guard

`packages/core/src/security/safe-fetch.ts`. Any fetch to a caller-supplied URL goes through
`assertPublicHttpsUrl` (HTTPS only, no credentials in the URL, host not private) and
`fetchPublicHttps` (`:226`), which re-checks **per redirect hop** (`:238-269`).

`packages/core/src/security/ip-range.ts` is the address half: it parses to bytes and compares CIDR
prefixes, covering the ranges a string match misses — `100.64.0.0/10` CGNAT, `198.18.0.0/15`, the
TEST-NETs, multicast, and the IPv6 blocks including the whole of `fe80::/10`. Addresses that carry
an IPv4 inside an IPv6 (`::ffff:`, 6to4, NAT64) recurse onto the embedded address (`:225-246`).

Per hop, `resolvePublicAddresses` (`packages/core/src/security/safe-fetch.ts:98-123`) resolves the hostname once
and refuses the whole name when the lookup fails, answers nothing, answers something that is not an IP address, or
answers any private address, so a public name pointing at `169.254.169.254` does not pass. A failed lookup is
`400 invalid_endpoint` "Could not resolve this URL's host", a private answer "URL must point at a public host". The
address is never in the message. An IP literal is not resolved; the lexical check already judged its bytes.

The connection is then pinned to that answer. `pinnedAgent` (`:168`) builds an undici `Agent` whose `connect.lookup`
(`pinnedLookup`, `:141`) returns only the vetted list, in the shape the connector asked for (`all: true` gives an
array, otherwise the first address with its family, and a `family` filter narrows the list), and answers for that one
host only. `fetchPublicHttps` passes it to `fetch` as `dispatcher` (`:246`), so the socket never asks DNS and a
resolver that answers differently the second time (DNS rebinding) is never consulted. Each hop gets its own agent,
destroyed after the body is read (`:266`). The default `fetch` is `defaultFetch` (`:172`), the `fetch` export of the
same `undici` 6.29.1 package that builds the agent (the version SR-198 pins), not `globalThis.fetch`, so the dispatcher
and the fetch are one version whatever undici the running Node bundles. `safe-fetch.test.ts` asserts the default is
undici's own, that a hop with no `fetchImpl` never reaches `globalThis.fetch`, and drives the pinned lookup against a
loopback listener on every run. A test that wants to stand in for the network injects `fetchImpl` or mocks `undici`'s
`fetch`; stubbing `globalThis.fetch` no longer reaches a guarded fetch. `assertResolvesPublic` (`:125`) is kept as a thin wrapper over the same resolver and has no production caller.
Not covered: the port (`https://host:6379/` is allowed; a policy is Rizky's call) and egress filtering ([SR-97](../security-register.md#sr-97), infra).

### 8. Routes that are off in server mode

| Route | Where | Why |
|---|---|---|
| `POST /api/v1/settings` — operator fields | `requestsOperatorOnlySettings`, `packages/host/src/handlers/settings.ts:193` | `toolKeys`, `toolBackends` and `injectionGuardBypass` are the operator's, not a tenant's. **The gateway and provider keys are not on this list:** since Phase 4 a key write reaches only the caller's own tenant, and a blank is dropped rather than forwarded, on every product since 2026-10-06 (`keyFieldValue`, `packages/host/src/handlers/settings.ts:227`). Since 2026-10-02 (M4) a non-blank key write, and `POST /api/v1/settings/reset { scope: "key" }`, also need `canAdminister` (an owner or an admin): a member or builder gets `403 settings_key_forbidden` (`requestsKeyWrite`, `:266`; `assertMayChangeCompanyKey`, `:271`). Server mode only |
| `POST /api/v1/settings/reset` scope `all`, and its cancel | `resetEverything`, `packages/host/src/handlers/settings.ts:423-440` | "Start over" deletes the data directory, which on a host is everyone's. Scope `key` is **allowed** on the server since Phase 4 — it only forgets the caller's own key (`resetGatewayKey`, `:400-415`) |
| component install stream | `packages/host/src/handlers/components.ts:45-67` | the image bakes anydoc in; the download path has nothing to do, and turning it off is what unblocks `noexec` on `/data` |

### 9. The container

`webapp-deploy/compose.yml`: read-only root filesystem, `/data` the only writable mount, `/tmp` a
`nosuid,nodev,noexec` tmpfs, `no-new-privileges`, `cap_drop: ALL` (the app binds 3000, a high
port, so it needs none back), `pids_limit`, `mem_limit`, and bounded rotated logs. Caddy shares the
app's network namespace so `127.0.0.1:3000` *is* the app and nothing is exposed on a bridge.

### 10. Where a tenant's provider key may go (Enterprise BYOK, Phase A, 2026-10-01)

Not a request-admission control; what the host does with a key once it has one. Detail on the pages named; the point here is that each is a hosted-only control with a Personal-parity test.

- **Pinned hosts.** The provider registry (`packages/core/src/providers/registry.ts:81`) is the only place a provider's base URL lives, digested at `:97`; `isOfficialOpenAIBaseUrl` compares hosts exactly (`packages/core/src/models/probe.ts:40`). [`model-policy.md`](model-policy.md) § 8.
- **No stored endpoint is honoured** (`packages/core/src/secrets.ts:346`, `packages/host/src/selectable-models.ts:343`). [`pii-and-key-security.md`](pii-and-key-security.md) § 10.
- **A key-bearing request does not follow a redirect** (`packages/core/src/runtime/key-redirect.ts:20`). Outbound calls to a *caller-supplied* URL are the SSRF guard of § 7 and are a different thing.
- **The model cache is per tenant**, a `tenant_state` row, so one tenant's provider catalogue and probe errors are not another's (`packages/host/src/model-cache.ts`; [`settings-and-gateway-gate.md`](settings-and-gateway-gate.md)). A tenant that has a key and no row is refilled by one background probe named by tenant and written only if the row is still absent (`warmHostedModelCache`, `packages/host/src/selectable-models.ts:505`); its failure line, `model_cache_warmup_failed`, carries the tenant id and the redacted message and no key.
- **Open on purpose.** Writing a key has no role check (Phase B, with personal keys), the job-model breaker is process-wide, and the media and transcription calls do not use the manual-redirect policy (they send Bearer tokens, which Node strips across origins).

## Where things live

| File | Role |
|---|---|
| `packages/core/src/server-mode.ts` | `isServerMode`, `trustedOrigins`, `normaliseOrigin` — the switch |
| `apps/web/server/hosted-mode-guard.ts` | Refuses to boot a production build that is not in server mode; re-exports the environment check below |
| `packages/host/src/hosted-env.ts` | Refuses to boot a server-mode process whose hosted environment is incomplete, naming every variable at once |
| `packages/host/src/http-adapter.ts` | Admission order, request id, error masking, auth-failure log |
| `packages/host/src/local-request.ts` | `filterHttpRequest`: method allowlist, path filter, header and body caps |
| `packages/host/src/csrf.ts` | Double-submit token mint and check |
| `packages/host/src/rate-limit.ts` | The three token buckets |
| `packages/host/src/run-limits.ts` | The in-flight run caps and the exactly-once slot (§ 5, SR-138) |
| `packages/host/src/request-limits.ts` | `REQUEST_LIMITS`, `BRIEFING_LIMITS` and `assertRequestWithin`, the cost cap on posted values (§ 5, SR-196) |
| `packages/host/src/auth/session.ts` | Opaque session ids, expiry, cookie names |
| `packages/host/src/auth/routes.ts` | `requireSessionFor`, the sign-in routes |
| `packages/host/src/router.ts` | `gate()` — the session check, ahead of the route table |
| `packages/host/src/security-headers.ts` | The response header set, and the Caddyfile parity test |
| `packages/host/src/content-disposition.ts` | Attachment headers for every download |
| `packages/core/src/security/safe-fetch.ts` | Outbound URL guard, per-hop redirect check |
| `packages/core/src/security/ip-range.ts` | CIDR membership for IPv4 and IPv6 |
| `packages/core/src/providers/registry.ts`, `runtime/key-redirect.ts` | The provider hosts a tenant's key may go to, and the no-redirect rule (§ 10) |
| `packages/host/src/model-cache.ts` | The per-tenant model cache (§ 10) |
| `packages/db/src/vault-key.ts` | Wrap-key sourcing, length and randomness floors |
| `webapp-deploy/compose.yml` | Container hardening, the pinned `AGENTFORGE_SERVER` |
| `webapp-deploy/Caddyfile` | TLS, HSTS, the same header set, access log |
| `scripts/audit-deployed.mjs` | Advisory gate scoped to the production closure the image installs (`--prod`, `LIST_ARGS` `:55`) |

## Touches / Do not touch

Read before editing a hosted control. Lanes: Enterprise (the hosted app). Personal has no HTTP port and must stay identical, so every change here is gated on `isServerMode()` and carries a Personal-parity test.

**This page owns these:**

- `packages/core/src/server-mode.ts`, `packages/host/src/hosted-env.ts`, `apps/web/server/hosted-mode-guard.ts`: the switch and the boot refusals.
- `packages/host/src/http-adapter.ts`, `packages/host/src/local-request.ts`, `packages/host/src/csrf.ts`, `packages/host/src/rate-limit.ts`, `packages/host/src/run-limits.ts`, `packages/host/src/security-headers.ts`, `packages/host/src/content-disposition.ts`, `packages/host/src/safe-fetch.ts`.
- `packages/host/src/auth/session.ts` and the gate in `packages/host/src/router.ts`.
- `packages/core/src/security/safe-fetch.ts`, `packages/core/src/security/ip-range.ts`, `packages/core/src/providers/registry.ts`, `packages/core/src/runtime/key-redirect.ts`, `packages/host/src/model-cache.ts`, `packages/db/src/vault-key.ts`.
- `webapp-deploy/compose.yml` and `webapp-deploy/Caddyfile`, `scripts/audit-deployed.mjs`.

**Change these together or not at all.** `webapp-deploy/Caddyfile` and `packages/host/src/security-headers.ts` carry the same header set, and `packages/host/src/security-headers.test.ts` reads the Caddyfile and fails on any drift. A new route with a `:param` goes through the by-id harness ([`by-id-routes-and-tenancy-harness.md`](by-id-routes-and-tenancy-harness.md)).

**Do not touch from a hosted-security change:**

- `apps/portal/**`: the portal has its own controls ([`portal-service.md`](portal-service.md)); the host reaches it only over HTTP.
- `packages/host/src/auth/routes.ts` and `portal-*.ts`: the sign-in flow and seat claim ([`portal-session-auth.md`](portal-session-auth.md)).
- `packages/host/src/gateway-gate.ts`: advisory by design, fails open; never read it as an entitlement ([`settings-and-gateway-gate.md`](settings-and-gateway-gate.md)). Limits and seats are enforced server-side ([`tenant-entitlement.md`](tenant-entitlement.md)).
- `apps/desktop/renderer-csp.cjs` and `apps/desktop/main.cjs`: Personal's own policy, IPC and no port.
- Never add a Cloudflare mode to `webapp-deploy/Caddyfile`; Nultron keeps its direct two-name setup.
- `scripts/release-web.mjs` and the pack scripts: release paths need Rizky's word ([`release-and-sync-lanes.md`](release-and-sync-lanes.md)).

## Gotchas

- **`isServerMode()` is read per call, not captured.** A test that flips `AGENTFORGE_SERVER`
  changes behaviour for every control in the same process, which is why
  `packages/host/src/http-adapter.test.ts` saves and restores the two env keys around every case.
- **The adapter must stay the first middleware.** Almost every control in section 2 applies to
  non-`/api` traffic, and it can only do that from above `express.static`.
- **Duplicated headers are intentional.** The app and the Caddyfile both set the full set. Caddy
  replaces rather than appends, so nothing is sent twice on the real deployment, and the app is
  what protects any *other* deployment. `packages/host/src/security-headers.test.ts` parses the Caddyfile and fails
  on drift — if you change one, change both or that test will say so.
- **`maskServerError` keeps the code and drops the message.** A 500 in webdev still shows the real
  error; in server mode the same 500 shows `internal_error`. If you are debugging a hosted 500,
  the message is in the `request_failed` log line, found by the `X-Request-Id` the caller was
  given.
- **The health check is not a security check.** It passed in every misconfiguration this pass
  found, including the one where every control was off.
- **The SSRF guard fails closed on a resolution error (SR-201).** It used to return, on the reasoning
  that an unresolvable name could not be connected to; `fetch` resolves on its own, so that let a
  connection through. Now a failed or empty lookup is `400 invalid_endpoint`. The cost is that a test
  which reaches `fetchPublicHttps` with a fake `fetchImpl` and no `lookupImpl` does a real DNS lookup
  and fails offline: give it a `lookupImpl`, or mock `node:dns/promises` the way `web-fetch.test.ts`,
  `media-download.test.ts`, `components/download.test.ts` and `components/install.test.ts` do. A fake
  `fetchImpl` never runs the pinned agent; the property is proved by `pinnedAgent` and `pinnedLookup`
  cases in `safe-fetch.test.ts`. See `../security-owasp-2026-09.md`, A10-3 and A10-6.
- **`getTenant` is not this page's job.** Being admitted says nothing about which rows a request
  may touch. Phase 3 owns that, and `../security-owasp-2026-09.md` A01-1 and A01-2 record where it
  is currently thin.

## Verify

Automated, and these are what actually prove this page:

| Suite | Proves |
|---|---|
| `packages/host/src/http-adapter.test.ts` (131, run 2026-09-23) | admission order, Origin/Host/CSRF, rate limits, masking, request id, `auth_failed`, and a malformed `Host` or unparseable target answered 400 in both modes rather than thrown |
| `packages/host/src/security-headers.test.ts` (14) | the header set, the exact `Permissions-Policy` string, and Caddyfile parity |
| `packages/core/src/security/ip-range.test.ts` (14) | CIDR membership, the v4-in-v6 forms |
| `packages/core/src/security/safe-fetch.test.ts` (32, run 2026-11-06) | scheme, credentials, per-hop redirects, fail-closed DNS resolution, one lookup per hop, and the pinned agent reaching a loopback listener for a name no resolver can answer |
| `packages/db/src/vault-key.test.ts` (26) | length and randomness floors, `.master-key` corruption |
| `apps/web/server/hosted-mode-guard.test.ts` (13) | the production-build refusal, that compose still pins the flag, and that both boot guards run before `server.listen` |
| `packages/host/src/hosted-env.test.ts` (48, run 2026-09-23) | one row per hosted variable, the aggregated message, that no value is printed, that local mode is untouched, and SR-26: a loopback http portal URL refused on `NODE_ENV=production` and kept everywhere else |
| `scripts/ci-local.mjs` (`pnpm ci:local`) | runs all of the above, one package at a time. Since 2026-09-24 it is the only CI: `.github/workflows/` is deleted, and nothing runs these unless someone runs it (`../security-register.md`, SR-80). Since 2026-10-01 a vitest step passes only when its log carries a `Tests  N passed` line (N above zero), not merely exit 0: vitest exits 0 after "No test files found" when a global setup dies, which is how the portal suite under an admin token read as a pass (`checkVitestLog`, `judgeStep`; `summary.md` lists the reason under every step that did not pass; `scripts/ci-local.test.mjs`) |

**There is no `verify-agentforge` feature file for this page, and that is a gap rather than a
choice.** The existing `features/security.md` covers the key-fingerprint UI and
`features/gateway-gate.md` the gate; neither drives the hosted perimeter, because on a desk none
of it is on. A feature file for it needs a deployed host to point at, so it belongs with the
Phase 0 deploy. Until then this page is proved by the suites above and not by a harness run.

## Why

- **One flag rather than a config object.** `[Inferred]` No commit or doc states the decision. The
  shape is consistent across every control — each calls `isServerMode()` at the point of use — and
  `packages/core/src/server-mode.ts` carries no other export for composing them, so the design
  appears to be deliberate simplicity rather than an unfinished abstraction. The cost is stated in
  `docs/internal/security-owasp-2026-09.md` A05-1: a single point of failure, now guarded at boot.
- **Headers in two places.** `[Direct]` `packages/host/src/security-headers.ts:1-20` states the
  reasoning: the Caddyfile was the only copy, so any deployment behind a different proxy had no
  CSP at all.
- **The audit gate is scoped to the production closure the image installs, not the workspace.** `[Direct]`
  `scripts/audit-deployed.mjs:1-35` and `docs/internal/security-owasp-2026-09.md` A06-1: the
  workspace's 1 critical and 19 high advisories are all reachable only from `apps/desktop`, which the
  `build` and `prod` stages never install (`webapp-deploy/Dockerfile:73`, `:113`). Since 2026-10-05 dev
  dependencies are outside the closure too: the `prod` stage installs `--prod` (`:113`), the runtime copies
  it (`:167`), and the script lists with the same flag (`LIST_ARGS`, `:55`), so `braces` (reached only
  through `tailwindcss`, a devDependency) does not gate (SR-113).
