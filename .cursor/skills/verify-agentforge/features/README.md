# Nultron verification map

Agent-facing map (where to press). Not product. Pair with pstack `how` for how a subsystem works; keep this directory honest with `/maintain-verification-skill`.

This directory is the maintained source for verifying user-facing Nultron behavior. Read this index before driving, then use the matching feature file as the recipe.

Documents, Research, Finance, Data, Market, Legal, Images, Videos, Music, Meeting, Presentation, Edit, and Education are product modes. **Since PR #157 (2026-10-12) `:3000` draws the chat-first shell: an icon rail of agents (`agent-<mode>`, plus `mode-chat`), where only Research and the default Chat agent converse and the other twelve are studio agents opened with `agent-open-studio` (the `/<mode>` pages are unchanged).** A desk created before 2026-09-29 (the operator's `:3000` one) has all the modes; the first desk of a fresh Personal install has only Research, Images, Videos and Presentation plus Chat, and its owner hires the rest on the Virtual agents page (`/workspaces`, `agent-hire`). The hosted app's first desk keeps every mode. Knowledge is Account-rail, not a mode checkbox. Custom agents do not unlock the rail. The old `mode-<id>` rail, desk switcher and Workspaces page exist only when `SHELL_LAYOUT` is `modes`; the recipes name that as a fallback. The parts of the Edit studio still owed are named in [edit.md](./edit.md). Education is the teaching desk: a lesson deck, an exam, a local page reader, and a presenter plan.

## Baseline preconditions

- **Webdev:** the operator's instance answers at `http://127.0.0.1:3000` (never a LAN IP). Doctor with no args. An isolated instance you started yourself on another port is doctored with `--base http://127.0.0.1:<port>`.
- **Packaged desktop (history: retired 2026-10-14, not owed):** Electron window; doctor `--desktop` reads `host-status.json` (`transport: "ipc"`). No HTTP port.
- SQLite is `data/agentforge.sqlite` (webdev) or, history only, Electron userData (packaged: `%APPDATA%\Nultron`, `$XDG_CONFIG_HOME/Nultron` or `~/.config/Nultron`, `~/Library/Application Support/Nultron`).
- **No product login on webdev or the retired desktop.** A gateway key is optional; stub Chat works without one. The hosted deployment is different: since Phase 9 it has a sign-in, and it is the portal door — by default an e-mail and a six-digit code, or, on a portal started with `PORTAL_SIGNIN_MODE=password` (owner decision, 2026-10-07; also the Nultron Enterprise release bundle's default since 2026-10-09, while the portal's own default with the variable unset is still the code), a username and a password the operator made; the app itself never has a password field, and an e-mail domain is never used to pick a tenant. Drive it with [login.md](./login.md) on the review instance, never on `:3000`.
- The **gateway gate** decides whether a desk opens at all: `allowed: false` puts the whole app on onboarding and answers `403 gateway_blocked` on every gateway-calling route. See [gateway-gate.md](./gateway-gate.md).
- Windows: drive webdev with the IDE browser where you have one. A Claude Code session has no IDE browser — it drives `:3000` (the isolated webdev) with a short scratch Playwright script (see SKILL.md **Drive**) and never runs `pnpm test:e2e`. `:3000` may hold a real, billed key: read doctor's `runtime` first and keep model calls to what the owner asked for.
- Cloud (and `pnpm ci:local --e2e`): `AGENTFORGE_RUNTIME=stub` and Playwright `foundation.spec.ts` against **webdev** :3000.
- Never drive an instance this run did not doctor. Never start a second process on :3000. Never treat :3000 as the installed app.

## Driving conventions

- Start from the feature file's preconditions.
- Use `data-testid` handles. Treat testid strings as literal.
- Rail tiles are the current workspace `productModes`: `mode-chat` plus one `agent-<mode>` per mode. The operator's Default has every work mode; a fresh Personal desk has five (Chat, Research, Images, Videos, Presentation). `mode-agents` count is 0. A studio is reached with `agent-<mode>` then `agent-open-studio`, or by URL (`/<mode>`).
- Restore nothing on the operator's Windows SQLite. Cloud isolation is the VM.
- Keep proof artifacts under `evidence/<feature>/<run-id>/`.
- Testids are locale-invariant. Every recipe here holds on an `id` desk; only the visible strings change. See [locale.md](./locale.md).

## Proof and skip reporting

- Capture the user action and the resulting state.
- UI proof: snapshot + screenshot with Chat / Settings / workspace identity visible.
- Mutation proof: a second user-facing view (thread list, workspace list, gallery).
- Record the feature ID and entry point on every artifact.
- An unreachable rail tab (`agent-images` missing on a Legal desk) is expected — not a skip. On Default, missing Images is a fail.
- `/studio` and `/agents` redirect to Chat. That is parked GTM, not a harness bug.
- Do not report Settings saved or a live generate unless the operator asked and doctor reported `runtime: "ai"`.

## Feature entry contract

Each file: H1, one paragraph, the `Product: … · Instance: …` line, then exactly four H2s — `Sub-features`, `How to get to it (user POV)`, `Driving it with the Nultron harness`, `Gotchas`.

## Product and instance

Every recipe names its product and the instance it is driven on. The same pair sits under each recipe's H1 paragraph as `Product: … · Instance: …`. [maps/README.md](../../../../docs/internal/maps/README.md) uses the same words for the subsystem pages.

- **Product.** `both` means the shared renderer and host, which serve Nultron (OPC, the hosted one-owner app). `retired-desktop` means the Personal desktop app, retired 2026-10-14: history, not owed a drive. The `opc` folder is not built yet, so no recipe says `opc`.
- **Instance.** `main :3000` is the published checkout, `C:\Users\rizky\agentforge`. `tester :3200` is staging: new work is driven there first. Which instance you are in is in [SKILL.md](../SKILL.md#where-am-i).
- **Checked against the code** (main `9103579f` and branch `chore/nultron-only` at `91da0409`, tester `38bfdd8a`, 2026-10-16). The tester carries only the chat-first OPC features since the 2026-10-16 strip: the team board, the Private/Workspace project switch and the newer document cards (`chat-doc-card.tsx`, `tool-rows/doc-result.ts`) are gone from it, so no recipe is tagged tester-only. Documents in Chat is on main (`apps/web/components/chat-deck-card.tsx`, `packages/host/src/chat-documents/`), and so are `/workspaces` (the Virtual agents page) and private uploads (`packages/host/src/desk-files/private-uploads.ts`).

| Recipe | Product | Instance |
|---|---|---|
| [Build](./build.md) | both | main :3000 (parked: `/studio` redirects to Chat) |
| [Channels (Telegram)](./channels.md) | both | main :3000 |
| [Chat](./chat.md) | both | main :3000 |
| [Code](./code.md) | both | main :3000 |
| [Components (first-run installer)](./components.md) | both | main :3000 |
| [Data](./data.md) | both | main :3000 |
| [Desktop brands](./desktop-brands.md) | retired-desktop | none (Personal desktop retired 2026-10-14) |
| [Desktop](./desktop.md) | retired-desktop | none (Personal desktop retired 2026-10-14) |
| [Documents](./documents.md) | both | main :3000 |
| [Edit](./edit.md) | both | main :3000 |
| [Education](./education.md) | both | main :3000 |
| [Files](./files.md) | both | main :3000 |
| [Finance](./finance.md) | both | main :3000 |
| [Folder](./folder.md) | retired-desktop | none (Personal desktop retired 2026-10-14) |
| [Gateway gate](./gateway-gate.md) | both | main :3000 |
| [Guide](./guide.md) | both | main :3000 |
| [Images](./images.md) | both | main :3000 |
| [Knowledge graph](./knowledge-graph.md) | both | main :3000 |
| [Knowledge ingest loop](./knowledge-ingest.md) | both | main :3000 |
| [Knowledge phases](./knowledge-phases.md) | both | main :3000 |
| [Knowledge](./knowledge.md) | both | main :3000 |
| [Legal](./legal.md) | both | main :3000 |
| [Locale](./locale.md) | both | main :3000 |
| [Login (hosted sign-in)](./login.md) | both | hosted review :3443 (not :3000) |
| [Market](./market.md) | both | main :3000 |
| [Mascot](./mascot.md) | both | main :3000 |
| [Meeting](./meeting.md) | both | main :3000 |
| [Mobile](./mobile.md) | retired-desktop | none (no mobile build; retired with the desktop lane) |
| [Model tiers](./model-tiers.md) | both | main :3000 |
| [Models](./models.md) | both | main :3000 |
| [Music](./music.md) | both | main :3000 |
| [Onboarding](./onboarding.md) | both | main :3000 |
| [PII](./pii.md) | both | main :3000 |
| [Plans and pricing](./plans.md) | both | main :3000 for /pricing; hosted review :3443 for the signed-in panel |
| [Presentation](./presentations.md) | both | main :3000 |
| [Rail](./rail.md) | both | main :3000 |
| [Research](./research.md) | both | main :3000 |
| [Security](./security.md) | both | main :3000 |
| [Settings](./settings.md) | both | main :3000 |
| [Shell scroll](./shell-scroll.md) | both | main :3000 |
| [Studio advanced](./studio-advanced.md) | both | main :3000 (parked: `/studio` redirects to Chat) |
| [Templates](./templates.md) | both | main :3000 |
| [Usage](./usage.md) | both | main :3000 |
| [Videos](./videos.md) | both | main :3000 |
| [Virtual agents](./virtual-agents.md) | both | main :3000 (on main since PR #157) |
| [Workspaces](./workspaces.md) | both | main :3000 |

## Features

- [Chat](./chat.md) — the default Chat agent: header (`agent-name`, `tier-picker`, `new-chat-link`, `agent-history-toggle`, `agent-harness-toggle`), empty state with intent cards that fill the composer, the bare composer (`composer-plus` menu with attach and Enhance, icon send, request body `{content, tier}`), Thinking disclosure holding the tool rows (the default agent binds 17 tools), new chat, sessions in the history popover.
- [Mascot](./mascot.md) — the Nultron character (`NultronMascot`) on Chat and every job desk, plus the rail's desk buddy and the page stages (`buddy-stage-header`, `buddy-stage-composer`): 21 states from `?mascot=`, light and dark, the 3D renders as images (a still per state, a one-shot clip for six, a four-frame loop for thirteen), head below 64px and body from 64px, busy loops only under `data-busy`, the trigger states (charging, surprised, love, lets-go), reduced motion, and smooth versus stepped loops by `html[data-shell]` (smooth on webdev and hosted, stepped in the packaged app). The logo (rail mark, favicon, splash, icons) is [Desktop brands](./desktop-brands.md).
- [Settings](./settings.md) — gateway key, privacy note, stub/live runtime, gateway status row, language row, compact this-key + Open Usage. Sign out and delete sit behind `settings-reset-danger`. No Advanced tab. On a closed gate (`allowed: false`) the Chat empty state makes Settings the primary action; a stub desk (`allowed: true`) keeps Send enabled and that link is a plain button.
- [Gateway gate](./gateway-gate.md) — the host's open/closed decision: onboarding reasons, `settings-gateway-status` + re-check, 7-day grace, `403 gateway_blocked`, Start over. Advisory, fails open, never an entitlement check.
- [Guide](./guide.md) — the first-run tour (offer, five stops, Skip / close / Esc, Replay in Settings) and the narrow first desk it points at (Research, Images, Videos, Presentation). Driven on `:3000` with the host faked in the browser; the host half is a test on a real empty data dir.
- [Onboarding](./onboarding.md) — first-run hello, key paste, then four examples only after the host reports `allowed`. `component-setup` sits on the key step, above the form.
- [Login](./login.md) — **Enterprise lane (hosted only).** The one door: `auth-signin` → the portal's e-mail and six-digit-code forms (or, in password mode, its username and password forms) → `/auth/callback` → signed in. Needs the review instance, a seeded tenant and a **real browser**; on webdev and the desktop every testid has count 0. No password in the default mode.
- [Plans](./plans.md) — **Enterprise lane (hosted only)**; owned by the Phase 9 pull request, not the 0.15.0 Personal cut. `/pricing` and its `pricing-*` cards, `account-plan` on Settings, and the blocked screens. Every number is a placeholder. `?preview=` reaches the blocked screens on a local build only.
- [Locale](./locale.md) — the Settings language select, the restart banner, and an `id` walk of the rail, Chat and one job mode. Testids do not move.
- [Rail](./rail.md) — the chat-first `AgentRail`: icon-only 64px column (56px on a phone) of `mode-chat` and `agent-<mode>` tiles marked `data-conversation` harness or studio, `rail-account-group` (Knowledge, Usage, Channels, Virtual agents, Settings), and `rail-footer`. The `productModes` to visible-tiles to hidden-mode-redirect chain, collapse widths, skeleton, theme toggle. The old labelled `AppRail` is the `modes` fallback.
- [Shell scroll](./shell-scroll.md) — one scroller per desk pane, Chat and Edit scroll inside the pane, scroll position survives a rail click, Chat follows a stream, wide lanes at 1920 / 2560 / 3440. The 480px rail collapse stays in [rail.md](./rail.md). (The older "Presentation preview is two columns from 1600px" has no source: no such breakpoint exists in the presentation components.)
- [Channels](./channels.md) — account-rail `/channels`: connect a Telegram bot to the desk, add a group or channel, send, and poll for replies. Not a product mode; drive it against `scripts/telegram-sandbox.ts` rather than a real bot.
- [Usage](./usage.md) — Account-group `/usage` Day/Week/Month stacked spend, this-key strip, desk by-model. Not a product mode.
- [Workspaces](./workspaces.md) — the desk model behind Virtual agents: `workspaces-link` opens `/workspaces`, hire and let go edit the desk's `productModes`; the old switcher and create-from-template screen are `modes`-fallback only.
- [Models](./models.md) — the model catalog behind the tiers: doctor modeKeys/chatCount/curation on webdev. No screen renders the per-model picker or the Thinking control in either shell layout (see Model tiers); the curated order shows in the studios' `<mode>-studio-model` selects.
- [Model tiers](./model-tiers.md) — the Chat header's three choices (`tier-picker`, `tier-option-daily|fast|reasoning`; Daily, Fastest, Reasoning) replace the model picker and the reasoning-effort select, and a send posts `{ content, tier }`. Driven on `:3000` 2026-10-12.
- [Virtual agents](./virtual-agents.md) — the chat-first shell's agents and the `/workspaces` page that replaced Workspaces (`virtual-agents-page`, `agent-card`, `agent-hire`, `agent-let-go`, `agent-always`). Harness agents (Research and default Chat) converse at `/chat?agent=<mode>`; the other twelve are studio agents. Driven on `:3000` 2026-10-12.
- [Templates](./templates.md) — example galleries on all five mode studios; click pre-fills the prompt.
- [PII](./pii.md) — host masks outbound prompts (`[email]` / `[phone]` / …); the transcript keeps the typed text.
- [Security](./security.md) — saved-key fingerprint on Settings (`key-fingerprint`); TLS note on `privacy-note`; at-rest envelope is existing work.
- [Components](./components.md) — first-run installer for native dependencies (anydoc): status route, staged install stream, onboarding panel that starts itself. No key needed; renders nothing when the reader shipped inside the app.
- [Research](./research.md) — studio shell on Default. Live generate needs a gateway key. Search is keyless (Wikipedia, OpenAlex, arXiv, Crossref) unless the desk already saved a Tavily or Brave key.
- [Documents](./documents.md) — starters, preview, section regen (503 without a key), DOCX download from a starter (no model), a source check, desk-file sources. An existing Default has the tab; a fresh Personal desk does not.
- [Finance](./finance.md) — `/finance` asks what to do, then one file-or-numbers step and a result. Five tasks (brief, ratios, budget, cash flow, appraisal), file import (`.xlsx` / `.csv` / documents, read locally), deterministic figures with a model-written narrative, export menu (xlsx / pptx / docx). No starter path; generate needs a working key. Default has the tab.
- [Data](./data.md) — pasted CSV + table notes, no web search, upload, profile, preview and reopen need no key; generate without a key is HTTP 200 with a `job.error` frame (503 inside it), shown in `data-error`. An existing Default has the tab; a fresh Personal desk does not.
- [Market](./market.md) — watchlist ≤15 tickers → briefing → guarded brief + DOCX, disclaimer always, the board is keyless; generate without a key is HTTP 200 with a `job.error` frame (503 inside it). An existing Default has the tab; a fresh Personal desk does not.
- [Legal](./legal.md) — .docx matter review with a verify/edit loop; uploads and roles without a key, the run without a key is refused in `legal-error` (HTTP 200 stream, `job.error` 503 inside). Default and the Legal preset have the tab.
- [Knowledge](./knowledge.md) — Account-rail Soul / Memory / Sources / Map + choosable embedding/brain/verifier; Chat injects RAG retrieve. Not a product mode.
- [Knowledge phases](./knowledge-phases.md) — **Cloud testing path** for builtin Phases 0–4 (Vitest + stub webdev). No WeKnora sidecar. Live `[n]` cites are Windows-only.
- [Knowledge ingest loop](./knowledge-ingest.md) — every finished Chat turn / job writes a text work card (pointer, not bytes); the `knowledge-loop` health strip of tiles on Sources (not a chart); Chat skips its own card; example clips never ingest.
- [Knowledge graph](./knowledge-graph.md) — Phase 4 builtin: completed Chat replies with `[n]` markers add `cites` edges (a stub reply can cite too, for the desk phrase "what does the desk say about ...", and every retrieving send adds a `retrieved` edge); one-hop `covers` expansion is behind `knowledge.graphExpand` (off in Chat); panel is the existing Phase 2 base. Drive on webdev :3000.
- [Files](./files.md): desk files, both products: the Files section at the bottom of the Knowledge Base's Sources tab (`files-section`), New file and Upload text file, a viewer with numbered text and version history, Restore and Delete behind confirms, the `/knowledge?file=` deep link, the seven `/api/v1/files` routes, and the Chat tool rows for the six file tools. Stub Chat never writes a file; the Chat write-and-edit scenario needs a live key. Drive on a throwaway desk.
- [Folder](./folder.md): **Retired with the Personal desktop (2026-10-14): history only.** Open one real folder from the Chat composer (`folder-open`), let the agent read it, and Approve, Reject or find stale each change it proposes (`folder-proposal`). Needs a packed app, because `pnpm desktop:dev` has no preload; webdev proves only the refusals (`GET /api/v1/folder`, a mount over HTTP). No packed app was ever driven, and nothing here is owed now.
- [Code](./code.md): the `run_code` sandbox. No page of its own: the model runs a short Python or JavaScript program and the Chat turn shows a `tool-row-code` row, with the files it saved as chips. Two halves: the real engines driven from the repo (`sandbox:verify` and the 27-test integration suite, no key and no browser) and Chat scenarios that need a live key and a host started after 2026-10-03. A stub Chat never calls it.
- [Images](./images.md) — studio shell on Default. The needs-key note and Generate both follow the host gate. A stub desk (`allowed: true`) hides the note and does not quiet Generate (it is still disabled while the prompt is empty). The frame (aspect) is picked from the prompt until the owner touches the menu.
- [Videos](./videos.md) — studio shell. `videos-studio-needs-key` and a quiet Generate follow the video route's `ready` flag, including on a stub desk with no key.
- [Meeting](./meeting.md) — recording → transcript → minutes → EN/ID translation . Create, upload, paste and the in-browser recorder's controls work without a key; only the run reaches the gateway. A **granted microphone** needs a real Chrome window and is still unverified.
- [Music](./music.md) — studio shell and `music-studio-needs-key` without a key; describe-or-lyrics brief, two takes per charge, voice-over reported unavailable rather than offered.
- [Edit](./edit.md) — CapCut-style timeline + agent panel (`agent-edit`), shipped in 0.14.22. Storyboard generate is still a Phase 3 placeholder and `animate_storyboard` is backend-only.
- [Presentation](./presentations.md) — slide stage: filmstrip, nine shapes, nudge / duplicate / delete, title / heading / bullets on the slide, PPTX from a starter. The default builder is Open Slide (streamed Create, per-page `data-layout`, a local draft on a stub desk); Nultron is the engine under More. Regen is a real 503 without a key; Create is a stream (HTTP 200 plus `job.error`).
- [Education](./education.md) — lesson on that stage, an exam sheet, and a presenter stage. Local page reading. Lesson, page and show need no gateway key; the quiz embeds its topic on a keyed desk.
- [Desktop](./desktop.md) — **retired 2026-10-14, history only.** Electron one-window launch, splash → Chat, IPC host (no loopback HTTP). Windows NSIS exists; mac/linux are builder targets.
- [Desktop brands](./desktop-brands.md) — **retired 2026-10-14, history only.** Packaged Kemenkeu AI / AIHub Metranet vs public Nultron. Rail `product-brand` + `product-logo` must match the installed flavor, not leftover Nultron copy.
- [Mobile](./mobile.md) — **history only.** Docs only. No iOS/Android build, no stores, no Capacitor. A phone on LAN `:3000` is not a product surface.
- [Build](./build.md) — **parked / verified-unreachable.** `/studio` redirects to Chat.
- [Studio advanced](./studio-advanced.md) — **parked / verified-unreachable.** Same redirect.
