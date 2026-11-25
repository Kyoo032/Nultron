# Map — Settings, the gateway gate, and Start over

Product: both · Instance: main :3000

Last verified: 2026-11-25 on working tree over `d9131193` for `apps/web/components/settings-shell.tsx` only: removed the `Team` tab (`/team`) from `SETTINGS_TABS` (moved into `AgentsShell` alongside `/workspaces`), leaving `General`, `Channels`, `Customers`, and `Connectors (MCP)` in Settings.

Last verified: 2026-11-24 on `chore/dfind-139-retire-desktop` (DFIND-139) merged with `main`: removed desktop-bridge calls from `settings-page.tsx`, `settings-reset-card.tsx`, and `onboarding-screen.tsx` plus `personal-reset-card.test.tsx` / `personal-*.golden.json`, alongside `main`'s per-user operator-assigned gateway endpoints (`gateway-endpoint-scope.ts`, `gatewayEndpointFor` + `endpoint`-validated `GateState` + per-endpoint gate/model-cache slot isolation in `gateway-gate.ts` and `model-cache.ts`, `resolvedGatewayBaseUrl` and `validateGatewayKey` in `@agentforge/core`), minimal single-card onboarding (`onboarding-screen.tsx`), unified tabbed `SettingsShell` (`settings-shell.tsx`), and `<UiSelect>` language picker + grouped layout in `settings-page.tsx`. Before that: 2026-11-11 on `models/key-availability` (working tree over `ebef4f7a`) for one thing only: `GET /api/v1/settings` now also answers `modelAvailability` (`packages/host/src/handlers/settings.ts`, from `model-availability-payload.ts`) and Settings draws a models card from it (`apps/web/components/settings-models-card.tsx`, placed above the storage card in `settings-page.tsx`). What it holds and how it is learned: [`model-policy.md`](model-policy.md), "Which models a key can use". Nothing else on this page was re-read. Last verified: 2026-11-09 at 6080cbba plus the working tree of `fix/desk-key-warn`, for the "Sealed settings that will not open" row of Failure modes only (SR-203). Before that: 2026-11-06 at f6c9acc1 for the "Sealed settings that will not open" row of Failure modes only (SR-203). Before that: 2026-11-06 at 39cd5f0c plus the working tree of `fix/sec-005-guard-bypass-not-persisted` (SR-202), for the paragraph on `injectionGuardBypass` in "Settings per desk" only; nothing else on the page was re-read. Before that: 2026-10-29 at 464b00c5 (Biome cleanup in `apps/web/components/settings-page.tsx` and `packages/host/src/settings-store.ts` at `92bde965`; before that: 2026-10-11 at 2df34be, fix branch, before merge). Only "What a save does besides saving" and "What the answer carries" were re-checked; the other cites on this page are unchanged, and some were already stale.

> **Two products, one repo.** **Personal** is the Mac/Windows Nultron app (current cut `0.15.0`); **Enterprise** is the hosted web app.
> The host-decides/renderer-displays rule below is unchanged and applies to both; the Electron-only transport and wipe details are the Personal app's.
> Decision record: [`web-pivot-2026-09-18.md`](../web-pivot-2026-09-18.md).

2026-10-11, on `2df34be` (branch `test/sh-004-keygate-fake-gateway`, before merge) plus one new test file, for SH-004, a coverage gap and not a product bug. Until now the bad-key, unreachable and grace states were checked either against a status-only `fetch` stub or by hand-built verdicts, so no test had a real socket answering. `packages/host/src/gateway-gate-fake-gateway.test.ts` (10 cases) drives the real router against a fake gateway on `127.0.0.1` through the dev/test hook `AGENTFORGE_GATEWAY_URL` (`gatewayUrlOverride`, `packages/core/src/gateway/pinned.ts:72-81`). The host test setup (`packages/host/test/setup.ts`) lets only loopback fetches through, so nothing can reach the real gateway. What it proves, all on a desk: a 401 and a 403 each close the desk as `invalid_key` with no grace, and a gated route then answers the flat `403 gateway_blocked`; a refused socket and a dropped socket are `unreachable`, and a validated key stays open on grace while the endpoint is down, then closes once its `lastOkAt` is eight days old; a 500 on a first check is `error` with no grace; a held response with a 200 ms budget through `runGatewayCheck` is `unreachable`; each Re-check makes exactly one live call; a stale `ok` is re-checked in the background when Settings is read; stub runtime makes no gateway call with a key saved. The keys in that file are obviously fake, and the test asserts they reach no response and no verdict file. **Not proven:** the real gateway's answers (a revoked key's status, any 3xx on `/models`, TLS and timeout behaviour), and the 2026-09-15 row that read "Key verified" while live calls returned 401. Those need a real gateway and an owner-approved test key.

Review round, same day, same tree (still uncommitted), for [SR-163](../security-register.md#sr-163) items 1 to 6: on the hosted server a provider key saved on one desk is written to every desk of the company (`saveKeysToDesks`; see "What a Settings save does on the hosted server" below), the Settings `probe` and `defaults` and the model list are the **company's** (`model_cache:<organisation id>`, no longer the partner's), `usage` is the company's, a company whose gate slot is empty adopts the old partner verdict for the very key it holds (`loadVerdictFor`), and the hosted "Erase company account" is refused with `409 tenant_erase_shared_partner` when a partner holds more than one company. Those paragraphs were rewritten in place; the cites into `model-cache.ts`, `selectable-models.ts` and `gateway-gate.ts` that moved with them were re-anchored by name, not by line. Proven by `gateway-gate-companies.test.ts` (30), `model-cache-companies.test.ts` (17), `usage-companies.test.ts` (9), `tenant-reset-companies.test.ts` (10), each red before its fix. **Not driven on a hosted server.** A desk is unchanged in every one of them (each has a Personal case). **Scoping the erase to one company is still owed and is the owner's decision.**

Before that: 2026-10-07 in the working tree over `726f369` (branch `feat/hosted-run-limits`), not committed, for [SR-163](../security-register.md#sr-163): on the hosted server the gate verdict is one row per company, not one per white-label partner. That changes the "SR-163" bullet under "The gateway gate", the "forget my key" paragraph under Start over, three failure-mode rows, and the cites into `gateway-gate.ts` and `tenant-state-store.ts` that moved with it (re-anchored in those sections only; other cites on this page were already drifting before this change and `maps:check` still lists them as soft findings). Proven by unit tests and by `dispatch` with real sessions, two companies under one partner, a stand-in gateway, and a mutation check against the old behaviour (seven hosted cases go red). **Not driven on a hosted server.** A desk's verdict is the file it always was, and `gateway-gate-companies.test.ts` pins its bytes and path. Every other line of this page is as verified next.

Before that: 2026-10-06 on `chore/release-0.16.0` (over `de95267`), for the background re-check of an `unreachable` or `error` verdict (`needsGatewayRefresh`; the paragraph after "The live check") and for a Settings save with the key field blank, which now keeps the key and its verdict on both products (the "Save with an empty key string" row, the `scope: "key"` paragraph and the key-write paragraph). Proven by unit tests; the drive is recorded in `docs/internal/0.16.0-changelog.md`.

Before that: 2026-10-02, working tree over 0b61a29, not committed, for who may write the company's gateway key on the hosted server (M4; the "Who may press it" paragraph under Start over, the save-a-key row of the failure modes, the "What the owner can actually change" paragraph, and the key box, the reset card and the onboarding key step in the renderer): in server mode a non-blank provider key in `POST /api/v1/settings`, and `POST /api/v1/settings/reset` with `scope: "key"`, need an owner or an admin and answer a member or a builder `403 settings_key_forbidden`; the screens stop offering those controls to a member. Proven by unit tests (`settings-key-roles.test.ts` against real membership rows and `company-key-access.test.tsx` against a byte-for-byte golden of the Personal Settings page); **not driven in a browser, on the Kubernetes rehearsal or on a packed app**. Every other line of this page is as verified next. Before that: 2026-10-01, working tree over 0b61a29, not committed, a final pass that day, for the language the settings answer carries on the hosted server (the paragraph on the UI locale below, item `locale` / `savedLocale`): a person who never chose one is shown their browser's `Accept-Language`, with the stored choice first and nothing written (`settingsPayload` takes the request's header and the mode it was handed; see [`locale-boot-and-run-harness.md`](locale-boot-and-run-harness.md)). Proven by unit tests and by `dispatch` with real sessions, with a mutation-checked Personal-parity case; not driven in a browser. Before that, later that day, for Edit's Agent pane (its no-key note and quiet Send) and the hosted ffmpeg line, in the hosted needs-key paragraph below (item 5), driven with the hosted marker and the host's answers faked in the browser on `:3000`, not on a deployed hosted build. Before that, the same day, for two Enterprise-only fixes: a hosted tenant that holds a key and has no `model_cache` row (every tenant that upgraded into per-tenant caches) is refilled by one throttled background refresh that the first catalogue read starts (the paragraph after the `probe` / `defaults` one, the files table, the tests paragraph), and hosted prompt-enhance with no key answers `403 gateway_blocked` where it answered 200 stub text (the call-site list and the "Not every gated route checks the gate first" gotcha, whose line moved from `:49` to `:53`). Proven by unit tests and by `dispatch` on a real database with provisioned tenants, each with a Personal-parity case that was mutation-checked; **not driven in a browser, on the Kubernetes rehearsal or on a packed app**. Before that, the same day, for Enterprise "bring your own key" Phase A: the hosted model cache is now one row per tenant (`model_cache`) and the `probe` and `defaults` on this page's answer are the caller's own, a hosted tenant's stored Google, Anthropic and Volcengine base URLs are neither honoured nor echoed, and `refreshModelCache` probes the provider registry's hosts (paragraphs after `settingsPayload()` and after the save table, the state-keys and `model-cache.ts` rows, one Gotcha). Proven by unit tests, by `dispatch` with two provisioned tenants and by running the real router inside the local Kubernetes rehearsal's app container against its own database (Verify); **no browser sign-in** was completed on that cluster (the portal answered "No seats left in your organisation" to a new device), so Chat, Settings and the model list were not seen in a browser. The Personal app is unchanged by construction and by test, and was not driven on an installed app. Before that, the same day: the new "Add the key later (Enterprise only)" section, the Renderer paragraph (`resolveGate` takes a hosted deferral) and the "A closed gate hides Settings too" gotcha: a signed-in hosted tenant can start without a key, the host records the choice (`POST /api/v1/settings/key-later`, `keyLater` on the settings answer, server mode only) and the host's gate and every `403 gateway_blocked` are untouched. Proven by unit tests and by a drive on the local Kubernetes rehearsal (see that section); not driven on the Personal app, which is unchanged by construction and by test. Before that, the same day, for the endpoint-pinning paragraph and the "pinned three ways" paragraph: the packaged marker is now set by `main.cjs`, so "not packaged" in the override rule is true, and a brand flavor's gateway has its own variable ([SR-85](../security-register.md#sr-85)); the `migrateLegacyUserData` citation in the Start over section moved with that edit (`main.cjs:780-810`). Not driven on an installed app. Before that: 2026-09-30, working tree over bcf14f7, not committed (the second time that day), for the `defaults` sentence in the `settingsPayload()` paragraph: the per-mode default ids it carries resolve from the model lists of that day ([`model-policy.md`](model-policy.md) § 7), the Chat default is `gpt-6-luna` now. Before that, the same day, for "What a save does besides saving" and the sign-out paragraph under Start over: a save, a key reset and a tenant reset now call `resetModelReliabilityState`, which clears the learned Thinking-level limits along with the job-model breaker ([`model-policy.md`](model-policy.md) § 4); the citations in that table were re-read and re-anchored the same day. Every other line is as verified next. Before that: 2026-09-29, working tree, not committed, for the first-run guide's record (a `guide` field on `settingsPayload`, `POST /api/v1/settings/guide`, the record inside the sealed payload beside the language, erased by Start over): see "The first-run guide's record" below and [`first-run-desk-and-guide.md`](first-run-desk-and-guide.md); every other line of this page is as verified next. Also 2026-09-29, working tree, not committed, for `settingsPayload` (no `modes`; the range is re-anchored) and the shared settings read, both stated under "Settings per desk". Also 2026-09-29, for the reset wipe list (it gains `models-dev-cache.meta.json`) and every
`apps/desktop/main.cjs` and `settings.test.ts` citation in this page's Start over section, re-anchored in the working
tree, not committed, after the ffmpeg probe moved behind the first paint. Not driven. Before that: 2026-09-26 for the onboarding screen, restyled onto the current desk (gradient hello,
`hero-aurora`, `card-live` example tiles). A fresh desk is a short hello, then the key, then four
examples that open Chat. The screen does not show the gateway address. The host still decides:
`allowed` is the only branch, and the examples render only after `resolveGate` says `"app"`. In-app name
stays `{productName}` (Nultron). Gate derivation, reset, and Settings are untouched.

Before that: 2026-09-23 at d4561b8 + uncommitted tree for Start over (a wipe that fails part-way is now
retried, and the boot log line), the Settings page's load / save / language failures, and every
`settings-page.tsx` line cited on this page. Not driven: the reset change is in `@agentforge/db`, which only a
restart of `:3000` or a packed app picks up.

Before that: 2026-09-23 at 775d16f + working tree (finding 1 of the 0.15.0 verify pass). Changed here: a new desk starts with a copy of the creating desk's gateway key (`inheritGatewayKey`, `packages/host/src/handlers/workspaces.ts:33-39`), and the onboarding screen lists the other desks (`onboarding-desks`) so a keyless desk is never a dead end — see "Settings per desk" below. The gate's derivation is untouched.

Before that: 2026-09-23 at 0774681 + working tree (the 0.15.0 design pass). Changed there: `settings.kicker` is deleted, `settings.runtimeStub` and `settings.gateway.status.stub` no longer claim "Offline demo" (stub means *no key saved*, not a demo), and `settings.intro` was trimmed. The gate's derivation, `resolveGate`, the reset scopes and the endpoint-hiding rule are all untouched. **The sign-out → onboarding behaviour is verified in the packaged personal app, not on webdev**: `deriveGatewayGate` short-circuits `envRuntime === "stub"` to `allowed: true` before it looks at whether a key exists (`packages/host/src/gateway-gate.ts:361-365`), and both `.env` and `apps/web/.env.local` pin `stub` on a dev machine — `apps/desktop/main.cjs` never sets it, so a packaged app derives `needs_key` and sign-out does drop to onboarding.

Supersedes the 2026-09-22 note, which recorded the opposite `stub` copy: `chat-key-status` used to read "Model key connected (offline demo)" on a keyless desk. That string is gone from both catalogs; `stub` now reads as a missing key.

Last verified before that projection: 2026-09-20 at a053245 + the Phase 4 branch `feat/web-phase4-tenant-secrets-rcbu9c` (through e37b3a1)

> The 2026-09-17 "hide the endpoint" change was verified in the working tree when this page was
> first written; it is committed as of `b482611`. `apps/web/components/settings-page.tsx`,
> `apps/web/components/onboarding-screen.tsx` and `apps/web/locales/{en,id}/{settings,onboarding}.json`
> all carry it. Every cite on this page is committed code.

## Overview

Three things that share one surface. **Settings per desk** is where the gateway key and per-workspace
preferences live, encrypted, keyed by workspace id inside a payload keyed by tenant — on disk on a desk,
in a `tenant_state` row on the hosted server ([`tenant-secrets-backend.md`](tenant-secrets-backend.md)). **The gateway gate** is the host's judgement
about whether that key currently works, cached as a verdict file and answered to the renderer as one
boolean. **Start over** is the two-scope escape hatch: forget the key, or wipe the desk back to a fresh
install.

The rule that ties them together: **the host decides, the renderer displays.** `allowed` is the only thing
the renderer branches on; it never re-derives a decision from `hasOpenai` or from key shape.

## How it works

### Settings per desk

**One sealed payload per tenant, one slice per desk inside it.** Phase 3 lane D split the payload per
tenant; Phase 4 moved it behind a backend. The payload itself is unchanged in either: an AES-256-GCM
envelope holding `{ version: 2, locale, users, workspaces: { [workspaceId]: StoredSecrets } }` — the type is
`SettingsFileV2` (`packages/host/src/settings-store.ts:186-197`). "Per desk" is a key in `workspaces`;
"per tenant" is which payload.

**Where that payload lives is decided by mode, never by tenant** — `tenantStateBackend()`
(`packages/host/src/tenant-state-store.ts:368-370`). Off server mode it is lane D's file, at exactly lane D's
path: `<localDataDir()>/settings.enc` for `local-tenant` and `<localDataDir()>/tenants/<tenantId>/settings.enc`
for anyone else (`TENANT_STATE_FILENAMES`, `packages/host/src/tenant-state-store.ts:48-54`; see
[`tenant-storage.md`](tenant-storage.md) for why the local tenant keeps the bare path). In server mode it is a
`tenant_state` row and no file is written at all. The whole of that story is
[`tenant-secrets-backend.md`](tenant-secrets-backend.md); this page assumes it and carries on.

`loadSettings(scope?)` / `saveSettings(patch, scope?)` (`packages/host/src/settings-store.ts:469-487`) take a
`SettingsScope` (`:41`): a `TenantContext`, or a bare desk id. `resolveSettingsScope` (`:45-58`) turns either
into `{ tenantId, workspaceId }` — and a bare desk id **throws `tenant_required` in server mode**, because a
hosted call that cannot name its tenant must not fall back to the local tenant's payload. The desk half still
goes through `resolveSettingsWorkspaceId` (`:293-299`): explicit id → `readSelectedWorkspaceId()` →
`FALLBACK_SETTINGS_WORKSPACE`. `sliceFor()` (`:301-310`) picks that desk's slice, falling through to the
`LEGACY_SETTINGS_WORKSPACE` slice **only** when the resolved id is the fallback (`:306-307`).

The two sentinels are string constants, not magic literals scattered around:
`LEGACY_SETTINGS_WORKSPACE = "__legacy__"` (`:28`) and `FALLBACK_SETTINGS_WORKSPACE = "__default__"` (`:30`).
The literal `"__default__"` appears exactly once in the repo, at `:30`.

**`injectionGuardBypass` is the one field of a slice that is not saved (SR-202, 2026-11-06).** The sealed payload
never holds it, on a desk or on the server. `mergeSecrets` ignores it and `normalizeSecrets` does not read it
(`packages/host/src/settings-store.ts:112`), and a slice that still carries the key is rewritten without it as soon as
the payload loads (`carriesStoredBypass` `injection-guard-bypass.ts:23`, `clearStoredBypass` `settings-store.ts:447`, `loadSettingsFile` `settings-store.ts:481`, one log line
with the tenant id). Off server mode `saveSettings` records a boolean patch in a per-desk set in host memory
(`packages/host/src/injection-guard-bypass.ts`; `settings-store.ts:531`) and `loadSettings` / `saveSettings` layer
it onto what they return (`withInjectionGuardBypass`, `injection-guard-bypass.ts:17`), so `maskSecrets` reports it and every reader sees it
until the host restarts. In server mode the set refuses to hold it. The Settings page sends no such field and has no
control for it. Tests: `settings-guard-bypass-desk.test.ts`, `settings-guard-bypass-hosted.test.ts`.

**The UI locale is not in a desk slice and is not the tenant's either.** Phase 4 made it per *user*:
`loadUserLocale(scope)` / `saveUserLocale(scope, locale)` (`:594-600`, `:626-639`) take a `UserScope` —
tenant, desk **and** user — and read or write `users[userId].locale` inside the same sealed payload.
`loadUserLocaleChoice(scope)` (`:611-616`) reads only that field and answers `null` for a person who never
chose, which `loadUserLocale` cannot (it falls through to the tenant's locale and then English); the hosted
settings answer uses it to put a person's own choice ahead of their browser's language (`localePayload`,
`locale-boot.ts:121-134`).
`loadOwnerLocale` / `saveOwnerLocale` (`:564-566`, `:568-572`) remain the *install's* locale, which is what
`getBootLocale()` freezes. See [`locale-boot-and-run-harness.md`](locale-boot-and-run-harness.md).

**A new desk inherits the gateway key.** Keys stay per desk, but `handlePostWorkspaces` copies the creating desk's `openaiApiKey` into the new desk's slice before it selects the new desk (`packages/host/src/handlers/workspaces.ts:33-39`, `:99-100`). Without it, creating a desk on a keyed install selected an empty slice, the gate derived `needs_key` / `allowed: false`, and `App` replaced the shell with the key form everywhere (finding 1 of the 0.15.0 verify pass). No verdict is copied because none needs to be: the verdict is the tenant's and keyed by fingerprint. Only the gateway key moves — extras stay empty — and `clearGatewayKeyEverywhere` still clears the copy. Pinned by `packages/host/src/handlers/workspaces.test.ts`. The renderer's guard for desks that are still keyless: `OnboardingDesks` under the key form (`apps/web/components/onboarding-screen.tsx:297`), which selects another desk on the host and applies the gate the host reports for it (`apps/web/lib/onboarding-desks.ts:60-68`). The host still decides; the renderer only offers the desks. When that gate is allowed, the screen shows the examples step instead of opening the desk immediately.

**The first-run guide's record rides in the same payload as the language (2026-09-29).** `UserPrefs` gained `guide` (`{ outcome: "finished" | "skipped" | "closed", at }`, `packages/host/src/settings-store.ts:188`), so it is per user inside a tenant's sealed `settings.enc`, machine-wide on a desk (one user, `local-owner`) and per person on the hosted app. `loadUserGuide` and `saveUserGuide` (`:627`, `:641`) read and write it; `settingsPayload` answers it as `guide: { seen, outcome, at }` (`packages/host/src/handlers/settings.ts:101`); `POST /api/v1/settings/guide` records an outcome (`handlePostGuide`, `packages/host/src/handlers/guide.ts:18`, route `packages/host/src/router.ts:290`) and is deliberately its own route, not a field of `POST /api/v1/settings`, because a settings save revokes the knowledge model row, clears three breakers and re-probes the gateway. It is not gated (`gateway_blocked` never applies to it). **"Start over" removes it for free:** `settings.enc` is the first entry of `HOST_RESET_ENTRIES`, and `packages/host/src/first-run-modes.test.ts` proves the record reads back unseen after a real Start over. "Sign out" (`scope: "key"`) leaves it alone.

**`workspace-id.txt`** (`<localDataDir()>/workspace-id.txt`, `packages/host/src/workspace.ts:19-41`) is the
stamp that stops a request from landing in the fallback slice. `getTenant(preferredWorkspaceId)`
(`packages/host/src/tenant.ts:88-103`) reaches `resolveLocalOwner` (`:117-132`) off the hosted path, which calls `adoptLegacySettings(home.id)` on every call (`:124`), and — only
when the caller named no desk and nothing was on disk — writes the resolved desk id (`:46-48`). A desk named
by the per-request `WORKSPACE_COOKIE` is **never** promoted into the file (comment at `:15-17`), pinned by
`packages/host/src/tenant.test.ts:47-55`.

**The fallback-slice trap.** If a request resolves to `__default__` — e.g. a bare `loadSettings()` before the
stamp exists — it reads an orphan slice no real desk ever sees, so a key saved on the real desk looks absent
and the desk reports stub. The defence is a **source-grep test**:
`packages/host/src/settings-desk-scope.test.ts:18-88` fails the suite if any file under `packages/host/src`,
`apps/desktop` or `apps/web/server.ts` calls `loadSettings` with `()`/`undefined`/`null`/`""`, outside two
named exceptions (`studio-generate.ts`, `handlers/jobs.ts`, listed at `:22-23`).

**`settingsPayload()`** (`packages/host/src/handlers/settings.ts:88-128`) is what the renderer sees. **It does not
carry the model catalogue** (2026-09-29): `modes` left it, and only `defaults` (the per-mode default ids, `:113`)
stayed (they resolve from the lists in [`model-policy.md`](model-policy.md) § 7: on a catalogue that lists them, chat `gpt-6-luna`, documents, finance and market `hy3`, legal and meeting `gpt-6-sol`, presentations `glm-5.3-flash`). It used to spread `modeCatalogPayload()`, which put the chat list under nine mode names, 261 KB of a
274 KB answer that the shell reads on every cold load; no reader of this route used a list. The catalogue is
`GET /api/v1/models`, sent once (`modelCatalogBody`, `packages/host/src/selectable-models.ts:313-318`); the
tests are `packages/host/src/handlers/models.test.ts`. On the renderer side the shell's gate read and the
readers that only display the answer (the Chat key pill, the usage chip, the composer's needs-key hook, the
job-mode model pickers) share one `readSettings` (`apps/web/lib/settings-read.ts`): at most 2 s old, dropped
by any write this renderer makes (`subscribeToWrites`, `apps/web/lib/api-client.ts`), and never used for the
Settings page itself, which asks the host afresh. A cold `/chat` made four reads of this route; it now makes
one. Keys are never in the payload: `maskSecrets` (`packages/core/src/secrets.ts:257-287`) emits booleans (`hasOpenai`, …) and
fingerprints (`sha256:` + the first 12 hex chars of SHA-256 over the trimmed secret,
`packages/core/src/security/fingerprint.ts:9-15`). `openaiBaseUrl` in the payload is always
`resolvedGatewayBaseUrl()`, never a stored value (`packages/core/src/secrets.ts:270-271`).

**On the hosted server the payload is the caller's own where it used to be the machine's (Enterprise BYOK
Phase A, 2026-10-01; narrowed from the partner to the company by SR-163, 2026-10-07).** `probe` is
`probeSummary(undefined, tenant)` and `defaults` is `modeDefaultsFor(tenant)`
(`packages/host/src/handlers/settings.ts`, in `settingsPayload`): both read the calling **company's** model
cache, which on the hosted server is a `tenant_state` row (key `model_cache:<organisation id>`, under the
partner's `tenant_id`) and not the one machine file `models-cache.json` every tenant's save or Refresh used to
write and every tenant's Settings used to read back (`packages/host/src/model-cache.ts`, `modelCacheOwner`,
`companySlot`, `loadModelCache`, `saveModelCache`). `tenantId` is the white-label partner and a company is an
organisation inside it, so keyed by the partner alone, company A's Settings showed company B's probe error and
model list. A scope that names a company uses it; a scope that names only the partner, inside a request whose
session is the same partner's, takes the session's company; anything else on the hosted server is refused
(`company_required`, 500), never read from the partner's row. So company A's catalogue size, its probe errors and
the default model the host would pick from A's models never reach B, in the same partner or another. A desk reads
and writes the same file as before, and ignores the tenant and the organisation it is handed.

**What a Settings save does on the hosted server (SR-163 review round).** A provider key is the company's, so
`handlePostSettings` follows `saveSettings` (the caller's desk) with `mirrorKeysToCompanyDesks` →
`saveKeysToDesks` (`packages/host/src/settings-store.ts`): one write of the key fields this request carried
(`openaiApiKey`, `googleApiKey`, `anthropicApiKey`, `volcengineApiKey`) to the other desks of the caller's
**organisation** (`listLocalWorkspaces(db, tenant.organizationId)`). Before it, rotating a key on one desk left
the company's other desks on the old one: their fingerprint no longer matched the company's verdict, they answered
`403 gateway_blocked`, and a re-check from one of them could replace the verdict and close the first. A desk's
own choices (models, caps) are not copied, a blank key field is not a key write, and another company's desks are
never in the list. A desk calls none of this: a key saved there stays on that desk. `maskSecrets` takes the environment as a second argument and, on the
hosted server, reports `googleBaseUrl`, `anthropicBaseUrl` and `volcengineBaseUrl` as absent
(`secrets.ts:257`): the host does not honour a stored one there (`resolveProviderKeys`, `secrets.ts:346`), and
nothing writes one (the POST body never carried them), so echoing one would claim a setting that is not in force.
The renderer's Settings page keeps three state fields for them, set from the answer and read nowhere
(`apps/web/components/settings-page.tsx:138-140`, `:191-193`), and posts none.

**A company with a key and no cache row is refilled in the background (2026-10-01, hosted only; per company since SR-163, the paragraph below still says "tenant" where it means that company: its in-flight set, throttle and `refreshModelCache` scope are `{ tenantId, organizationId }`, and a scope that cannot name a company starts nothing and is logged).** Only a Settings
save (`handlers/settings.ts:272`) and Refresh (`handlers/models.ts:21`) write a tenant's `model_cache` row, so a
tenant that already held a key when the server upgraded into per-tenant caches had none: Chat listed static ids,
Images none, Meeting `no_model`, until somebody saved Settings again. `warmHostedModelCache`
(`packages/host/src/selectable-models.ts:505`) closes that. It is called after every catalogue read that has a tenant
in hand: `listCatalogModels` (`:78`, which every `list*Models`, `modeCatalogPayload`, `modelCatalogBody` and
`modeDefaultsFor` go through, so `GET /api/v1/models`, `/chat` and the `defaults` on this page's answer all
start it; the `probe` summary reads the cache directly and does not), `listProbedModels` with no cache argument (`:143`, the Videos studio's list) and `defaultSelectableModel`
(`:231`). It returns at its first line off server mode, so a desk never reaches it. On the hosted server it does
nothing unless the tenant's cache row is absent (`modelCacheStamp` is `"missing"`), then nothing if one is already
running for the tenant or one started inside `HOSTED_CACHE_WARMUP_THROTTLE_MS` (ten minutes, `:465`), then nothing if
`loadSettings` for the caller's desk holds no provider key (`hasLiveProvider`); a read that found no key spends no
throttle. Past those it starts `refreshModelCache(settings, { scope: { tenantId }, onlyIfMissing: true })` and does not
await it, so the read that started it answers at once with what it has and the next read after the probe lands is
live (the memo's stamp moves from `"missing"` to the row's, `:86`). `onlyIfMissing` (`:350`, checked at `:451` with no
`await` before the write) makes it write-if-absent: a Save or a Refresh that lands while the probe is out wrote a
newer answer, and the older one does not replace it. A failure (unreadable settings, a refresh that throws or rejects,
or a refresh that came back with a provider error and not one model, `probeFailureOf`, `:559`) is one
`model_cache_warmup_failed` log line carrying the tenant id and the redacted message, and never the read's problem
(`logWarmupFailure`, `:573`). **A probe that merely fails still writes a row** (with `openaiError` and no models,
exactly as a failed Settings save does), which ends the warm-up for that tenant: it stays empty, with the error in the
`probe` summary, until a save or Refresh, rather than retrying every ten minutes. Which desk's key: the one the caller's
`TenantContext` names (`workspaceIdOf`, `:549`), else the desk the request selected. **Not covered:** `cachedModelIds` (Meeting, `meeting/transcribe.ts:47`) and `resolveAsrCapability`
(Edit, `edit/asr.ts:52`) read `loadModelCache` directly and do not start it; in practice the shell's own
`GET /api/v1/settings` has, because `settingsPayload` reads `defaults` through the catalogue.

**What the owner can actually change on this page.** Two fields, and the POST body says so: the settings form
submits exactly `{ openaiApiKey, editTurnCapUsd }` (`apps/web/components/settings-page.tsx:279-293`, with the
comment "The endpoint is pinned by the host; never send it back"). On the hosted server a person who is not an owner
or an admin gets no key box (`settings-key-restricted` stands in for it) and the form submits `{ editTurnCapUsd }`
alone (`mayChangeKey`, `:133`, `:287`); see "Who may press it" under Start over. The language `<select>` is a separate POST
of `{ locale }` (`:302-312`) — see [`locale-boot-and-run-harness.md`](locale-boot-and-run-harness.md). The Edit
turn cap (`settings-edit-turn-cap`, `:496`) is a number input clamped to 0.5–50 on the way in and again on the
way out (`:214-215`, `:494`), default 2.

**Every settings request says when it did not land (2026-09-23).** All four — the first load, Save, the
language select and the Restart apply — go through `readSettingsAnswer` (`settings-page.tsx:99`), which never
throws: a request that did not come back, a non-JSON error page and an error body all become a sentence (the
host's own message when it sent one, the catalog's otherwise), and a closed gate becomes its reason. A failed
first load used to leave the page's defaults on screen as though they were this desk's settings; it now shows
`settings-load-error` (`:379`). A failed Save shows `settings-error` (`:505`). A failed language change used to
leave the select on the new language as if it had been saved; it now reverts the select and shows
`settings-locale-error` (`:416`), and the select is disabled while the change is in flight.

**Key resolution.** `resolveProviderKeys(settings, env)` (`packages/core/src/secrets.ts:319-331` for the signature, the body through `:345`), today — where `env` is not the process environment directly but `providerEnv(env)` (`packages/core/src/server-mode.ts:43-45`, with the rule written out at `:22-42`), which is `env` unchanged on a desk and a **frozen empty object** in server mode. That is Phase 4's change, and it is shared: the same helper backs the tool secret scope (`packages/core/src/tools/credentials.ts:308-312`), the runtime's per-provider fallback (`packages/core/src/runtime/ai-sdk-runtime.ts:165-176`), the tool scope a run executes in (`getSecret`, `packages/core/src/tools/secret-scope.ts:36-44` — the fallback every platform tool uses when its scope lacks a key, and the one a named sweep cannot see because its index is a variable) and, indirectly, Edit's off-request transcription (`packages/host/src/edit/asr.ts:79-87`, which asks `resolveProviderKeys` rather than the environment). `packages/core/src/provider-env-sweep.test.ts` fails the build if any other shipped source reads one of these variables off `process.env`, indexes it dynamically without an allowlisted exception, or destructures a credential out of it:

```
openai        = settings.openaiApiKey || env.OPENAI_API_KEY
openaiBaseUrl = resolvedGatewayBaseUrl()          // pinned, settings and env ignored
google        = settings.googleApiKey || env.GOOGLE_GENERATIVE_AI_API_KEY || reuseOpenAI("google")
anthropic     = settings.anthropicApiKey || env.ANTHROPIC_API_KEY || reuseOpenAI("anthropic")
volcengine    = settings.volcengineApiKey || env.ARK_API_KEY || env.VOLCENGINE_API_KEY || reuseOpenAI("volcengine")
```

`reuseOpenAI(dialect)` hands the OpenAI-slot key to another provider's slot when `guessDialectFromKey` says it
actually belongs there — i.e. someone pasted an Anthropic key into the one key field. Stub vs live is a separate
call, `resolveRuntimeMode({ settingsHasKey, envRuntime })` (`packages/core/src/secrets.ts:305-310`).

**Endpoint pinning.** `PINNED_GATEWAY_BASE_URL = "https://api.tokotokenai.com/v1"`
(`packages/core/src/gateway/pinned.ts:8`), with a SHA-256 of the literal checked by
`packages/core/src/gateway/pinned.test.ts`. The gateway can move only through `gatewayUrlOverride()`
(`packages/core/src/gateway/pinned.ts:72`). A packaged build (`AGENTFORGE_PACKAGED=1`, set by `main.cjs`
`bootstrapPackaged`, `apps/desktop/main.cjs:653-667`) reads only the brand gateway `AGENTFORGE_BRAND_GATEWAY_URL`,
which `main.cjs` assigns for a Kemenkeu AI or AIHub Metranet flavor and never for the public build. Anything else
reads the dev hook `AGENTFORGE_GATEWAY_URL` only when `gatewayUrlOverrideAllowed()` (`:38`): not packaged **and**
`NODE_ENV !== "production"`. The **gateway-pin test** (`packages/host/src/gateway-pin.test.ts`) enforces this by
grep: the `ALLOWLIST` of permanent exceptions must stay empty; no file under `packages/host/src` or
`packages/core/src` may read `settings.openaiBaseUrl` outside `secrets.ts`/`settings-store.ts`; and
`handlers/settings.ts` must not match `/body\.openaiBaseUrl/`, so the settings POST cannot accept an endpoint
override at all.

**2026-09-17 — the endpoint is hidden, not merely read-only.** The Settings row (`settings-endpoint`, an
eight-line read-only block) and the onboarding field (`onboarding-endpoint`, a `readOnly` input) were deleted
from the renderer, together with the `settings.endpointLabel` / `settings.endpointLocked` /
`onboarding.endpointLabel` / `onboarding.endpointLocked` copy keys in both locales. What replaced them:

- Onboarding does not show the address at all (2026-09-26). There is no `onboarding-gateway-host` and no
  `onboarding.gatewayHost` key. The key step says where to get a key in words (`onboarding.keyHelp`, naming
  `{gatewayName}`) and has exactly one input, the key (`apps/web/components/onboarding-screen.tsx:260-270`).
- Settings still names the host in two places, both prose: the intro sentence
  (`settings.intro` … "Paste your {gatewayName} API key from {gatewayHost}", `settings-page.tsx:371-375`) and
  the privacy note (`settings.privacy` … "Prompts leave this machine only over HTTPS to {gatewayHost}",
  `:523-525`). The privacy string used to say "to the saved endpoint"; today it names
  `api.tokotokenai.com` out loud. Settings calls `gatewayHostLabel(gatewayEndpoint)`
  (`apps/web/lib/product-brand.tsx:37-43`) — `new URL(url).host`, falling back to the raw string — so the
  path and scheme never reach that screen.
- Guard: `apps/web/lib/gateway-endpoint-hidden.test.ts` — no `settings-endpoint`, no `onboarding-endpoint`,
  neither component hardcodes `tokotokenai` outside comments, neither references the retired copy keys,
  onboarding does not reference `onboarding.gatewayHost` or `gatewayHostLabel`, and both onboarding catalogs
  omit `gatewayHost` / `endpointLabel` / `endpointLocked` and contain no URL.

Host and core logic are unchanged. This is a fourth, presentation-only layer on top of the three real pins.

**What a save does besides saving.** `handlePostSettings` (`packages/host/src/handlers/settings.ts:342`)
runs `saveSettings(patch, tenant)` and then four side effects, in order, so a corrected key or URL
takes effect on the next request instead of after a breaker expires:

| Call | Why |
|---|---|
| `clearThisKeyCache()` (`:388`) | the per-key usage strip is keyed on the old credential |
| `resetEmbedCircuit()` (`:392`) | the embeddings breaker holds a workspace down for five minutes |
| `resetModelReliabilityState()` (`:393`) | **added 2026-09-17 as `resetJobModelCircuit()`, widened 2026-09-30** — the job-model fallback breaker skips a model for the same five minutes (`JOB_MODEL_DOWN_MS`, `packages/host/src/job-model-fallback.ts:27`), so a save that fixes the key must clear it too or the desk keeps routing around a model that now works. It also forgets the Thinking levels the runtime learned a model refuses (`resetLearnedEffortLimits`, `packages/core/src/runtime/effort-selfheal.ts:254`; they also expire on their own after 30 minutes and are kept per tenant): a new key or endpoint may sit in front of a different upstream, so nothing learned about a model holds (`resetModelReliabilityState`, `packages/host/src/job-model-fallback.ts:67`) |
| `revokeKnowledgeGatewayModel(...)` (`:397`) | the retrieval sidecar holds a *copy* of the key inside the model row it embeds with; a key changed here but left in that row has not been rotated |

After those, `refreshModelCache(saved, { scope: tenant })` (`packages/host/src/handlers/settings.ts:399`) lists
the models the saved keys can see and writes **this tenant's** cache: a `tenant_state` row on the hosted server,
the machine file on a desk (`packages/host/src/selectable-models.ts:336`; a failure is swallowed, airplane mode).
On the hosted server it probes Anthropic and Google at the provider registry's hosts and only behind a key
(`:343`), where a desk still probes the stored base URL, and a stored Volcengine URL with no key behind it probes
nothing. `POST /api/v1/models` (Refresh) does the same with `forceRegistry`, scoped to the caller
(`packages/host/src/handlers/models.ts:21`).

**What the answer carries (SH-002).** The 200 names every body field the handler does not read, in `ignoredFields`. The set is `KNOWN_SETTINGS_FIELDS` and the helper is `unknownSettingsFields` (`packages/host/src/handlers/settings.ts:276` and `:301`). Such a field is not applied, but the save still goes through, so a body with a typo next to a real key keeps the key. The list holds names only, at most 20 names of 64 characters each, in the order the body sent them. The property is absent when there is nothing to report, so a clean save answers the shape it always had, and a body that is not a JSON object reports none. The set is kept by hand against every `body.*` read in the file: a new read that is not added there is reported as ignored until it is. The three renderer callers (onboarding key, Settings save, Settings language) post only listed names, and the renderer reads the 200 loosely, so the extra property changes nothing there.

`resetGatewayKey` runs the same two breaker resets (the embeddings one and the reliability state) on sign-out — see **Start over** below.

### The gateway gate

Contract: `packages/core/src/gateway/gate-types.ts` —
`{ status, allowed, grace, endpoint, endpointLocked: true, checkedAt, lastOkAt, message? }`, `status` in
`stub | needs_key | ok | invalid_key | unreachable | error`.

`reportGatewayGate(settings)` (`packages/host/src/gateway-gate.ts:477-492`) resolves the key to judge
(`keyFor`, `:464-474`), fingerprints it, loads that owner's verdict (`ownerOf`, `:169`: the tenant on a desk,
the company inside it on the server; `loadGateState`, `:221-251` — **the verdict is keyed by fingerprint; the
key itself is never written**), and hands both to the pure `deriveGatewayGate` (`:352-401`), which applies in
order:

| Condition | Result | Line |
|---|---|---|
| `envRuntime === "stub"`, off server mode | `{status:"stub", allowed:true, grace:false}` | `:360-362` |
| no key, or `stub` runtime on the server | `{status:"needs_key", allowed:false}` | `:363-365` |
| no verdict, or verdict for a different fingerprint | `{status:"ok", allowed:true, grace:true, message:"Not checked yet."}` — **opened on trust** (hosted server mode instead answers `error` / `allowed:false`, `:370-372`) | `:378-380` |
| verdict `ok`, fresh (< `GATEWAY_OK_TTL_MS`) | `allowed:true, grace:false` | `:382-387` |
| verdict `ok`, stale | `allowed = withinGrace(lastOkAt, …)`, `grace:true` | `:388-389` |
| verdict `invalid_key` | `allowed:false, grace:false` — **no grace, ever** | `:392-394` |
| verdict `unreachable` / `error` | `allowed = withinGrace(…)`, and `grace` mirrors `allowed` | `:395-398` |
| persisted `stub` / `needs_key` verdict | treated as never-checked | `:399-401` |

**Phase 4 changed two things here, both about the hosted server rather than the desk.** SR-163 added a third, below them.

- **The verdict moved behind a backend.** `statePath(tenantId)` is gone. `loadGateState`, `saveGateState`
  and `clearGateState` (`:221-251`, `:262-277`, `:279-290`) go through `tenantStateBackend()`
  (`packages/host/src/tenant-state-store.ts:368-370`) under the key
  `gateway_gate` (`packages/core/src/tenancy/state-keys.ts:19`). On a desk that resolves
  to exactly lane D's file — `<dataDir>/gateway-gate.json` for `local-tenant`, under `tenants/<tenantId>/`
  otherwise, which is what stops two tenants overwriting each other's verdict — because the file backend
  maps the key back through `TENANT_STATE_FILENAMES` (`:48-51`), the one place in the host that may spell
  those filenames. On the server it is a row in `tenant_state`. See
  [`tenant-secrets-backend.md`](tenant-secrets-backend.md).
- **`keyFor` refuses the process environment in server mode** (`:464-474`). A saved key is still the key.
  But with none saved, an `OPENAI_API_KEY` in the host's own environment belongs to the **operator**, and
  handing it to a tenant who has saved nothing is residual A01-3. The gate now answers `needs_key` there,
  which is what `resolveProviderKeys` does on the call path (`packages/core/src/secrets.ts:319-331`,
  the fallback taken from `providerEnv` at `:306`), so the verdict and the call agree about
  whether this tenant has a key at all. Off server mode nothing moved: a
  desk running `AGENTFORGE_RUNTIME=ai` with a key in its environment still works exactly as before.
  The gate is only half of it, though: it can only protect work that happens **inside a request**.
  Edit's auto-captions run on the timeline worker afterwards, where there is no request to answer
  `403` to, which is why `edit/asr.ts` resolving its own bearer mattered rather than being tidiness
  — see [`tenant-secrets-backend.md`](tenant-secrets-backend.md).
- **SR-163 — on the server a verdict belongs to a company, not to the partner.** `TenantContext.tenantId` is
  the white-label partner (for example Nultron Enterprise) and `organizationId` is the company inside it; a
  deployment is one partner with many companies. Keys were already per desk, and a desk belongs to one
  organisation, but the verdict was one `gateway_gate` row per partner. Company B's check replaced company A's
  verdict, A's key matched nothing on file, and the hosted gate closes on "no verdict for this key": A's next
  Chat turn answered `403 gateway_blocked` (the 2026-10-07 load-rig finding). Now `ownerOf`
  (`packages/host/src/gateway-gate.ts:169-188`) names the verdict's owner: the tenant alone on a desk, and on
  the server the tenant plus `scope.organizationId`, which it requires (`company_required`, 500, if a hosted
  caller has none: `COMPANY_REQUIRED_CODE`, `:156`). It follows the backend, not a second `isServerMode()`:
  only the row backend has a company slot, so a desk cannot produce one. The slot is the `gateway_gate` key
  narrowed to `gateway_gate:<organisation id>` (`gateSlot`, `:190`; `companyStateKey`,
  `packages/host/src/tenant-state-store.ts:86`), a row under the partner's own tenant id in the same
  table, so the foreign key still holds and the hosted erase still takes every row with the partner. The file
  backend refuses a company slot (`statePath`, `tenant-state-store.ts:119-125`); the row backend does not
  adopt a legacy file into one (`:320`). The verdict an older build wrote for the whole partner is read in one
  case only (review round): `loadVerdictFor` lets a company whose own slot is empty adopt it, `lastOkAt`
  included, when its fingerprint is exactly the fingerprint of the key the company holds; never for another key.
  The background re-check's throttle slot carries the company on the server too (`:676-678`), so two companies
  holding the same key each get a check; a desk keeps `<tenant>:<fingerprint>`. `requireGatewayAllowed` still
  asks the **partner's** plan (`requireEntitlementAllowed(tenantId)`, `:547`): the plan row is one per
  tenant id, which is not part of this change. Tests: `packages/host/src/gateway-gate-companies.test.ts` (two
  companies under one partner through the real router, and the Personal bytes) and
  `packages/host/src/tenant-secrets.test.ts` (the rows, the refusal, the legacy row). **Cost on deploy:** a
  hosted company has no verdict of its own until its first Settings read starts a check, so one Chat turn
  sent before that read can answer `403 gateway_blocked` once.

Constants (`packages/host/src/gateway-gate.ts`): `GATEWAY_GRACE_MS = 7 * 86_400_000` (`:53`),
`GATEWAY_CHECK_TIMEOUT_MS = 3_000` (`:56`), `GATEWAY_OK_TTL_MS = 86_400_000` (`:62`),
`GATEWAY_REFRESH_THROTTLE_MS = 600_000` (`:65`), `GATEWAY_UNCHECKED_MESSAGE = "Not checked yet."` (`:68`),
`GATEWAY_UNVERIFIED_MESSAGE` (`:75`), `GATEWAY_VERDICT_UNWRITABLE_MESSAGE` (`:82`). The grace boundary is
inclusive — exactly 7 days still counts (`withinGrace`, `:330-333`, pinned at
`packages/host/src/gateway-gate.test.ts:146-155`); the TTL check is `withinOkTtl` (`:336-339`).

**The live check** is `checkGatewayLive` (`packages/host/src/gateway-gate.ts:416-451`): `GET {baseUrl}/models`
with `Authorization: Bearer <key>` under `AbortSignal.timeout(3_000)`, after `assertAllowedEndpointUrl` rejects
plain-HTTP remotes. 2xx → `ok`; 401/403 → `invalid_key` (message is `HTTP {status}`, the key is never echoed);
other non-OK → `error`; thrown/timeout → `unreachable`. `runGatewayCheck` (`:574-624`) wraps it: it
short-circuits on stub or no key (`:581-583`), maps a throw to `unreachable` (`:596-600`), carries `lastOkAt`
forward only for the same fingerprint, **in the same company on the server** (`:602`), persists to the owner's
slot, and — when the verdict could **not** be written — answers `status: "error"` with `allowed` untouched
(`:616-623`).

It runs on a key save (`refreshGatewayGateAfterSave` → `runGatewayCheck`,
`packages/host/src/handlers/settings.ts:320-336`), and which verdict the save response carries is decided by
`gateVerdictFor` (`packages/host/src/handlers/settings.ts:309-318`). It also runs on
`POST /api/v1/settings/gateway/check` (`handleGatewayCheck`,
`packages/host/src/handlers/settings.ts:338-346`, route at `packages/host/src/router.ts:263`). Separately, `maybeRefreshGateway` (`packages/host/src/gateway-gate.ts:660-702`)
fires an un-awaited check at most once per tenant and key per 10 minutes (per company and key on the server) from `handleGetSettings`
(`packages/host/src/handlers/settings.ts:153`) — that is what turns "opened on trust" into a real verdict over time.
Which verdicts it re-checks is `needsGatewayRefresh` (`packages/host/src/gateway-gate.ts:670-678`): no verdict for
this key, an `ok` past its 24 h TTL, and, since 2026-10-06 (0.16.0 cut), an `unreachable` or `error` verdict
(`:677`; cites re-anchored 2026-10-11). Before that, one failed check stayed on disk until `lastOkAt` left the 7-day grace and the desk closed, though
the gateway had come back (the 2026-10-05 verify-pass finding). `invalid_key` is still never re-checked on its own;
only a new key or Re-check replaces it. Tests: `packages/host/src/gateway-gate.test.ts:521` (unreachable and error,
throttled), `:538` (invalid_key left alone), `:547` (a desk closed past grace reopens once the check answers `ok`).
The same states through the router, against a fake loopback gateway, are `packages/host/src/gateway-gate-fake-gateway.test.ts` (SH-004, 2026-10-11).
The check only rewrites the verdict on disk: a renderer already showing the closed onboarding screen re-reads it on
its next `GET /api/v1/settings` (a relaunch, or the screen's Re-check), not by itself.

**Enforcement.** `requireGatewayAllowed(settings)` (`packages/host/src/gateway-gate.ts:545-553`) throws
`GatewayBlockedError` when `!gate.allowed`, and `jsonError` flattens it (`packages/host/src/errors.ts:17-26`) to
`403 { error: "gateway_blocked", status, message }` — a flat body, deliberately not the usual
`{error:{code,message}}` envelope, so `parseGatewayBlocked` can read it without unwrapping. Call sites, all
verified at this sha: `handlers/runs.ts:30`; `handlers/jobs.ts:71, 109, 155, 166, 177, 188, 215, 226, 254, 266, 279, 291`;
`handlers/knowledge.ts:174, 191, 207, 253, 288, 310, 370, 403`; `handlers/finance.ts:17, 32, 52, 64`;
`handlers/market.ts:29, 41, 55`; `handlers/edit.ts:314, 542`; `handlers/enhance-prompt.ts:53` (hosted: also for a tenant
with no key, which no longer gets the local stub rewrite, `:49`);
`handlers/legal.ts:114`; `handlers/meetings.ts:139, 155, 174`.

**Phase 5 lane B: the plan is enforced in the same function, and first.** `requireGatewayAllowed`
calls `requireEntitlementAllowed(tenantOf(opts))` (`packages/host/src/entitlement-store.ts:431-452`)
before it derives the gate, so every call site above gained the allowance without one of them
changing, and none of them gained an `await` — `better-sqlite3` is synchronous, and off server mode
the function returns before it asks for a connection. A refusal is a `PlanBlockedError` carrying
`plan_past_due`, `plan_cancelled` or `plan_allowance_exhausted`, never `gateway_blocked`: that code
routes the renderer to onboarding, which is a dead end for a hosted tenant who holds no key. See
[`tenant-entitlement.md`](tenant-entitlement.md).

Deliberately **open**: settings, workspaces, threads, artifacts, media, usage, model refresh — proved by the
absence of the import in those handler files and directly by
`packages/host/src/handlers/settings.test.ts:186-192` ("does not gate settings, usage or threads"). A closed gate
must always be recoverable. Phase 5 lane B adds two more for the same reason: `GET /api/v1/billing/plan`
and `POST /api/v1/billing/top-up` (`packages/host/src/router.ts:275-276`), so a tenant the **plan**
has blocked can still read why and pay.

**What a closed gate actually looks like** (driven 2026-09-17 on an isolated desk started with
`AGENTFORGE_RUNTIME=ai` and no key; evidence in `evidence/gateway-gate/2026-09-17-cc-map/`):

- `GET /api/v1/settings` → `gateway: { status: "needs_key", allowed: false, grace: false, checkedAt: null }`.
- **Every** route of the SPA renders the onboarding screen, not just `/chat`: `/settings` answers with
  `settings-form` count 0. A fresh `needs_key` desk shows `onboarding-welcome` first; `onboarding-form` is the
  next step. A desk closed with `invalid_key`, `unreachable`, or `error` opens on that form, with
  `onboarding-gate-reason`. The ways back are a key the host allows, a re-check the host allows, or opening
  another desk the host allows — each of those shows `onboarding-try`, and `onboarding-start` opens Chat — or
  deleting `gateway-gate.json` by hand.
- `POST /api/v1/finance/parse` → `403 {"error":"gateway_blocked","status":"needs_key","message":"No gateway key is saved on this machine."}`.
- After saving a deliberately invalid key: `status: "invalid_key"`, `allowed: false`, payload `message: "HTTP 401"`,
  and the same route answers `403 {… "status":"invalid_key","message":"The gateway rejected the saved key. HTTP 401"}`.
- Open routes with the gate closed, all `200`: `/api/v1/settings`, `/api/v1/threads`, `/api/v1/workspaces`,
  `/api/v1/usage`, `/api/v1/models`.

**Renderer.** `parseGatewayGate` (`apps/web/lib/gateway-gate.ts:56-75`) requires a known `status` and a boolean
`allowed` or returns `null`; `MISSING_GATEWAY_GATE` fails closed. `resolveGate(payload, isElectron, hosted, deferral)` (`:77`)
obeys a reported gate as-is, and on a missing or malformed one falls closed **on every build** (since 2026-10-16; before that
webdev stayed open). Webdev and Playwright still open, because the stub host reports `status: "stub", allowed: true`. The one exception to "obeys a reported gate as-is" is the hosted deferral: a closed gate opens the desk for a signed-in hosted person who chose "Add it later" (next section), and for nobody else. `App.tsx` holds `gate` / `gateway` / `localeEpoch` state
(`apps/web/src/App.tsx:77-79`), listens for `GATE_EVENT = "agentforge-gate"`
(`apps/web/lib/gateway-gate.ts:108`, listener at `App.tsx:89-97`), re-fetches settings and re-resolves on every
locale epoch (`:99-122`), and renders `OnboardingScreen` when `gate === "onboarding"` (`:139-140`). Reason copy
maps through `REASON_KEYS` (`apps/web/lib/gateway-gate.ts:123-127`) to
`onboarding.gate.invalidKey / unreachable / error`; the Settings status word maps through `gatewayStatusKey`
(`:135-137`) to `settings.gateway.status.<status>`.

### Add the key later (Enterprise only)

Owner decision, Rizky 2026-10-01: on the hosted app, after a portal sign-in, "on the onboarding they can choose to put the API key later". Before it, a signed-in tenant with no key landed on the three-step welcome whose second step asks for a key, and every route showed the same screen (`webapp-deploy/k8s/README.md`, "Product behaviour the rehearsal ran into"). **The Personal app does not have this and must not get it.** The switch is the hosted marker the server stamps into the page (`isHostedBuild`, `apps/web/lib/hosted-build.ts`) on the renderer side and server mode on the host side; every piece below is inert without it.

**What the host does.** Two small things, both server mode only, and **nothing in the gate**:

- `POST /api/v1/settings/key-later` (`handlePostKeyLater`, `packages/host/src/handlers/key-later.ts`; route `packages/host/src/router.ts:293`) records `users[userId].keyLater = { at }` in the sealed settings payload beside the language and the guide's record (`saveUserKeyLater`, `packages/host/src/settings-store.ts:682`; `UserPrefs` and the `usersMap` sanitiser in the same file; the pure record is `packages/host/src/key-later.ts`). Its own route, for the guide's reason: a settings save revokes the knowledge model row and re-probes the gateway. The body is ignored and the time is the host's. Off server mode it answers `404 not_found`, the answer an unregistered path gets. It is not gated: choosing to wait for a key needs no key.
- `settingsPayload` carries `keyLater: { chosen, at }` (`packages/host/src/handlers/settings.ts`, spread in only when `serverMode`; `handleGetSettings` and `handlePostSettings` take the injected `ServerModeDeps`). The Personal answer has no such field.
- **It is a preference about the screen, never a decision about the host.** `deriveGatewayGate` and `requireGatewayAllowed` never read it. After it is written the gate still reads `needs_key` / `allowed: false` and every gateway-calling route still answers the flat `403 gateway_blocked`; `packages/host/src/handlers/key-later.test.ts` pins both. It is erased by Start over (`settings.enc` is the first wipe entry) and by the hosted tenant erase (the `tenant_state` row goes), and **not** by saving a key or signing out of the gateway: a key that later stops working must not bring the welcome back.

**What the renderer does.**

1. `resolveGate(payload, isElectron, hosted, deferral)` (`apps/web/lib/gateway-gate.ts:101-127`, with the `KeyDeferral` type and its default `NO_KEY_DEFERRAL` at the end of that range) gained a fourth argument, `{ hasSession, later }`. A gate the host reported **closed** opens the desk only for `hosted && hasSession && later`; an unreported gate is still closed on a hosted build, and an allowed gate is still open. With the default, or off the hosted build, the function is exactly what it was. Before the person has chosen, a signed-in tenant still sees the welcome once: that is where the choice lives. (AGENTS.md's older "the renderer gate becomes `allowed || hasSession`" is the design this refines: a session alone does not open a closed gate, a session plus the remembered choice does.)
2. `AppRoutes` (`apps/web/src/App.tsx`) derives the deferral from the hosted marker, the session and the settings answer (`deskDeferral`, `apps/web/lib/key-later.ts:37`), keeps it in a ref for the gate-event listener (`deferralRef`, `:225`), and hands `OnboardingScreen` an `onLater` callback **only** when `canOfferKeyLater(hosted, session.status)` (`:223`, `:345`). The callback records the choice (`recordKeyLater`, fire-and-forget) and the screen then calls its own `onDone`, so Chat opens and the tour is offered the one way it always is.
3. `OnboardingScreen` (`apps/web/components/onboarding-screen.tsx`) shows `onboarding-later` ("Add it later" / "Tambahkan nanti", a secondary button next to Check this key) and `onboarding-later-hint` on the **key step** when it was given `onLater`, and nothing otherwise.
4. **A shared gate store** (`apps/web/lib/gate-state.ts`): the work-mode panes are kept alive, so a pane that read the gate once at mount would keep telling a tenant to add a key after they had saved one in Settings. Settings reads (`settings-read.ts`), the Settings page's own answers (`applyPayload`), a re-check (`checkGateway`) and the gate event publish the host's newest gate; `apps/web/lib/gateway-blocked.ts` (`noteGatewayResponse`, called beside `notePlanResponse` in `apiFetch`) flags any `403 gateway_blocked`. An open gate clears the flag, and a refusal also asks the host for its own gate again, at most once per `RECONCILE_MIN_GAP_MS` (`reconcileGate`), so a flag raised by a verdict that has since recovered cannot leave every pane quiet. A key accepted on the onboarding screen publishes its gate too (`applyGate`). **Both writers are no-ops off the hosted build**, and `useDeskNeedsKey` returns the store's answer only when hosted (`resolveNeedsKey`), its own mount-time read otherwise.
5. **Every pane says it, calmly.** `NeedsKeyNote` (`apps/web/components/needs-key-note.tsx`, copy `common.needsKey.note`, link `<testid>-settings` to `/settings`) in Research, Data, Finance, Market, Legal, Meeting, Presentations and Knowledge (`useHostedNeedsKey`, which is `false` and request-free off the hosted build), with Send / Generate quiet; **only** the refused-for-no-key banner (`isGatewayBlockedText`, the catalog sentence a hosted 403 is mapped to by `messageUnlessBlocked`) gives way to the note, and every other error (an upload that failed, a gallery that did not load) shows as it always did; Chat, Documents, Images, Videos, Music and Edit's Generate tab already had a needs-key line and keep it (Chat's and Documents' gain the Settings link when hosted); Edit's Agent pane had none and gains `edit-agent-needs-key` (`apps/web/components/edit-agent-panel.tsx`, `needsKey` from `useHostedNeedsKey()` in `edit-studio.tsx`) with `edit-composer-send` quiet, and the studio hides the red banner when the error is the refused-for-no-key sentence. Hosted only too: the ffmpeg install guide is one calm line with no command, copy button, re-check or link (`ffmpeg-setup-notice.tsx`), and the onboarding key step does not offer it (`needsFfmpeg`, `onboarding-screen.tsx`). Education makes no gateway call (`packages/host/src/handlers/education.ts`) and has no note. A `403 gateway_blocked` in a job stream becomes a `gateway_blocked` `JobStreamError` with catalog copy on the hosted build (`errorFromJson`), and Chat's refused send, Documents, Presentations, Meeting, Images, Videos, Music, Knowledge and Edit's agent say the same sentence instead of "Request failed". A choice made this session survives a settings re-read that lands before the host has stored it (`choseLaterRef` in `App.tsx`).

Tests: `apps/web/lib/gateway-gate.test.ts` ("the hosted deferral", including the Personal block), `gate-state.test.ts`, `gateway-blocked.test.ts`, `key-later.test.ts`, `onboarding-key-later.test.tsx`, `needs-key-states.test.tsx` (every pane, hosted against Personal), `key-later-wiring.test.ts`, `job-stream.test.ts`; host `handlers/key-later.test.ts`.

### Start over

Card `settings-reset` (`apps/web/components/settings-reset-card.tsx:159`), mounted at
`apps/web/components/settings-page.tsx:535`, fed by `resetPending` on the settings payload.

**Sign out (`scope: "key"`)** — no typed confirmation, fully synchronous. `resetGatewayKey`
(`packages/host/src/handlers/settings.ts:482-508`) calls `clearGatewayKeyEverywhere(tenant)`
(`packages/host/src/settings-store.ts:549` — **every desk of the caller's tenant**, because "a key left on
a second desk would keep the gate open after 'forget my key'"; Phase 3 lane D narrowed it from the whole
install). **On the hosted server it is the caller's company's desks only (SR-163):** the handler asks for the
organisation's desks (`listLocalWorkspaces(db, tenant.organizationId)`, `:492`) and passes them as `within`
(`ClearKeyWithin`, `settings-store.ts:536`), because a hosted tenant is the partner and clearing "every desk of
the tenant" signed every other company out of the gateway. A desk calls it with no `within`, exactly as before. Then
`clearGateState(tenant)` (that company's verdict on the server), `clearThisKeyCache()`, `resetEmbedCircuit()` and — added 2026-09-17 —
`resetModelReliabilityState()` (the job-model breaker and the learned Thinking-level limits). Returns `relaunch: false`. Threads, desks and media are untouched. The
card navigates to `/chat` and calls `announceGate(result.gateway)`, which dispatches `GATE_EVENT` and drops the
shell to onboarding.

**Phase 4 opened `scope: "key"` on the hosted server.** It used to answer 403 there, on the same reasoning as
`scope: "all"`. That reasoning does not hold: everything this route touches is the caller's own tenant —
lane D scoped `clearGatewayKeyEverywhere` and `clearGateState` to `tenant`, and the three cache resets are
process-wide breakers that cost a re-check and nothing else. Refusing it also left a hosted tenant with **no**
way to remove a saved key, because a blank `openaiApiKey` in a settings POST is dropped rather than applied
(`keyFieldValue`, `packages/host/src/handlers/settings.ts:227-232`; on the desk too since 2026-10-06, so `scope: "key"`
is now the only way to forget a key on either product); both halves are pinned by `packages/host/src/handlers/settings.test.ts`
("allows scope key, because the key it forgets is the caller's own", and "is the only way a hosted tenant can
clear its key"). `scope: "all"` stays refused (`resetEverything`, `:423-440`): that one really does wipe the
shared data directory.

**Who may press it (M4, 2026-10-02).** The key is the *company's*, so on the hosted server saving, replacing and forgetting it
are owner-or-admin acts: `canAdminister(tenant.role)` (`assertMayChangeCompanyKey`,
`packages/host/src/handlers/settings.ts:271`), the bar the agent service uses, and not the owner-only bar of the company
erase (`tenant-reset.ts`). A member or a `builder` is answered `403 settings_key_forbidden`
(`SETTINGS_KEY_FORBIDDEN_CODE`, `:252`). Before this a member could swap the company onto their own key or sign every
person out of the gateway, and a live member `POST /api/v1/settings/reset { scope: "key" }` answered 200. Two entry
points, both server mode only: `handlePostSettings` checks `requestsKeyWrite(body, serverMode)` (`:266`, `:290`) **before
any write**, so a body that mixes a key with something a member may change (their language, the Edit cap) is refused
whole; `handleResetApp` checks it for `scope: "key"` (`:574-579`). "A key write" is what `keyFieldValue` lets into the
patch, a non-blank string in `openaiApiKey`, `googleApiKey`, `anthropicApiKey` or `volcengineApiKey`: a blank (which the
Settings page no longer sends since 2026-10-06), and a non-string, are no-ops and stay allowed, so a member's ordinary save
(language, spend cap) still works. `toolKeys`, `toolBackends` and `injectionGuardBypass` are refused for everybody by
`requestsOperatorOnlySettings`, as before. Off server mode neither check runs and no role is read: a desk's person is
its owner. The renderer hides what the host would refuse (`apps/web/lib/company-key-access.ts`, read from the session's
`role`): the key box and Save's key field in Settings, the "Sign out of the gateway" row (the whole `settings-reset`
card when nothing else is left in it) and the onboarding key step, where a member is told who can add the key and keeps
Back, Check again and Add it later. Unknown is treated as a member. Pinned by `packages/host/src/handlers/settings-key-roles.test.ts` (member, builder, admin,
owner, the mixed body, the blank echo, the Personal switch) and `apps/web/lib/company-key-access.test.tsx` (including a
golden of the Personal page, `lib/__fixtures__/personal-settings-page.golden.json`). Not covered: a member can still raise
the Edit turn cap (`editTurnCapUsd`), which is the company's spend ceiling, and can still re-check the gateway
(`POST /api/v1/settings/gateway/check`, a read of the verdict).

**Fresh install (`scope: "all"`)** — typed `RESET` required. The button is disabled until
`typed.trim() === RESET_CONFIRM_WORD`, but what travels is **what the owner actually typed**
(`apps/web/components/settings-reset-card.tsx:134-136`), and the host re-checks it independently
(`packages/host/src/handlers/settings.ts:427-429`, 400 otherwise). Then
`requestDataReset(localDataDir(), [...HOST_RESET_ENTRIES])` (`:431`) writes the marker — nothing is deleted yet,
because "the database is open and ffmpeg may still be writing" (`:430`) — followed by `killTrackedChildren()`,
and the answer is `{ relaunch: true, resetPending: true }`.

The marker is `reset-pending.json` (`RESET_MARKER_FILE`, `packages/db/src/reset.ts:26`), written
temp-file-then-`renameSync` so a crash cannot leave a half-written marker that parses.

**The wipe list is named entries, never the directory** (`HOST_RESET_ENTRIES`,
`packages/host/src/handlers/settings.ts:356-384`),
because in the packaged app that same folder is Electron's userData / Chromium profile:

```
settings.enc  settings.json  .master-key  gateway-gate.json  media
workspace-id.txt  desk-usage.json  tenants  datasets  edit  legal
models-cache.json  models-dev-cache.json  models-dev-cache.meta.json  components  logs
```

plus, always, `SQLITE_ENTRIES` — `agentforge.sqlite`, `-wal`, `-shm` (`packages/db/src/reset.ts:29`), which
`applyPendingDataReset` unions onto the marker's own list at `packages/db/src/reset.ts:318-319` ("the SQLite trio is
added by `applyPendingDataReset`, because `@agentforge/db` owns it",
`packages/host/src/handlers/settings.ts:351-352`), and, when `DATABASE_URL` points out of tree, that trio by
absolute path (`removeDatabaseElsewhere`, `packages/db/src/reset.ts:216-269`). Pinned exactly by
`packages/host/src/handlers/settings.test.ts:451-473`, which also asserts `host-status.json` and anything
containing "storage" never appear (`:475-476`), and again — against `TENANT_STATE_FILENAMES` rather than a
literal — by `packages/host/src/tenant-state.test.ts`, so a payload that gains a file can never be left off
the list. Preserved: `host-status.json`, `Local Storage/`, every other
Chromium artifact, and `legacy-migrated.json`.

**Applied at boot, before SQLite opens.** `packages/db/src/client.ts:38-46` — when
`AGENTFORGE_APPLY_PENDING_RESET === "1"` and no connection exists, `applyPendingDataReset(localDataDir())` runs
at module top level, just before `new SqliteDatabase(file)`, and logs one line of counts from
`resetOutcomeSummary` (`packages/db/src/reset.ts:345`) — "Start over applied: N item(s) removed", or, as a
warning, "Start over is not finished: …". Counts only: the entries include the key file, and a database kept
outside the data dir is reported by its absolute path.

**A wipe that fails part-way is retried, not dropped (2026-09-23).** Each removal reports `removed`, `absent`,
`skipped` or `failed`; only `failed` keeps the wipe pending. When anything failed — on Windows, a file another
process still holds, with `EBUSY` or `EPERM` — `keepForRetry` rewrites the marker to name only what is still owed
and leaves it for the next launch (`packages/db/src/reset.ts:276-289`, called at `:336`), and the outcome says
`applied: false`. The SQLite trio goes back on the list only when part of it is what failed: once it is gone the
app opens a fresh database on this same boot, and a retry must not delete that one (the marker's
`database: false`, `:40`). A failed entry is logged by its name and error code, never by path (`:201`). Before
this change the marker was dropped whatever happened, so a locked `.master-key` or `settings.enc` simply stayed
behind after the owner had confirmed the erase ([SR-77](../security-register.md#sr-77),
[SR-78](../security-register.md#sr-78)). That env flag is set in exactly two places:
`apps/web/server-env.ts:54` (webdev) and `apps/desktop/main.cjs:652` inside `bootstrapPackaged()`, before
`require("./host.cjs")` — so a test or script that imports `@agentforge/db` can never trigger a wipe as a side
effect.

**Relaunch.** `relaunchDesktopApp({reset:true})` → preload `relaunch` → `ipcMain.handle("app:relaunch", …)`
(`apps/desktop/main.cjs:554`), which first checks `isTrustedSender(event, mainWindow)`
(`apps/desktop/navigation.cjs:109`) and refuses a non-main-frame sender with `{ok:false, reason:"forbidden"}`.
`relaunchApp(true)` (`apps/desktop/main.cjs:212-241`) consults `lifecycle.relaunchPlan()` (refuses while
installing an update or already exiting), races `clearRendererState()` — `clearStorageData` + `clearCache` +
`clearAuthCache` + `clearCodeCaches` (`:181-193`) — against `CLEAR_STORAGE_TIMEOUT_MS = 3000`, then
`app.relaunch()` and `app.exit(0)`.

### Failure modes

| Case | Behaviour |
|---|---|
| Verdict missing, unreadable, or not JSON | `loadGateState` returns `null` (`packages/host/src/gateway-gate.ts:221-251`) → opens on trust on a desk (closes on the server, where "no verdict for this key" is a closed gate). Deliberately unlike the sealed settings payload, which refuses rather than reset: a verdict is a cache of something the gateway said, so losing one costs a re-check |
| Verdict cannot be written | `saveGateState` warns and returns `{persisted:false}` (`:262-277`); `runGatewayCheck` then answers `status:"error"` with `allowed` as derived (`:616-623`) — "an unwritable data dir must not close a desk" |
| Live check throws / times out | mapped to `unreachable` (`:596-600`), never thrown |
| Background re-check throws | swallowed (`:698-700`); the un-awaited promise also carries its own `.catch` (`:697`) |
| A hosted gate call names no company (SR-163) | `ownerOf` throws `company_required` (500) (`packages/host/src/gateway-gate.ts:169-188`), also from `clearGateState`; never a fall back to the partner's row. Real requests always carry an organisation, so this is a bug in a caller, not a user's state |
| A hosted company whose verdict row is missing | Closed (`error`, `allowed:false`, "has not been verified") until a check writes it; the first Settings read starts one. Right after SR-163 lands, a company whose key is the one the old partner row judged adopts that verdict (and its `lastOkAt`, so grace survives an unreachable first check, `loadVerdictFor`); a company with any other key starts here |
| A hosted "Erase company account" on a partner that holds more than one company | `409 tenant_erase_shared_partner` from `resetTenant` (`assertSinglePartnerCompany`, `packages/host/src/tenant-reset.ts`), after the owner and confirmation checks and before the audit row or any delete; the panel shows `settings.reset.eraseAccountShared`. One company per partner erases as before. Scoping the purge to one company is still owed (owner's decision) |
| Save with an empty key string | A no-op for the key, on the desk and on the server (since 2026-10-06): the renderer leaves a blank field out of the body (`settingsSaveBody`, `apps/web/components/settings-page.tsx:107`, used at `:300`), the host drops a blank anyway (`keyFieldValue`, `packages/host/src/handlers/settings.ts:227-232`), and the verdict is left alone (`refreshGatewayGateAfterSave` returns early, `:404`). The rest of the body (the Edit cap) still saves. A key is forgotten only through `scope: "key"` (`resetGatewayKey`, `:482`). Before: off server mode a blank went to `mergeSecrets`, which deleted the key, and `refreshGatewayGateAfterSave` cleared the verdict on both products, so a save made only to change the Edit cap signed a desk out of the gateway (2026-10-05 verify-pass finding). Tests: `packages/host/src/handlers/settings.test.ts:290` (key and verdict kept), `:306` (`scope: "key"` forgets both), `:376` (desk blank and whitespace), `apps/web/lib/settings-save.test.ts:158` (`settingsSaveBody`) |
| Save a key, or forget it, as a hosted member or builder | `403 settings_key_forbidden` before anything is written (`requestsKeyWrite`, `assertMayChangeCompanyKey`, `packages/host/src/handlers/settings.ts:266-275`, `:290`, `:574-579`); the stored key and verdict are untouched |
| Server mode, no database connection installed | `tenantStateBackend()` throws `tenant_state_backend_missing` (500) on the first read or write (`packages/host/src/tenant-state-store.ts:298-308`). Fail closed and loud, never a silent fall back to the desktop's files — see [`tenant-secrets-backend.md`](tenant-secrets-backend.md) |
| Sealed settings that will not open with the current wrap key | server mode refuses the request (`settings_unreadable`, 500) and leaves the payload untouched; a desk quarantines and starts fresh, exactly as before (`onUndecryptableSettings`, `packages/host/src/settings-store.ts:386-398`). A wrap key that is *refused* is neither: `decodeStoredPayload` resolves the key before it reads the payload (`:402`), so a server key under 32 bytes throws `SERVER_VAULT_KEY_TOO_WEAK` out of `loadSettings` and `saveSettings` and the stored settings are not touched. A desk does not refuse a short key: it warns once and opens the file under the same key as before (SR-203) |
| Reset queued, app killed before reboot | `reset-pending.json` persists; the wipe applies on the next boot regardless of how the process died |
| Reset while runs are in flight | only *tracked* ffmpeg/ffprobe children are signalled (`packages/host/src/child-processes.ts:42-55`); an in-flight chat turn or embed job is simply cut off at exit. No coverage |
| Partial removal | since 2026-09-23 the marker is kept, rewritten to what is left, and the next launch retries it; the outcome says `applied: false` and the boot line warns (`keepForRetry`, `packages/db/src/reset.ts:276-289`). Before, `dropMarker()` ran anyway and the result said applied |
| The marker cannot be rewritten after a partial wipe | the original marker is still in place, so the next boot retries the whole wipe (`:285-288`) |
| Reset on webdev | `relaunchDesktopApp` returns `{ok:false, reason:"unavailable"}`; the card shows `settings-reset-restart-needed`; the wipe lands when the dev server next restarts |

## Where things live

| File | Role |
|---|---|
| `packages/host/src/settings-store.ts` | The encrypted store, one payload per tenant; `SettingsScope`, `resolveSettingsScope`, `resolveSettingsWorkspaceId`, `sliceFor`, `clearGatewayKeyEverywhere`, `loadUserLocale` / `saveUserLocale`, `loadOwnerLocale` / `saveOwnerLocale` |
| `packages/host/src/injection-guard-bypass.ts` | **SR-202.** The per-desk set in host memory that holds the injection-guard bypass off server mode; `setInjectionGuardBypass`, `withInjectionGuardBypass`, `carriesStoredBypass`. Nothing is saved; in server mode it holds nothing. |
| `packages/host/src/tenant-state-store.ts` | **Phase 4.** The backend the two payloads go through: `TenantStateBackend`, the file and row implementations, `TENANT_STATE_FILENAMES`, legacy-file adoption — see [`tenant-secrets-backend.md`](tenant-secrets-backend.md) |
| `packages/host/src/tenant-state-db.ts` | Three lines; the only place the row backend is handed a connection, imported from `router.ts` |
| `packages/core/src/tenancy/state-keys.ts` | `TENANT_STATE_KEYS` — `settings`, `gateway_gate` and (hosted only, 2026-10-01) `model_cache`, the names both backends key on |
| `packages/host/src/model-cache.ts` | The model cache: one machine file on a desk, one `tenant_state` row per **company** on the hosted server (`model_cache:<organisation id>`, SR-163); `ModelCacheScope` (`{ tenantId, organizationId? }`), `modelCacheOwner`, `modelCacheSlot`, `modelCacheScopeOf`, `loadModelCache`, `saveModelCache`, `probeSummary` |
| `packages/host/src/selectable-models.ts` | The catalogue built from the cache (a memo per tenant slot), `refreshModelCache` (with `onlyIfMissing`), `warmHostedModelCache` (the hosted background refill, `:505`), `modelCatalogBody`, `modeDefaultsFor` |
| `packages/host/src/wrap-key-rotation.ts`, `scripts/rotate-wrap-key.ts` | The wrap-key rotation drill and its CLI |
| `packages/host/src/tenant-paths.ts` | The one place a tenant becomes a directory — see [`tenant-storage.md`](tenant-storage.md) |
| `packages/host/src/workspace.ts` | `workspace-id.txt` read/write |
| `packages/host/src/tenant.ts` | `getTenant` — desk resolution, stamping, legacy adoption |
| `packages/host/src/handlers/settings.ts` | `settingsPayload`, GET/POST settings, `gateVerdictFor`, `refreshGatewayGateAfterSave`, `handleGatewayCheck`, reset, cancel; `HOST_RESET_ENTRIES` |
| `packages/core/src/gateway/gate-types.ts` | The gate contract |
| `packages/host/src/gateway-gate.ts` | Derivation, the per-tenant verdict (through the state backend), live check, `requireGatewayAllowed` / `requireGatewayAllowedFor`, background refresh |
| `packages/core/src/gateway/pinned.ts` | The pinned URL, its integrity hash, the dev-only override rule |
| `packages/core/src/secrets.ts` | `resolveProviderKeys` (which, in server mode, no longer falls back to the operator's environment), `maskSecrets`, `resolveRuntimeMode` |
| `packages/core/src/security/fingerprint.ts` | `keyFingerprint` |
| `packages/db/src/reset.ts` | Marker write/validate, boot-time apply, symlink-safe removal |
| `packages/db/src/client.ts` | The one place the queued wipe is applied |
| `apps/web/lib/gateway-gate.ts` | Parse, `resolveGate` (with the hosted `KeyDeferral`), `GATE_EVENT`, reason and status keys, `parseGatewayBlocked`, `formatGateTimestamp` |
| `apps/web/lib/key-later.ts`, `gate-state.ts`, `gateway-blocked.ts`, `use-desk-needs-key.ts`, `components/needs-key-note.tsx` | **Enterprise only.** The deferral helpers and the host write, the shared gate store, the 403 reader, the pane hooks, the calm note |
| `packages/host/src/key-later.ts`, `handlers/key-later.ts` | **Enterprise only.** The per-person "add the key later" record and its route (404 off server mode); never read by the gate |
| `apps/web/lib/product-brand.tsx` | `gatewayHostLabel` — the pinned URL reduced to a host for display |
| `apps/web/src/App.tsx` | Holds gate state, listens for `GATE_EVENT`, renders onboarding |
| `apps/web/components/settings-page.tsx`, `settings-reset-card.tsx`, `onboarding-screen.tsx` | The surface |
| `apps/desktop/main.cjs`, `lifecycle.cjs`, `navigation.cjs` | Relaunch, storage clear, sender trust |

## Gotchas

- **A hosted read of the model cache that cannot name its company is refused, not guessed (2026-10-01; company
  since SR-163).** `loadModelCache`, `saveModelCache` and `modelCacheStamp` take the scope, fall back to the request's
  session (`currentRequestSession`) for the partner and, when the scope names the same partner without an
  organisation, for the company, and otherwise throw `tenant_required` (no partner) or `company_required` (a
  partner and no company) (500) (`modelCacheOwner`, `model-cache.ts`). Any caller that builds a bare `{ tenantId }`
  must add the organisation (the Edit doctor did: `handlers/edit.ts`). The session
  fallback does not reach a stream body (`startModalityRun`, the Edit event stream), which runs outside the
  request's async scope, so every catalogue caller passes its tenant, and
  `packages/host/src/model-catalog-tenancy-guard.test.ts` fails the suite for a call that does not name one.
  The one diagnostic that can be asked with nobody behind it, the Edit doctor, answers "no speech-to-text
  model" (`asrFor`, `packages/host/src/edit/doctor.ts:75`) rather than fail; the full host run found that one
  (`edit/doctor-hosted.test.ts` calls it with no session).
- **An upgraded hosted server may still hold the old shared `models-cache.json`.** Nothing reads it on the
  hosted server any more, and nothing deletes it; it holds one tenant's catalogue and the probe errors that
  tenant's key produced. The operator can delete it from the data volume. A desk's copy is the live cache and is
  still on the "Start over" list (`HOST_RESET_ENTRIES`).
- **A tenant's cache is empty until it saves a key or presses Refresh, and that includes every existing hosted
  tenant on the day this ships.** Nothing refreshes it on sign-in or on first read, so a tenant that already
  has a key and has not saved Settings or pressed Refresh since the deploy gets no Videos (the Videos list is the
  probed list alone, `listProbedVideoModels`, with no static fill-in), no speech-to-text model for Meeting and
  Edit, and the fallback Chat default. It heals on the first Save or Refresh. Either press Refresh once per
  tenant after the deploy (an owner note for the Enterprise deploy), or add a throttled hosted-only refresh when
  a tenant has a key and no row (the gate already does this for its verdict, `maybeRefreshGateway`); neither was
  done. There is no shared catalogue to inherit, which is the point; the picker shows what a keyless desk always showed (the static list, 47 chat
  models and `gemini-3.5-flash` as the default on the rehearsal's keyless tenant, a zeroed `probe`). On the
  rehearsal's volume `models-cache.json` is a 3-byte `{}` written by the previous build and now unread.
- **AGENTS.md's `resolveProviderKeys` precedence is Phase 1 design, not shipped code.** `AGENTS.md:77`
  describes "explicit workspace key (unless `allow_byo_key` is `false`) → live session access token → stub". At
  this sha there is no session token, no `StoredSession`, and no `allow_byo_key` anywhere in `packages/` or
  `apps/` — grep returns nothing outside `docs/internal/portal/` and `AGENTS.md` itself. Read the function, not
  the roadmap.
- **A "never checked yet" gate reports `status: "ok"`.** The upgrade branch and a persisted `stub`/`needs_key`
  verdict both derive as `ok` + `grace:true`; only `message: "Not checked yet."` and `checkedAt === null` reveal
  there is no real verdict. Do not read `status` alone as "we asked and it worked".
- **A stub desk's status row carries no timestamp.** `settings-gateway-status` renders the status word, then
  `Last checked` **only when `checkedAt` is non-null** (`apps/web/components/settings-page.tsx:442-457`, the
  condition at `:447`). On
  `stub`, `needs_key` and never-checked desks the row is just the word and the Re-check link — driven on the
  owner's desk on 2026-09-17, where it read "Demo luring · Periksa ulang".
- **`invalid_key` is the only status with zero grace**, however recently the key worked. A rejection is an
  answer; unreachable is not.
- **Per-desk settings are one file.** Anything that reasons about "the desk's settings directory" is wrong.
- **`getTenant` reads and compares the settings file on every single request** because `adoptLegacySettings` is
  unconditional (`packages/host/src/tenant.ts:124`). It is a no-op once the legacy slice is gone, but it is not
  free.
- **A pasted key can quietly fill other providers' slots.** `reuseOpenAI` + `guessDialectFromKey` means one key
  field can populate the Anthropic, Google or Volcengine slot when the key *looks* like theirs.
- **`requireGatewayAllowed` re-derives from disk on every gated request** — there is no cached in-process
  decision.
- **Not every gated route checks the gate first.** `handlers/enhance-prompt.ts:53` validates the body before it
  calls `requireGatewayAllowed`, so an empty-body probe of that route answers `400 empty_input` even on a fully
  closed desk. Use a route that gates on entry (`finance/parse`, `runs/text`) when you want to prove the 403.
  That route also **stubs on a desk and never on the hosted server** (2026-10-01): with no saved key and a runtime
  that is not `ai` it answers `200 { text, source: "stub" }` on a desk (`:49`, the offline and test path, unchanged),
  and `403 gateway_blocked` with `status: "needs_key"` on the hosted server, where it used to hand a tenant with no
  key a "rewrite" no model had made. So proving the 403 on a webdev with a stub runtime (`isServerMode()` false) is
  not possible on this route; it needs `AGENTFORGE_SERVER=1`.
- **This checkout pins stub.** Both `.env` and `apps/web/.env.local` set `AGENTFORGE_RUNTIME=stub`, and the first
  branch of `deriveGatewayGate` short-circuits on it, so **no** locally started webdev can show a closed gate
  unless it is started with an explicit `AGENTFORGE_RUNTIME=ai` (and no key, for `needs_key`).
- **A closed gate hides Settings too, on the Personal app.** `App.tsx` swaps the whole router for `OnboardingScreen`, so there is no
  route to the key field, the reset card or the status row while `allowed` is false. Recovery is onboarding's
  own key input, its Re-check, or deleting `gateway-gate.json`. **On the hosted app that is no longer so for a
  signed-in person who chose "Add it later":** the desk opens on the closed gate, Settings is reachable and shows the
  key form and the status row ("No key saved"), and every pane says a key is missing instead of failing. A signed-in
  person who has not chosen yet still gets the welcome first.
- **The legacy-migration marker must survive a reset.** `legacy-migrated.json` is not in `HOST_RESET_ENTRIES`
  and this is load-bearing: `migrateLegacyUserData` (`apps/desktop/main.cjs:780-810`) treats "userData has no
  `agentforge.sqlite`" as a signal to copy an older install forward — exactly the state a fresh-install reset
  produces. Without the marker, the boot after "reset to a fresh install" would silently restore the forgotten
  key, every thread and all media.
- **`app.relaunch()` / `app.exit(0)`, not the Windows `taskkill /T` path**, because Electron's relauncher is a
  detached child that the tree-walk would kill (`apps/desktop/main.cjs:203-207`).
- **`POST /api/v1/settings/reset` also requires the transport header.** It is in `TRANSPORT_REQUIRED_PATHS`
  (`packages/host/src/http-adapter.ts:36`) on top of the loopback `Host` and `Origin` checks, so a cross-site
  HTML form POST cannot reach it. The IPC-only transport and the loopback-only `Host` / `Origin` allowlist are
  **(desktop, frozen)**: on the hosted web app the same host gate runs behind the HTTP adapter
  (`packages/host/src/http-adapter.ts:539-568`). The loopback check **became** a trusted-origin allowlist plus a
  double-submit CSRF token in Phase 1 ([PR #56](https://github.com/Kyoo032/agentforge/pull/56), commit
  `6ae177a`): `isAllowedWebOrigin` / `isAllowedWebHostHeader` (`local-request.ts:99,113`) and
  `packages/host/src/csrf.ts`, reached only under `isServerMode()`.

## Verify

`.cursor/skills/verify-agentforge/features/settings.md` (Settings, keys, the Edit turn cap, the reset card) and
`.cursor/skills/verify-agentforge/features/gateway-gate.md` (the gate itself), plus
`features/security.md` for `key-fingerprint` and `privacy-note`. The recipes forbid typing into `openai-key` or
clicking either reset submit on a desk you do not own — drive the closed gate and the wipe on your own webdev
with a throwaway `AGENTFORGE_DATA_DIR`.

Testids and their lines (`apps/web/components/settings-page.tsx` unless noted):
`settings-load-error` `:379`, `runtime-status` `:384`, `settings-locale` `:408`, `settings-locale-error` `:416`,
`settings-locale-restart` `:421`, `settings-locale-restart-button` `:426`, `settings-form` `:436`,
`settings-gateway-status` `:444`, `settings-gateway-recheck` `:453`, `settings-gateway-grace` `:459`,
`settings-gateway-reason` `:464`, `openai-key` `:477`, `settings-edit-turn-cap` `:496`, `key-fingerprint` `:500`,
`settings-error` `:505`, `save-settings` `:515`, `privacy-note` `:523`; the whole `settings-reset-*` family in
`apps/web/components/settings-reset-card.tsx:159-303`, notably `settings-reset-key-submit` `:215`,
`settings-reset-all-confirm-name` `:258`, `settings-reset-all-submit` `:265`, `settings-reset-pending` `:167`,
`settings-reset-restart-needed` `:296`; onboarding in `apps/web/components/onboarding-screen.tsx`:
`onboarding-welcome` `:204`, `onboarding-next` `:215`, `onboarding-setup-check` `:233`, `onboarding-form`
`:250`, `onboarding-gate-reason` `:255`, `onboarding-key` `:269`, `onboarding-continue` `:280`,
`onboarding-recheck` `:290`, `onboarding-try` `:302`, `onboarding-start` `:334`. There is no
`onboarding-gateway-host`. **`settings-endpoint`, `settings-endpoint-reset`, `openai-base-url` and
`onboarding-endpoint` must all have count 0**; finding any of them is a regression.

Unit tests that pin it: `packages/host/src/gateway-gate.test.ts` (every derivation branch, the 7-day boundary,
key never leaked, endpoint pinned against an attacker-supplied `openaiBaseUrl`, throttle and TTL);
`packages/host/src/handlers/settings.test.ts` (403 shape, ungated routes, the exact reset entry list);
`packages/db/src/reset.test.ts` (marker validation, symlink/junction defences, `Local Storage/` preserved,
atomic write); `packages/db/src/reset-retry.test.ts` (a failed removal keeps the marker naming only what is left,
the retry never deletes the fresh database, and no path reaches the log); `apps/web/lib/settings-save.test.ts`
(`readSettingsAnswer`); `packages/host/src/gateway-pin.test.ts`; `apps/web/lib/gateway-endpoint-hidden.test.ts`;
`packages/host/src/settings-desk-scope.test.ts`; `packages/host/src/tenant.test.ts`;
`apps/web/lib/reset-app.test.ts`; `apps/web/lib/gateway-gate.test.ts`.

For the per-company model cache (SR-163, hosted only): `packages/host/src/model-cache-companies.test.ts` (two companies
under one partner: rows, stamps, slots, the catalogue, a scope with no company refused, the request session's
company, the warm-up per company and the refresh named by company, and the desk's one file) and, through the real
routes, `gateway-gate-companies.test.ts` "each Settings shows its own probe and models". For the per-tenant model cache
(Enterprise BYOK Phase A, hosted only, each with a Personal-parity case; its scopes now name an organisation too):
`packages/host/src/model-cache-tenancy.test.ts` (the store and the catalogue on an in-memory database: tenant A's
probe and catalogue invisible to B, no machine file written, a read with no tenant refused, the memo per tenant,
`refreshModelCache` scoped and probing the registry's hosts, speech-to-text discovery and the Edit doctor, and
the desk's file kept byte for byte), `packages/host/src/model-cache-hosted-routes.test.ts` (`dispatch` with two
provisioned tenants: `GET /api/v1/models`, `/chat` and `/settings` each tenant's own), and
`packages/host/src/model-catalog-tenancy-guard.test.ts` (a source scan: every catalogue call names a tenant).
For the background refill of a tenant with a key and no cache row: `packages/host/src/model-cache-warmup.test.ts`
(the start rules with an injected refresh: one for the tenant with a key, none for the one without, none when a row
exists, one at a time, the ten-minute throttle, a failure swallowed and logged without the key, an unreadable
settings file costing the read nothing; every catalogue read filling the row through a stubbed gateway with exactly one
probe; write-if-absent; and the Personal parity block, which spies `loadSettings` and fails if a desk read so much as
looks at the settings, and was mutation-checked by deleting the `isServerMode()` guard: eight cases went red) and the
last `describe` of `model-cache-hosted-routes.test.ts` (a tenant saves a key through `POST /api/v1/settings`, its row is
deleted to look like the upgrade, and `GET /api/v1/models` is empty then live with no save in between; a tenant with no
key starts nothing). For hosted prompt-enhance: `handlers/enhance-prompt.test.ts` (`dispatch` as a signed-in tenant with
no key: 403 `gateway_blocked`, `needs_key`, runtime `stub`, unset and `ai`; and the desk cases, which assert the exact
stub body and were mutation-checked by gating desks too: the unset-runtime case went to 403).
On the local Kubernetes rehearsal the same router was run inside the app container (`kubectl exec`, `tsx`) as
the hosted tenant's owner: `GET /api/v1/models`, `/chat`, `/settings` and `/edit/doctor` answered 200, a
`model_cache` row written for the tenant was listed by `/models` and counted by `probe`, and the row was removed
(`rowsAfter: 0`). (The tenant had no stored provider base URL, so that drive says nothing about the echo rule; the
`secrets.test.ts` block does.) A browser sign-in to that cluster was not completed (seat cap); nothing here was driven in a browser.

## Why

**Why the gate is advisory and every rule fails open.** `[Direct]` `AGENTS.md:72`, written in the same commit
that shipped the gate (`8831bc4`): "`allowed` is a UX signal — it decides what the desk shows and which local
handlers answer `403 gateway_blocked`. It is not an entitlement check and must never be read as one. … the whole
file is plain JSON in a directory the owner can edit, delete or replace. Anyone who wants past it can delete one
file. That is the right trade for a local-first desk that has to keep working offline — and it is exactly why
**the 20-seat entitlement, plan limits and any spend cap have to be enforced server-side, by the gateway and the
licence service, against the bearer on the request.** … If a limit can be defeated by editing a local file, it
was never enforced."

`[Supported]` The code agrees at every branch: a missing or unreadable verdict opens
(`loadGateState`, `packages/host/src/gateway-gate.ts:221-251`), an unwritable store costs a cached decision and
nothing else (`saveGateState`, `:262-277`; `runGatewayCheck`, `:616-623`), the background re-check swallows its
own failures (`:697-700`), and the stub runtime is always open off server mode (`:360-362`). **Confidence: high.** The design record is prose in `AGENTS.md`, not a commit body —
`git log --oneline -20 -- packages/host/src/gateway-gate.ts packages/core/src/gateway/gate-types.ts` returns only
`8831bc4` and `4db009a`, and `4db009a`'s message is about locale and layout, not the gate.

**Why sign-out clears the key on every desk rather than the current one.** `[Direct]` the comment at
`packages/host/src/settings-store.ts:522-538`: a key left on a second desk would keep the gate open after "forget
my key". **Confidence: high.**

**Why the fresh-install wipe is a named list and deferred to boot.** `[Direct]` two comments:
`packages/host/src/handlers/settings.ts:275-280` — "Deliberately a named list, never the directory: in the packaged
app this same folder is Electron's userData / Chromium profile, so `host-status.json`, `Local Storage/`, caches
and cookies are not ours to delete"; and `:341` — "the database is open and ffmpeg may still be writing, so the
wipe is queued for the next boot". `[Supported]` `packages/host/src/handlers/settings.test.ts:365-385` pins the
list and asserts `host-status.json` is never in it. **Confidence: high.**

**Why the endpoint is pinned three ways at once, and hidden as a fourth.** `[Supported]`
`resolvedGatewayBaseUrl()` ignores stored settings and `OPENAI_BASE_URL`; `gatewayUrlOverride()`
additionally lets a packaged build move only to its brand gateway, and an unpackaged one only when it is not
production (`packages/core/src/gateway/pinned.ts:38-81`);
`packages/core/src/gateway/pinned.test.ts` recomputes a SHA-256 of the literal to catch tampering; and
`packages/host/src/gateway-pin.test.ts` bans raw reads repo-wide. `[Inferred]` the layering reads as defence in
depth against three different failure shapes — a user-edited setting, a packaged build with a leftover dev env
var, and a source edit — since each guard alone would miss one of them. No single source states this rationale.
**Confidence: high for the mechanism, medium for the reading.** `[Direct]` **2026-09-17** adds a fourth, weaker
layer that is presentation rather than enforcement: the endpoint row is hidden from Settings and onboarding, and
the guard test says why in its own header — "hidden from the UI entirely: neither Settings nor onboarding renders
it, and no field may look editable. This is a grep rather than a render test because the renderer has no DOM test
setup — what matters is that a future edit cannot quietly put the URL back on screen"
(`apps/web/lib/gateway-endpoint-hidden.test.ts:6-11`). It stops a support question, not an attack — the three
real guards are unchanged.
