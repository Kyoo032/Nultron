# Nultron

This file is the source of truth for coding agents working in this repository. Personal vault notes outside the repo are for Rizky, not domain rules here.

## Where am I?

Run `pnpm where` (`scripts/where-am-i.mjs`) before any edit. If it exits 1, or if your folder and branch violate a row below, stop and ask Rizky. Install the push guard once per clone with `pnpm hooks:install` so every worktree shares it.

| Folder | Branch | Role | Webdev |
|---|---|---|---|
| `C:\Users\rizky\Documents\nultron` (or `agentforge`) and worktrees `nultron-<topic>` / `agentforge-<topic>` | `main` or a branch cut from `main` | Active development and published code. All features, UI/UX updates, voice work, security work, and bug fixes land on `main` (Rizky, 2026-11-24). | `:3000` |
| `C:\Users\rizky\agentforge-chat` | `tester/chat-first` | Paused until live launch (Rizky, 2026-11-24). Owes no sync step until Rizky re-enables it. | `:3200` |

A folder outside this table (such as a Cloud VM clone) prints `other`. Work only on a branch cut from `main` there, and never release or deploy from it.

## Where a change goes

| Change type | Cut branch from | Work in | Pull request to | Required before done |
|---|---|---|---|---|
| Feature, UI/UX, bug fix, or security work | `main` | `nultron` or worktree `nultron-<topic>` | `main` | `pnpm ci:local` passing (tester sync paused until live) |
| Docs, maps, or skills | `main` | `nultron` or worktree | `main` | `pnpm lane-guard` and relevant checks |
| Release or deploy | `main` only | `nultron` | none | Rizky's explicit go at that moment |

Rules that always apply:

- Read [`docs/internal/release-targets.md`](docs/internal/release-targets.md) first and name the target your task serves. The one active ship target is `nultron-enterprise` (hosted web app and OPC desk). Nultron Personal (Electron) was retired on 2026-10-14 (`Kyoo032/Nultron-Desktop` archived), and `apps/desktop/**`, desktop scripts, retired desktop skills, and the Electron web bridge were deleted on 2026-11-24 (DFIND-139).
- Never release from `C:\Users\rizky\agentforge-chat` or from a Cloud VM.
- Shared code and copy never hard-code `Toko Token`. Read `gatewayName` and `productName` instead. `Nultron` may appear in this repo because it is the Nultron core.
- `Kyoo032/hyp-ai` is a standalone codebase. Nothing syncs between it and `Kyoo032/Nultron`.
- Include a `Lanes:` line (using `enterprise` and/or `tester` from [`lanes.json`](lanes.json)) in PR descriptions and commits touching protected files.
- Never commit or push unless Rizky asks.

## Product direction and boundaries

Nultron is a chat-first workbench for a one-person company (OPC). One owner works with built-in harnesses and virtual agents inside one desk (`SHELL_LAYOUT = "chat-first"` in [`packages/core/src/agents/product-modes.ts`](packages/core/src/agents/product-modes.ts)).

- **14 built-in harnesses.** `chat`, `documents`, `research`, `finance`, `data`, `market`, `legal`, `meeting`, `images`, `videos`, `music`, `edit`, `presentations`, and `education`. Do not add new product modes, harnesses, rail entries, or packs without Rizky's explicit approval.
- **Prompt first.** Every harness starts from one prompt box with optional files, puts results before controls, and preserves user edits during regeneration. Put capability in the harness, not in upfront setup forms.
- **Fresh desk invariant (hard rule).** Every fresh install starts with `["chat"]` alone (`FIRST_RUN_MODES` and `HOSTED_FIRST_DESK_MODES` in `packages/core/src/agents/product-modes.ts`), enforced by `packages/host/src/first-run-modes.test.ts` and `packages/db/src/first-desk-modes.test.ts`. Never rewrite an existing desk. Specialist agents are added or deleted on `/workspaces`, and Chat invokes specialist work inline.
- **Custom-agent builder stays parked.** `/studio/**` redirects to Chat. Do not build a custom-agent builder or team workspace board here.
- **Industry-neutral kernel.** Schema, APIs, and core packages must not contain `student`, `course`, or campus nouns. Optional templates live in `packages/university`, `packages/marketing`, and `packages/legal`.
- **Entitlements.** Routines are free on every plan. Cloud computer / VPS access requires a paid plan. The host enforces entitlements from the portal; the renderer only displays state.
- **Tenancy and privacy.** Every row belongs to a tenant, enforced by the host. On hosted desks, Chat knowledge cards are visible only to the thread owner (`knowledge-visibility.ts`), and each person's chat upload folder is private.
- **Single-process SQLite architecture.** The hosted app runs one Node process against one SQLite file (`data/agentforge.sqlite` or `AGENTFORGE_DATA_DIR`) with local file storage (`webapp-deploy/k8s/` pins one app pod with `strategy: Recreate`). Do not migrate the product database to Postgres or multi-replica scaling without Rizky's explicit go.
- **Public copy rule.** On public pages, Nultron is "coming soon". Never publish GitHub download links, public preview links, or "closed beta" / "testers" copy on public marketing sites.

## Repository layout

```text
apps/web                 Vite + React Router renderer and Express product server (server.ts)
apps/web/locales         en/ and id/ JSON catalogs across 33 namespaces
apps/portal              Standalone portal control plane (Postgres via PORTAL_DATABASE_URL; HTTP only, never imported by product)
apps/mobile              Planning rules only (apps/mobile/AGENTS.md); no shipped mobile app
packages/core            AgentRuntime, tools, product-modes, harness/modes, providers, security (PII, redact, outbound guard), mcp, voice, inbox, channels, finance, market, locale, output-language
packages/host            HTTP adapter, router, handlers, job harnesses, mcp, voice, delegation, channels (Telegram), inbox (WhatsApp), code-runner (WASM), file-extract, components, renderers, auth, eval
packages/db              Drizzle SQLite schema, ensureSchema migrations, vault-key.ts, reset.ts
packages/legal           Optional Legal pack templates
packages/marketing       Optional Marketing pack templates
packages/university      Optional University pack templates
webapp-deploy            Dockerfile, Compose stack, K8s manifests (k8s/), AEAD backup and restore scripts
docs/                    Public docs and docs/internal/ (release-targets, security-register, unreleased, 52 maps in docs/internal/maps/)
scripts/                 ci-local, lane-guard, where-am-i, release-web, formal checks, map-rot, sandbox build
.cursor/skills/          change-agentforge, verify-agentforge, chat-run-settle, verify-paid-media-gate
```

Gitignored local directories:

- `.ref/` holds read-only third-party reference repos (`OpenMausBot`, `hermes-agent`). Take ideas only, never copy code, and never read or copy from `OpenMausBot/enterprise/`.
- `nultron-files/` holds non-code working assets (media, brand kits, deploy decks, `release/nda-terms.txt`). Never `git add` it.

## Subsystem invariants

### Gateway gate, auth, and BYOK

- **Advisory gateway gate.** [`packages/host/src/gateway-gate.ts`](packages/host/src/gateway-gate.ts) owns `allowed` (`gateway-gate.json`, 7-day offline grace, 3 s validation budget). Every gateway-calling route checks `requireGatewayAllowed()` and returns `403 gateway_blocked` when closed. The renderer branches only on `allowed`. Stub runtime reports `status: "stub", allowed: true`.
- **Pinned gateway endpoint.** The default endpoint is pinned to `https://api.tokotokenai.com/v1` and hidden from onboarding and Settings. `AGENTFORGE_GATEWAY_URL` is a dev/test hook ignored in production.
- **Two gateway account groups (Rizky, 2026-11-26).** Toko Token AI (`https://api.tokotokenai.com/v1`) is always the main group and the default for the owner desk, the testers, and every new desk. Pusat Token AI (`https://www.pusattokenai.com/v1`) is a second group that is assigned one desk at a time. A desk joins it only when it sets both `PREVIEW_ASSIGNED_GATEWAY_ENDPOINT` and `AGENTFORGE_GATEWAY_NAME="Pusat Token"`; today that is `pusat01`–`pusat05` on `app.nultron-ai.xyz`, ports 3011–3015. Always use the `www` host, because bare `pusattokenai.com` has no DNS A record. Never make Pusat the default, never repoint the owner or tester desks to it, never hard-code either gateway in shared code, and never put a key from one group into a desk of the other.
- **Portal login.** `apps/portal` is reached over HTTP via `AGENTFORGE_PORTAL_URL`. The Enterprise deploy bundle defaults `PORTAL_SIGNIN_MODE=password`; unset defaults to e-mailed one-time codes. Access tokens stay in host memory only; refresh tokens live in sealed `session.enc` (`HKDF(wrapKey, "session-v1")`). Tokens never reach the renderer. Never add a password or account stack inside `apps/web` or `packages/host`.
- **Provider key resolution.** [`packages/core/src/secrets.ts`](packages/core/src/secrets.ts) (`resolveProviderKeys`) is the single bearer resolution path. BYO gateway keys remain the floor. Multi-provider BYOK (`packages/core/src/providers/registry.ts`) is server-mode only with pinned provider base URLs. OpenRouter's `provider.zdr: true` is sent only to OpenRouter, never to Toko Token.

### Secrets, at-rest encryption, and PII

- **At-rest encryption.** Settings, portal sessions, message bodies, tool I/O, knowledge vector bodies, and knowledge graph labels are sealed with AES-256-GCM under `AGENTFORGE_SECRETS_KEY` (env / secret manager; local fallback `data/.master-key`), with SQLite `secure_delete` enabled and wrap-key rotation in `scripts/rotate-wrap-key.ts`. Backups use AEAD `NAEAD001` GCM with legacy CBC restore detection in `webapp-deploy/scripts/restore.sh`.
- **Outbound PII masking.** [`packages/core/src/security/pii.ts`](packages/core/src/security/pii.ts) and [`pii-id.ts`](packages/core/src/security/pii-id.ts) mask identifiers including Indonesian NIK, NPWP, phones, and bank accounts. Redaction must never mask financial figures (`restoreFinanceAmounts` in `packages/host/src/finance-privacy.ts`).
- **Transport and external egress.** Remote inference, portal, and channel URLs must be HTTPS (`http://` is allowed only for loopback). Telegram (`packages/host/src/channels/`) is pinned to `api.telegram.org` and pull-only (`getUpdates`, no inbound webhook).
- **Security register.** Record every security finding (or verified non-issue) in [`docs/internal/security-register.md`](docs/internal/security-register.md) in the same change with `file:line` evidence, severity, status, and gate.
- Never process Nultron keys with Hermes tools or Hermes dashboard tokens.

### Sandboxed MCP, voice, and delegation

- **MCP connectors.** Gmail, Google Drive, OneDrive, and Notion (`packages/core/src/mcp/`, `packages/host/src/mcp/`) run strictly read-only. Write, delete, and harness mutation actions are blocked before any network call. `query` and `resourceId` pass through `currentOutboundGuard()` (fail-closed inside `inToolCall`), and changing an endpoint URL requires a fresh access token.
- **Team sessions and voice.** Delegated subagent runs (`packages/host/src/delegation/`) track child sessions per desk and enforce connector `allowSubagents` policies. Interactive voice (`packages/core/src/voice/`, `packages/host/src/voice/`) enforces outbound PII masking on talker payloads.

### Finance, extraction, code runner, and modalities

- **Deterministic Finance.** `packages/core/src/finance/` computes all financial figures deterministically (`number-guard.ts`, `stated-facts.ts`). Models write narrative and labels only; they never invent amounts.
- **Local file extraction.** `packages/host/src/file-extract/` uses `@firecrawl/anydoc` with magic-byte checks and 25 MB / 20 s limits. **No hosted OCR, ever** (`no-hosted-ocr.test.ts` enforces this).
- **Component installer.** `packages/host/src/components/` fetches native dependencies only from pinned URLs and sha512 hashes in `manifest.ts`. Never ask users to install binaries manually.
- **Code runner.** `packages/host/src/code-runner/` executes Python (Pyodide) and JavaScript (QuickJS) in WASM. On hosted deployments, `run_code` stays off unless `AGENTFORGE_CODE_RUNS=on`.
- **Fail-closed modalities.** Wrong content types on `/runs/text|image|video` return `400`, never silently drop content.

### Locale (`en` / `id`)

- Primitives live in [`packages/core/src/locale.ts`](packages/core/src/locale.ts) (`APP_LOCALES = ["en", "id"]`, default `"en"`).
- Catalogs live in `apps/web/locales/{en,id}/<namespace>.json` across 33 namespaces (`ls apps/web/locales/en`). Add every new UI key to both `en` and `id` in the same change and keep `apps/web/lib/*locale*.test.ts` green. No hardcoded English literals in product JSX.
- Job harnesses read `localeForRun()` (`packages/host/src/run-context.ts`) and apply `withOutputLanguage()` (`packages/core/src/output-language.ts`) or the mode-specific locale helper.

## Guardrails, maps, and formal checks

- **Change workflow.** Follow [`.cursor/skills/change-agentforge/SKILL.md`](.cursor/skills/change-agentforge/SKILL.md). Paste [`preamble.md`](.cursor/skills/change-agentforge/preamble.md) at the top of subagent prompts for shared code.
- **Lane guard.** `pnpm lane-guard` (`scripts/lane-guard.mjs`) blocks on never-promote paths, protected files without a `Lanes:` line, and `Toko Token` literals in shared code. Unrefreshed map pages warn by default and fail under `--strict`.
- **Subsystem maps.** [`docs/internal/maps/`](docs/internal/maps/README.md) holds 52 subsystem map pages (`ls docs/internal/maps/*.md` excluding `README.md`). Read the relevant map before editing, and refresh the map (`Last verified` line and citations) plus its matching `.cursor/skills/verify-agentforge/features/<feature>.md` recipe in the same PR.
- **Paid media gate.** Run `pnpm verify:paid-gate` before merging changes to SR-167 run gates, run entrypoints, or `image_generate` / `video_generate`.
- **Formal checks.** Run `pnpm formal:settle` (Java + TLC; [`.cursor/skills/chat-run-settle/SKILL.md`](.cursor/skills/chat-run-settle/SKILL.md)) before editing `startModalityRun`, `finishRun`, `recordChatRunUsage`, or the DB driver. Run `pnpm formal:sync-check` to verify formal scripts match source.
- **Model routing.** Per-role pstack model choices live in [`.claude/rules/pstack-models.md`](.claude/rules/pstack-models.md) (and each harness's own global rule file). Do not duplicate model tables here.

## How to run and test

Requirements: Node >= 22, `pnpm@9.15.9` (use `pnpm.cmd` in Windows PowerShell if `.ps1` scripts are blocked, or `npx pnpm@9.15.9` if corepack hits EPERM).

```bash
pnpm install
pnpm --filter @agentforge/web dev   # http://127.0.0.1:3000 (webdev alone)
pnpm test                           # Vitest across all packages via Turbo
pnpm lint                           # Biome check (do not add ESLint or Prettier)
pnpm ci:local                       # Full local CI suite
```

- **Local webdev (`:3000`).** Check `GET http://127.0.0.1:3000/api/v1/workspaces` before launching a server. Do not start a second port while `:3000` responds. Root `pnpm dev` also starts `apps/portal`, which exits if `PORTAL_DATABASE_URL` is unset. Vite hot-reloads renderer edits; `tsx server.ts` requires a manual restart after host or core edits.
- **Local CI is the CI.** There is no GitHub Actions workflow in this repo. Run `pnpm ci:local` (`node scripts/ci-local.mjs`) before PRs or merges and include `.ci-local/<timestamp>/summary.md` in the PR. Required steps cover `where-am-i`, `lint`, `tsc` across all 8 workspaces, Vitest across all 8 workspaces, `node --test` on `scripts/`, `audit:deployed`, `lane-guard`, and `sandbox:integration`. Nix checks (`pnpm ci:nix`, `pnpm ci:nix:fast`) are also available where Nix is installed.
- **Playwright E2E.** `apps/web/tests/e2e/foundation.spec.ts` (`pnpm test:e2e`, stub runtime) runs on Cloud VMs (configured by [`.cursor/environment.json`](.cursor/environment.json), no Docker, no live gateway keys). Do not block local Windows runs on `pnpm test:e2e`.
- **Database migrations.** Canonical path is `drizzle-kit generate` in `packages/db` plus app-side `ensureSchema` on SQLite open (`pnpm db:push` is optional). `PORTAL_DATABASE_URL` (Postgres) belongs only to `apps/portal`, never to the product database (`DATABASE_URL`).

## Releases and repos

- **`Kyoo032/Nultron` (private, this repo).** The only local checkout and source repository.
- **`Kyoo032/Nultron-Releases` (private).** Enterprise deploy bundles (`compose.yml` pinned to `ghcr.io/kyoo032/nultron-ent:<tag>` and `nultron-portal:<tag>`, `.env.example`, `DEPLOY.md`, `Caddyfile`) and GitHub Releases (`ent-YYYY.MM.DD`). Written only by `node scripts/release-web.mjs --tag <tag> --sha <sha>` (run `--dry-run` first). Requires `docs/public/<tag>-notes.md` and local `nultron-files/release/nda-terms.txt`. Never publish source code, `docs/internal/` paths, or AI/agent marks (`scripts/release-marks.mjs`).
- **`Kyoo032/Nultron-Desktop` (archived).** Retired Personal desktop releases (`0.15.1` final).
- **`webapp-deploy/`.** Source Dockerfile, Compose stack, K8s manifests (`k8s/`), and backup/restore scripts. Do not invent a third deploy path.

## Known traps

- **Stage explicitly by path.** Never run `git add -A` or `git add .`. Local checkouts may hold untracked directories (such as `evidence/` or leftover local folders).
- **Never commit secrets.** `.env`, `data/settings.enc`, `data/session.enc`, `data/.master-key`, and `.webdev-data*/` must stay untracked.
- **Start over is destructive.** `settings-reset-all-submit` wipes the desk and `settings-reset-key-submit` clears keys across desks. Drive them only on a throwaway `AGENTFORGE_DATA_DIR`.
- **Isolate SQLite in host tests.** Give each test file its own `mkdtempSync` `AGENTFORGE_DATA_DIR` (sharing one temp dir causes parallel `ensureSchema` races) and close `sql` in `afterAll` before `rmSync(..., { maxRetries: 10, retryDelay: 100 })` so Windows does not throw `EPERM`.
- **Avoid raw NUL bytes in source.** Write `"\u0000"` instead of a literal control byte so git does not classify the file as binary.
- **Loopback host only for webdev.** Use `http://127.0.0.1:3000`, never a LAN IP, for local dev and Playwright.
- **Dynamic native requires.** Keep `typeof require === "function" ? require : createRequire(import.meta.url)` in host native-module loaders (`file-extract/anydoc.ts`, `sql-runner.ts`), and verify component-installer changes with a real install into a temp `AGENTFORGE_DATA_DIR`.
- **Parallel test noise.** `pnpm -r test` stops on the first failing package, and `packages/db`'s `drizzle-kit check` test can flake under heavy parallel load. Re-run the package alone before calling a failure a regression.
- **Browser automation.** Avoid Cursor's injected `data-cursor-ref` overlay when clicking; use Chrome or Playwright directly.
