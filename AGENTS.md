# Nultron

**The vision (Rizky, 2026-10-05): everyone has all their workers inside one desk.**

A desk is a one-person company (OCP). Every job a company needs is a worker on that desk:

- Money: Finance and Data
- Contracts: Legal
- Paperwork: Documents
- Pitch and sell: Presentation and Research
- Market sense: Market
- Clients: Meeting
- Marketing: Images, Videos, Music and Edit
- Memory: Chat, Knowledge and Education

Each worker is a mode whose harness is already built in: prompt, tools, skills, checks and judges. Nobody sets up agents, skills or prompts. They add their files, ask, and get a checked result. Build with that in mind:
- **Prompt first** (Rizky, 2026-10-05). Every worker starts from one prompt box, with files optional, and no form up front.
  - The user adds values (parameters, more files, choices) later, and only when they need them.
  - Every result can be edited under that mode's rules: inline edits, then regenerating one section, slide, clip or item.
  - A regeneration keeps the user's edits. Do not make it complicated.
- Put capability into the worker's harness, not into setup. Defaults, auto-detection and code-run judges are the user's skills, so never add a step or setting the user must configure first.
- Show the result first. Keep advanced controls under "More", and run a paid step only on the user's Run.
- Keep every worker on the same desk, reachable from the rail, with one sign-in and one key.
- Make every worker hand off to the others: research to a deck, a contract's facts to a memo.
- Enterprise is the same desk shared by a team. White-label brands (HYP AI) carry the same vision under their own name.

**Read [`docs/internal/release-targets.md`](docs/internal/release-targets.md) first.** It lists every release target built from this repo: Nultron Personal, Nultron Enterprise, the HYP AI white-label for Hypernet, and the desktop flavors. For each one it gives the type, company, codebase, services, how it ships and what is running now. Name the target your task serves before you edit, and stop if the change lands on another one.

**Two products, one repo — read this before touching anything.**

The owner split the product, then still called DPSBuddy, into two products on 2026-09-23. They share a codebase and a renderer, and they diverge on packaging, deployment, identity and versioning. Work on one is not work on the other.

| | **Personal** | **Enterprise** |
|---|---|---|
| What it is | The Mac/Windows Nultron app | The hosted multi-user web app |
| Shell | Electron (`apps/desktop`), packaged IPC, **no HTTP port** | Express (`apps/web/server.ts`) behind a reverse proxy |
| Data | On the user's machine, SQLite in the user data dir | Per-tenant, on Rizky's server |
| Account | A pasted gateway key is the floor | Portal sign-in (one-time code); the pasted key stays the floor for model calls |
| Ships by | `pnpm desktop:build` → installers on `Kyoo032/Nultron` | `node scripts/release-web.mjs` → a private image `ghcr.io/kyoo032/nultron-ent:<tag>` plus a deploy bundle (pinned `compose.yml`, `.env.example`, `DEPLOY.md`, `Caddyfile`) and a GitHub Release on `Kyoo032/NultronEnt`; each deploy is logged by commit sha |
| Version | Semver — **0.16.0** is the current cut (the first Nultron-named installer) | No version number |
| Entry point | the installer | the hosted URL |

**Name: Nultron (Rizky, 2026-09-25; renamed in code 2026-09-29).** Both products are called Nultron, in public copy and now in the code. The source repo, packages and `AGENTFORGE_*` names stay agentforge. On 2026-09-25 Rizky renamed the public release repos: Personal is [`Kyoo032/Nultron`](https://github.com/Kyoo032/Nultron) (was `Kyoo032/DPSBuddy`) and Enterprise is [`Kyoo032/NultronEnt`](https://github.com/Kyoo032/NultronEnt) (was `Kyoo032/DPSBuddy-Ent`). GitHub redirects the old URLs. Their READMEs say Nultron (`620689f`, `54da47a`).

**The rebrand is done in code (2026-09-29).** The earlier rule that `productName`, installer names, data dirs, the keychain item and the image stay DPSBuddy until the logo and the in-app rename is spent. What the names are now:

- **Personal (desktop).** `productName` is `Nultron`. Data dir `%APPDATA%\Nultron` (macOS `~/Library/Application Support/Nultron`, Linux `~/.config/Nultron`); keychain / Credential Manager item `Nultron` / `wrap-key`; `Nultron.exe`, `win-unpacked\Nultron.exe`, `Nultron.app`; installer `Nultron Setup <v>.exe` and `Nultron-<v>-mac-<arch>.dmg|zip`. `appId` stays `com.tokotoken.agentforge`. The other brands (Kemenkeu AI, AIHub Metranet) are unchanged. The updater feed is `Kyoo032/Nultron` (`brand.json` `updates.repo`, since 0.15.1); installs from 0.15.0 and earlier still request `DPSBuddy`, which GitHub redirects.
- **No data migration (owner's call).** A DPSBuddy user who updates starts on a fresh desk: new data dir, new keychain item, gateway key to paste again. The real uninstaller also removes the old `%APPDATA%\DPSBuddy` and `DPSBuddy` / `wrap-key`. Do not write a migration in passing.
- **Enterprise (hosted).** Image `ghcr.io/kyoo032/nultron-ent`; `scripts/release-web.mjs` `RELEASE_REPO` is `Kyoo032/NultronEnt`; the deploy env variable is `NULTRON_DOMAIN` (was `DPSBUDDY_DOMAIN`); docker volumes `nultron-data` / `nultron-components`; compose projects `nultron-web` / `nultron-ent`. Production needs a one-off manual volume migration from the old names, written up in [`webapp-deploy/README.md`](webapp-deploy/README.md#migrating-from-the-dpsbuddy-names).
- **Not proven.** The first Nultron-named pack is 0.16.0 (2026-10-06): `win-unpacked\Nultron.exe` launched and passed `doctor --desktop`, and the mac dmg/zip passed `verify-bundle.py` in Docker. The DPSBuddy → Nultron upgrade on an installed copy, the hosted app under the new names, and any Mac launch are still not driven ([`0.16.0-changelog.md`](docs/internal/0.16.0-changelog.md)).

**Mascot and logo (2026-09-29).** The character is Nultron: `NultronMascot` (`apps/web/components/nultron/`) replaced the placeholder face, 21 states from one table (`MASCOT_STATES` and `STATE_MOTION`, `apps/web/lib/mascot-states.ts`), and what it shows is the approved 3D renders as images (`components/nultron/images/`: stills, one-shot clips, four-frame busy loops, a typed `manifest.json`); replacing a render is replacing a file, and the scene that makes those files is `tools/nultron-3d` (outside the pnpm workspace; its README and the map's "Regenerating" section give the commands), while the logo master is `apps/desktop/branding/agentforge/source/app-logo.webp`, regenerated by `node apps/desktop/scripts/brand-icons.mjs --out <dir>`. There is no vector rig and no renderer seam, and the flat brand kit that was tried and rejected the same day is not in the tree: do not add either back. Loops run only under `data-busy` (perf contract, no GPU on the packaged Windows app), with one exception Rizky chose on 2026-10-01: a gentle ambient loop on the desk background and its decoration is allowed again, **stepped in the packaged Personal app** (no GPU: about 3.4% CPU on an active Chat was the measured cost of the stepped option) and, since 2026-10-05, **smooth in a browser** (webdev and the hosted Enterprise app have the GPU; `main.tsx` writes `data-shell="desktop"` on `<html>` in the packaged shell only, `html[data-shell="desktop"]` in `app/globals.css` hands the stepped tokens back, and `lib/motion-shell.test.ts` holds both sets of values; the pre-rendered frame strips stay frame-based in both shells), as long as it pauses under `html[data-ambient="paused"]` (idle 12 s, blurred, hidden) so an idle desk stays near zero, and stops under reduced motion. The same day he asked for the background to react to the pointer, and for a full-body **desk buddy** Nultron that reacts to what the app is doing, plus the mascot back on the empty desks. The **logo** is Rizky's painted head in a blue tile, and it is not the mascot: favicon set and 256 px `logo.png` in `apps/web/public/brand`, the rail mark in `apps/web/components/brand-art` (`BrandMark`), `icon.ico` and `icon.icns` (`build.mac.icon`) in `apps/desktop/{branding/agentforge,build}`. Do not commit generated icons that are not from that image, and keep `logo.png` small: the packaged preload inlines it as base64 at every launch (about 1 ms at 110 KB, measured in an Electron preload on 2026-09-29; only a brand flavor draws it, and `apps/desktop/brand-assets.test.cjs` caps it at 200 KB). Maps: [`docs/internal/maps/mascot-and-brand.md`](docs/internal/maps/mascot-and-brand.md); recipes: `features/mascot.md`, `features/desktop-brands.md`.

Older sentences in this file that name `Kyoo032/DPSBuddy`, `DPSBuddy.exe` or the DPSBuddy data dir are history from before the rename.

**Both share `apps/web` as the renderer.** `apps/desktop` compiles it into the installer (`stage-renderer.mjs`, `extraResources: resources/renderer`), so a UI change usually lands on both. A change to packaging, identity, the key storage location, or the deploy path lands on exactly one — say which in the PR.

**The working tree may hold both lanes at once.** If you commit, check which product each file belongs to; the 0.15.0 cut had to be split by hand for exactly this reason. The enterprise Phase 9 plans/pricing/portal material is **not** part of the 0.15.0 personal-app cut.

**Goal (Rizky, 2026-09-22): many harnesses inside one app.** Every kind of work is a harness in that same app: its own screen, prompt, tools, checks, and output. The harnesses are Chat, Documents, Research, Finance, Data, Market, Legal, Meeting, Images, Videos, Music, Edit, and Presentation. A new kind of work is a new harness here, not a new app and not a custom-agent builder. Knowledge Base, Channels, Workspaces, Usage, and Settings sit on the same desk. Custom-agent Build stays parked. Hermes stays the tinkering surface outside this product.

On **Enterprise** each tenant keeps its own workspaces on Rizky's server. On **Personal** the workspaces are the user's own desks on their machine. Either way the left rail follows that workspace's `productModes`, and Packs are workspace presets. **The first desk is not the same on the two products (Rizky, 2026-09-29).** On **Personal**, the first desk of a fresh install starts with only Research, Images, Videos and Presentation, plus Chat as the home (`FIRST_RUN_MODES`, [`packages/core/src/agents/product-modes.ts`](packages/core/src/agents/product-modes.ts)); the owner adds Documents, Finance and the rest from Workspaces. On **Enterprise** the first desk keeps every harness (`HOSTED_FIRST_DESK_MODES`; Rizky has not decided it). An existing desk is never rewritten. Catalog: [`docs/product-modes.md`](docs/product-modes.md).

**Status: closed beta** (not prototype). Public entry point: [`README.md`](README.md).

## Product direction (Rizky, 2026-10-06): Nultron + HYP AI, chat-first

**Nultron and HYP AI are the products developed regularly.** Keep shipping and iterating on those two as the main build focus.

**Archive / deprioritize mode-heavy complicated UI setup.** Do not invest in elaborate multi-mode UI configuration flows.

**Focus: put everything inside chat and optimize in-chat UIs and flow.** Prefer chat-native surfaces over separate setup screens.

**North star: like Dots and Muse, but multi-model.** Multi-model chat-first wins.

**Bots on harnesses (Rizky, 2026-10-06 evening).** The chat-first shell shows each harness as a bot with its own conversations and a side panel (computer, routines, the mode's control fields). What sets it apart from a skills-and-instructions product: a bot here is a harness the host enforces. Three decisions from him the same evening:

- People can hire their own bot. That lifts "custom-agent Build stays parked", in the tester code only, until a pull request he approves brings it here.
- The cloud computer (VPS) and the person's own computer are paid features. A free trial cannot use either, and gets no graphical screen.
- Routines (scheduled runs) are free on every plan (Rizky, 2026-10-07: "routines are free, since they cost tokens anyway"). A routine that needs a computer still needs a paid plan for that part.
- The host enforces that from the plan the portal reports. The renderer only displays it.

The plan is in the tester folder: `docs/internal/chat-first-plan.md`, "Second reference", "Hiring a bot", "Free and paid" and Track B.

**Private by person on Enterprise (Rizky, 2026-10-06 evening).** His words: "even on enterprise the knowledge base of everyone will be different and private". A company shares a desk, but each person's Knowledge Base is their own, and a document a person attaches in Chat is private to that person. The host enforces it; the renderer only displays it. Personal has one person per desk, so nothing changes there, and every change for this needs a Personal-parity test. What is shared and what is private on a team desk today has not been mapped yet; map it before changing a table.

Two more answers from him the same evening:

- **Sharing goes through a bot.** A person's own knowledge stays private. What a team shares is a bot's knowledge: a bot shared with the team brings its knowledge with it, so teammates can use that bot and call it. There is no "share this source with the company" switch on a person's own Knowledge Base.
- **When a person leaves, the company decides.** The business owner or an admin chooses whether that person's knowledge is deleted or kept.
- **Nobody else reads it, the owner and admins included.** His words: "they cant read the knowledge, it must be blocked", with legal terms to back it later. An owner or admin may delete or keep a person's knowledge and may never open it. The host blocks it; the terms come later and are not a substitute for the block.

**This is design only for now (Rizky, same evening): "dont make it too complicated".** Do not build the per-person Knowledge Base, bot knowledge sharing or the leaver controls yet. The one piece being built is that a document attached in Chat is private to the person who attached it. The build focus is the chat and several agents working together.

### Two codes (Rizky, 2026-10-06; must follow)

Nultron is always kept as two codes, and a change to one must never break the other.

- **Published:** this folder, `C:\Users\rizky\agentforge`, branch `main`. Nultron as released, with the mode screens. HYP AI is built from it. Every release runs from here.
- **Tester:** `C:\Users\rizky\agentforge-chat`, branch `tester/chat-first`, a git worktree of this repo. Chat only, with the modes running behind the chat as workers. Its plan and specs live in its own `docs/internal/` (`chat-first-plan.md`, `chat-workers-spec.md`, `model-tiers-spec.md`, `chat-computer-spec.md`), and its rules are in its `TESTER.md`.

Rules:

- A problem that shows on `:3000` is fixed here on `main`, then merged into the tester folder. It is never fixed by hand in both.
- Changes move one way, from `main` into `tester/chat-first`. Tester work reaches `main` only through a pull request Rizky approves.
- Never run a release from the tester folder. The tester webdev uses port 3200 and its own data folder.
- The precise map (which change goes where, which files the tester code may edit, how to update) is in Rizky's Obsidian vault: `C:\Users\rizky\Documents\Obsidian\40-Dev\nultron-two-codes-map.md`. Keep it current in the same session as any change to the split.

`.ref/` (gitignored) holds two third-party repositories for reading only, OpenMausBot and hermes-agent. Take ideas, never code, and never anything from `OpenMausBot/enterprise/`.

### HYP AI hosting plan (Rizky, 2026-10-07)

His words: "start small first with like 100-500 users", then "when there is demand on the next 2 weeks then we can change and switch". The order of work he set the same day is Nultron preview first, HYP AI after he has tested Nultron. The server itself is a priority, because he has to give Hypernet its address.

**Who owns what (Rizky, same day).** His words: "this machine will be theirs anyway, im on the rnd and theyre on the production and the marketing sales". Rizky's side does research and development. Hypernet runs production, marketing and sales, and the server is theirs. Hypernet connects its own domain to the server: two names, one for the app and one for the sign-in page, each an A record to the Elastic IP, with no AAAA record and no proxy in front, because the server gets its own certificates.

**Stage 1, now: one CVM.**
- Tencent Cloud CVM in Jakarta, SA5 4 vCPU / 8 GB, Ubuntu 24.04, 50 GB system disk and 100 GB data disk. About 64 USD a month, inside the 100 USD October budget.
- Its own machine and its own address. Never the Lighthouse box that serves the DPS sites (NDA).
- Bind an Elastic IP and give Hypernet that address. It stays the same through a resize or a rebuild.
- Buy it inside a VPC, so it can join a scaling group later.
- Before testers arrive, a load test on the real machine replaces the capacity estimate. The rig is in `C:\Users\rizky\hypey\deploy\loadtest\`.

**Stage 2, when demand comes: resize the same CVM.**
- 8 vCPU / 16 GB is about 117 USD a month, then 16 / 32. A resize is a restart of a few minutes.
- One server is the ceiling, at about 19,000 accounts by the capacity model. That number is an estimate and has not been measured.

**Stage 3, later: Auto Scaling.** He pointed at Tencent Auto Scaling (doc product 377). What its docs say, read on 2026-10-07:
- It adds and removes whole servers behind a load balancer, by load or by schedule. The service is free and the servers are billed.
- It cannot make one server bigger: "Auto Scaling does not support scaling up".
- Apps in a scaling group "should be stateless and replaceable", and the servers "cannot save the status information and data".
- A CVM bought now can be added to a scaling group later if it is in the same region and VPC and is running. A server added by hand is not terminated when the group shrinks.

The hosted app does not meet that today. It is one process on one SQLite file with customers' files on the local disk (SR-29, SR-66), so a second server would start empty. The Kubernetes manifests in `webapp-deploy/k8s/` run exactly one app pod for the same reason. Before Auto Scaling can add servers:
- the product database moves off SQLite to a managed database (open decision 1 in the pivot record);
- files move to object storage (the COS backend has never run against a real bucket);
- sign-in sessions, the run cap and in-flight jobs are shared between servers;
- the app starts from a server image and passes a health check behind a load balancer.

None of that is started, and it does not fit in two weeks. Do not start it in passing: it needs Rizky's word. At rest that stage costs about 185 USD a month (two servers, a load balancer, a managed database) before any scaling.

Earlier the same day he chose a Lighthouse 8 vCPU / 16 GB (78 USD a month) and then changed to CVM. Prices, the Lighthouse table and the doc links are in the vault note `40-Dev/nultron-hosting-map.md`. The deck is `nultron-files/hyp-ai/HYP-AI-Auto-Scaling-Tencent.pptx`.

## Current focus (Rizky, 2026-10-01): fix, perfect, polish — no new modes

Until Rizky lifts it, work is limited to three things, in this order:

1. **Fix the bugs.** Product findings in [`docs/internal/unreleased.md`](docs/internal/unreleased.md), the open rows in [`docs/internal/security-register.md`](docs/internal/security-register.md), and whatever a verify pass turns up.
2. **Perfect the harnesses that exist.** Each mode's prompt, tools, checks, output and locale should work end to end on webdev and on the packed app. The modes are the ones already in `packages/core/src/agents/product-modes.ts`.
3. **Fix the UI.** Spacing (borders and outlines sitting on the text), overlaps (the top-right theme control covering mode headers), clipped or overflowing labels, and dark-mode contrast, on both products' shared renderer, at desktop and phone widths.

**One approved exception (Rizky, 2026-10-01): bring-your-own-key on Enterprise.** Enterprise users may connect Toko Token, OpenAI, Anthropic, Google and OpenRouter keys, company keys set by owners/admins plus personal keys, each provider on a base URL pinned in code (`packages/core/src/providers/registry.ts`, never a typed URL); a failed job retries on the same provider only unless the company turns on cross-provider fallback in its settings. Personal stays pinned to the Toko Token gateway (SR-85). Every BYOK change is gated to server mode with a Personal-parity test.

**Second approved exception (Rizky, 2026-10-03): stronger harnesses and agent tools inside the existing modes.** Each mode declares one harness spec (`packages/core/src/harness/modes/`), and the host enforces its tools and budget for every run (`packages/host/src/job-regen.ts`). Agents get desk files (versioned, per desk, both products), a real folder on Personal with an approval per write, `knowledge_search`, and `run_code` (Python and JavaScript in a WASM sandbox, `packages/host/src/code-runner/`). On hosted, `run_code` is off unless `AGENTFORGE_CODE_RUNS=on`, until the sandbox is proven inside the image. Plan: [`docs/internal/mode-harness-tools-plan.md`](docs/internal/mode-harness-tools-plan.md); map: [`docs/internal/maps/agent-tools-and-files.md`](docs/internal/maps/agent-tools-and-files.md); decision trail: `docs/internal/mode-harness-tools-decisions.tsv`. This added tools, not modes.

**No new modes, harnesses, rail entries or packs.** Do not add a product mode, a new job surface or a new Pack, even a small one. If a fix seems to need one, stop and ask Rizky. Refactors are fine only when a fix needs them.

### Resume here: 2026-10-05, end of day (read this before the 10-03 block below)

**Full handoff, including lanes that were running and their exact scope:** `nultron-files/handoff-2026-10-05/HANDOFF.md`. **Newer, 2026-10-06:** `nultron-files/handoff-2026-10-06/HANDOFF.md`, covering the live sites, the app preview with per-tester desks, PR #139, the 0.16.0 cut and the verify-skill findings. **Newest, evening of 2026-10-06: `nultron-files/handoff-2026-10-06/HANDOFF-evening.md`**, with one note per paused lane in `lanes/`. Read it first: ten lanes were paused mid-work (ffmpeg in the image is live on the preview; the desktop bundle, the run cap, chat error recovery, document upload, the deck tool, the image-attachment fix, team privacy, the H1 knock gate and the HYP AI bundle are on unmerged branches or local folders), the local `edge/` folder is NOT safe to deploy, and the document-upload branch is half way through its review fixes.

**Git (2026-10-06).**
- `main` is at `de95267`, after PR #138.
- PR #139 is open: `packages/core/src/data` back in the app image, plus SR-132 and SR-133.
- Branch `chore/verify-skill-maintain-2026-10-06` holds the verify-skill maintenance and these notes.
- Branch `chore/release-0.16.0` (a worktree) holds the Personal 0.16.0 cut. It is dry-run only: publishing needs Rizky's OK at that moment.

**Git (2026-10-05).**
- `main` is at `b1839ad`. PRs #119–#133, #125, #127, #136 and #137 are merged. #137 fixes the blank dev renderer.
- PR #134 (old rename) is superseded and open. It is waiting on Rizky to close it.
- The edits that sat uncommitted in this checkout were committed on the evening of 10-05 on branch `chore/vision-motion-deploy-2026-10-05` (from origin/main) and opened as a PR to `main`. They are:
  - this AGENTS.md (the vision and prompt-first sections at the top);
  - `docs/internal/release-targets.md`;
  - the Nultron motion smoothing (`apps/web` css, `shell-motion.ts` and tests, map, recipe);
  - the SR-113 audit-closure follow-up (`ci-local` lists `--prod`);
  - deploy and security doc refreshes.

**Worktrees in flight.**
- `C:\Users\rizky\agentforge-docflow` (`feat/doc-flow-2026-10-05`): Legal, Finance and Meeting "add files → answers". Plan: `docs/internal/doc-flow-plan.md` there, with owner answers in 7a.
  - Done: L0 judges, W routes, L3a Meeting engine, L4a Finance engine.
  - Running: L1 Legal engine, L3b Meeting UI, L4b Finance UI.
  - Next: L2 Legal UI, then L6 integration (register `PUT /meetings/:id/minutes/edits` in router.ts plus its tenancy row, merge main, maps, ci:local, PR).
- `C:\Users\rizky\agentforge-multisite` (`feat/multi-site-edge`): one Caddy serving dpscloud.co.id, nultron-ai.xyz plus portal, and tokotokenai.com. `api.tokotokenai.com` is never served. Not pushed.
- `agentforge-hotfix` (PR #137, merged) and `agentforge-pr134` can be removed.

**Decisions on 10-05.**
- The vision and prompt-first rules are now at the top of this file.
- Nultron keeps Toko Token. White-label brands show TokenKu. The HYP AI clone pinned `https://api.tokenku.ai/v1` on 2026-10-06 (Rizky); the interim `api.tokotokenai.com` backend is gone there, and no call with a TokenKu key has been made yet.
- Hosting (to learn, then try): one Tencent Lighthouse in Jakarta hosting dpscloud.co.id (the parent site), nultron-ai.xyz (app) with portal.nultron-ai.xyz, and tokotokenai.com.
  - Keep the DNS for `api.tokotokenai.com` untouched.
  - Company mailboxes are self-hosted on the same box (Stalwart), sending through Tencent SES; see "Tencent hosting" below. Nultron's sign-in codes go through SES from `mail.dpscloud.co.id`.
  - Guide: `nultron-files/deploy/hosting-guide.html`.
- Nultron motion: smooth in browsers, stepped in the packed app. The CPU trade-off is still open; Rizky has not chosen between capping the background at 20 fps or keeping 60.

**HYP AI (Hypernet) demo, 2026-10-06: ready.**
- The clone `C:\Users\rizky\hypey\app` is synced to b39cdf2 by vendor branch (`hypey/intake/SYNC.md`), committed on its own `main` (`35f2c8f`). It runs on :3301 (`hypey\start-hyp-ai.cmd`, gate ok). Do not sync upstream before the demo.
- Deck: 26 slides, `hypey/intake/deck/HYP-AI-OPC-Platform.pptx` (+ `.pdf`); an animated copy `...-animated.pptx` was being built. Video: `hypey/intake/video/HYP-AI-OPC-90s.mp4` (1080p30, 90 s).
- 3D Hypey is paused. The look-dev is in `hypey/intake/3d/look-dev/`.

**Tencent hosting (updated 2026-10-06).** Everything lives in `nultron-files/deploy/tencent/`, which is gitignored. Its `README.md` is the runbook and the log. The day's full handoff is `nultron-files/handoff-2026-10-06/HANDOFF.md`; read it first next session.

**The box.**
- Lighthouse Jakarta `43.165.195.135`: Ubuntu 24.04, 2 vCPU / 7.5 GB.
- SSH is key-only (`~/.ssh/dpscloud_lighthouse`, user `ubuntu`).
- One Caddy 2.11 (`edge/compose.yml`, compose project `edge`) serves every site.
- `edge/deploy.ps1` ships a site only when its apex and www resolve to the box.
  - It always ships every ready site from `www/`, so use the staging copy described in the runbook while a site is mid-rebuild.
  - Flags: `-SiteOnly`, `-BuildApp`, `-ProvisionApp`, `-Bootstrap`, `-HardenSsh`.

**Live sites** (all `noindex` until Rizky approves the copy):
- **dpscloud.co.id**: the parent company profile.
  - 26 pages in ID and EN, generated by `src/dpscloud/build.py`.
  - Partner pages in brand colours, customer logos, and a contact form posting to `/api/contact`. That relay is the `edge/contact/` service; it stores submissions and notifies Lark when a webhook is set.
- **tokotokenai.com**: links to `api.tokotokenai.com` (dashboard, docs, pricing). Never touch the `api` CNAME. The hero prices are Rizky's; the group section still differs.
- **nultron-ai.xyz**: the Nultron landing, with video and the guide mascot.

**Rule (Rizky, 2026-10-06): Nultron is "coming soon" on every public page.**
- No GitHub download links.
- No public link to the web preview.
- Never "closed beta", "testers" or "invitations".

**App preview: https://app.nultron-ai.xyz**
- It runs the image `nultron-web:<sha>`, built from `git archive`. The app runs off server mode through `edge/app/preview-server.ts`. Security register SR-133 holds the decision record.
- **Since 2026-10-07 it runs `nultron-web:0d829f00bc81`** (`main` at `0d829f0`). The tag before it was `5bec53280e27`.
- **Updating it (must follow).** The box also serves three websites through the same proxy, and Rizky asked for care. Use the runbook section "Update the app image only: the safe route" in `nultron-files/deploy/tencent/README.md`:
  - Rizky says go in the chat for that deploy. If the permission system refuses a step, stop and hand him the commands.
  - Build and test the image on the PC, send it with `docker save | ssh docker load`, and change only `app/app-image.env`.
  - Recreate the desks one at a time with `--no-deps`, a tester desk first as a canary, the owner's desk last.
  - Never recreate the proxy on its own: every desk lives in its network namespace and would answer 502.
  - Do not run `edge/deploy.ps1` while the local `edge/` folder holds undeployed work.
- Each login is HTTP Basic Auth and lands on a private desk:
  - `nultron` (Rizky) on port 3000;
  - `tester01`–`tester10` on 3001–3010, each with its own volume and its own key slot, created by `edge/app/add-testers.sh`.
- `edge/app/check-app.sh` runs 20 checks on every deploy.
- Admin status, the desk switch, SQLite upkeep and fail2ban were being added on 10-06.

**Mail.**
- Company mailboxes use Lark custom-domain mail. The self-hosted Stalwart kit in `edge/mail/` is shelved, with `MAIL_DOMAIN` empty.
- SES is reserved for Nultron sign-in codes on `mail.dpscloud.co.id`.

**Open.**
- The Enterprise release on Thursday 8 Oct replaces the preview.
- Moving `edge/` into the repo as `webapp-deploy/edge/` needs Rizky's OK, because this file forbids a third deploy path in passing.

### Resume here: 2026-10-03, end of day (paused at Rizky's request)

Rizky paused the run to sleep. Continue from exactly this state. Read this block, then the plan and the trail it names, before touching anything.

**Git state.** Branch `feat/nultron-ent-pilot-byok-2026-10-02`, HEAD `0b61a29` (same as `main`). **Nothing is committed and nothing is pushed.** About 650 changed files hold five programs at once: the Enterprise Phase 0 pilot, BYOK Phase A, the Personal UI pass, the verify-skill maintenance (2026-09-30 to 10-02), and the 2026-10-03 harness program.

**Owner decisions on 2026-10-03.**
- The harness program and its tools (the "Second approved exception" above). Rizky's four answers: JavaScript and Python in WASM; desk files plus a real folder on Personal; tools in every model-driven mode; both products now.
- Commit everything on this branch, one commit per program, staged by path, no push.
- Then push to prod: the Enterprise release to `Kyoo032/NultronEnt` with the ghcr image, and the Personal public release to `Kyoo032/Nultron`. Releases and deploys cannot be undone, so confirm with Rizky at the moment of release even though he has said go.
- Defaults the orchestrator set, which Rizky may reverse: hosted `run_code` off unless `AGENTFORGE_CODE_RUNS=on`; the egress guard after private reads (SR-112).

**Verified on 2026-10-03.**
- Unit suites in core, host, db and web are green.
- The real-engine sandbox passes 27 of 27 (`ci:local --only sandbox:integration`).
- The live smoke on `:3000` matched the baseline 6 of 6 (`packages/host/eval/harness/results/after-2026-10-03.json`).
- A live Chat drive proved desk-file edits and `run_code` (`evidence/{files,code}/2026-10-03-live-after-restart/`).
- `ci:local` has two reds. `test:apps/portal` fails because embedded Postgres refuses an administrator shell, which is the environment, not the code. `audit:deployed` fails on `braces`, SR-113.

**Half done when paused (both lanes stopped mid-edit).**
1. **Third-party notices for the sandbox runtime.**
   - Touched files: `scripts/sandbox-licenses/{notices.mjs,pyodide-MPL-2.0.txt,cpython-PSF-2.0.txt}`, plus edits in `scripts/build-sandbox-runtime.mjs`, `scripts/sandbox-runtime-lock.mjs` and `scripts/sandbox-runtime.lock.json`.
   - One test is red: `validateLock refuses a file name that could leave the output folder` in `scripts/build-sandbox-runtime.test.mjs`.
   - `vendor/sandbox-runtime` was not rebuilt, so `sandbox:verify` still passes on the old build.
   - To finish: extract each wheel's `*.dist-info` license files, write `THIRD_PARTY_NOTICES.txt` into the ship dir and its MANIFEST, fix the test, then run `npx pnpm@9.15.9 sandbox:build --offline` and `sandbox:verify`.
2. **SR-113 `braces` (HIGH, no fix published).**
   - The path is `tailwindcss` 3.4.19, a devDependency of `apps/web`, through `chokidar`, `fast-glob` and `micromatch`.
   - The lane's approach is to make the image runtime install production dependencies only. So far it has done two things:
     - moved `tsx` from devDependencies to dependencies in `apps/web/package.json`;
     - made `vite` a dynamic import on the non-production branch of `apps/web/server.ts`.
   - `pnpm-lock.yaml` changed with it.
   - The `webapp-deploy/Dockerfile` runtime-stage prune is **not done**, and `audit:deployed` is still red.
   - To finish: prune the runtime stage to production dependencies, then prove every runtime import of `tsx server.ts` resolves, transitively through `packages/host`, `core` and `db`.
     - Then re-run `ci:local --only audit:deployed` and update SR-113.
     - If the prune cannot work, use a `pnpm.overrides` path or an accepted-risk entry, but only if `scripts/audit-deployed.mjs` supports one. Never invent a bypass.

**Next, in order.**
1. Finish the two items above. Then run `/verify` and `npx pnpm@9.15.9 ci:local`; the only red left should be the portal environment.
2. **Commit, grouped, no push.**
   - The classifier is `nultron-files/handoff-2026-10-03/classify.mjs`, with its output in `groups.json` beside it; re-run it, since files have changed since. Every file modified after `2026-10-03T12:00Z` belongs to the harness program.
   - The rest splits by path:
     - verify skill and docs: `.cursor/**`, `docs/**`, `*.md`;
     - renderer: `apps/web/**`, `apps/desktop/**`;
     - pilot and BYOK: everything else.
   - A file that holds both older lanes' hunks and the harness program's goes in the harness commit, so the earlier commits may not build on their own. Say so in the commit messages.
   - Never `git add -A`. The repo's own attribution rules apply.
3. **Personal cut 0.15.2.**
   - 0.15.1 is published, so the next pack needs a new version.
   - Bump `apps/desktop/package.json`, then write `docs/public/0.15.2-notes.md` and a `0.15.2` changelog, and commit.
4. **Hosted image proof.**
   - Build `webapp-deploy/Dockerfile`.
   - Inside the image (Node 22, read-only root, `noexec` /tmp, `cap_drop ALL`), run Python and JavaScript through the sandbox with `AGENTFORGE_CODE_RUNS=on`.
   - Also prove `tsx server.ts` boots with production dependencies only.
   - The sandbox has never run on Linux or Node 22. Docker Desktop was started on 2026-10-03.
5. **Packs, following `.cursor/skills/pack-nultron/SKILL.md`.**
   - Windows NSIS in a worktree from the new HEAD, then launch `Nultron.exe` and run `doctor --desktop`.
   - Drive the folder flow on the packaged app. `pnpm desktop:dev` has no preload, so the packaged app is the only place it works. Playwright `_electron` with the dialog stubbed in the main process can do it.
   - mac via the Docker route with `verify-bundle`. Mac stays "preview" until someone smoke-tests it on a Mac.
6. **Prod, after Rizky confirms at that moment.**
   - Enterprise: `node scripts/release-web.mjs --tag ent-YYYY.MM.DD --sha <sha> --dry-run`, then without `--dry-run`. The Tencent deploy is Thursday 8 Oct.
   - Personal: `release-desktop.mjs --require-mac --dry-run`, then for real.
   - Record both in the deploy log and the pack table.

**Pointers.**
- Plan: [`docs/internal/mode-harness-tools-plan.md`](docs/internal/mode-harness-tools-plan.md).
- Decision trail: `docs/internal/mode-harness-tools-decisions.tsv`.
- Map: [`docs/internal/maps/agent-tools-and-files.md`](docs/internal/maps/agent-tools-and-files.md).
- Register rows SR-111 to SR-130; SR-112 and SR-113 need Rizky's call on their residuals.
- `docs/internal/unreleased.md`, section "2026-10-03: mode harness and agent tools".
- The sandbox prototype logs and escape matrix are in `nultron-files/handoff-2026-10-03/`.
- `:3000` runs `tsx server.ts` from `apps/web` with `AGENTFORGE_DATA_DIR=C:\Users\rizky\agentforge\.webdev-data-design`. If it is down, start it that way. The host does not hot-reload.

Where things stand on 2026-10-01 (end of day; NOTHING below is committed — everything sits in the working tree on `main`, the agent's branch/commit was blocked by the permission classifier, so Rizky branches and commits by path/hunk; stage by hunk where a file also holds other lanes' edits):
- **Verify skill maintained twice** (2026-09-30 and 2026-10-01, outcome `changed`): all 41 recipes driven on webdev; evidence under `evidence/<feature>/2026-10-01-maintain2/`.
- **Personal UI pass:** spacing/contrast fixes, header art no longer overlaps text, Nultron wordmark in IP colours, Nultron as desk buddy (rail) and as page host (`BuddyStage` in every `ModeHeader`, on the Chat composer), Chat greeting bubble + sky background, interactive stepped background. Chat-sky leak across kept-alive panes fixed (`:not([hidden] *)`).
- **Enterprise Phase 0 pilot (see "Current focus" and the deck `nultron-files/deploy/Nultron-Enterprise-TKE-Plan.pptx`):** SR-85 (packaged gateway pin), SR-25 (boot guards before SQLite), pricing billing probe gated on sign-in, Caddy `sign_in_filters` (SR-72) + webhook 404 (SR-03), pilot compose stack (app + Caddy 2.11 + portal + Postgres + prepare, `portal.env` split, Tencent SES `sg-smtp.qcloudmail.com:465` implicit TLS), Kubernetes manifests `webapp-deploy/k8s/` rehearsed on Docker Desktop (left running: https://nultron.localhost:8443), invite-code sign-in with state-aware e-mail step and `role` claim (`pnpm portal:invite`), host reads the role (no more everyone-is-owner), Erase account deletes people + sessions (owner only, typed `DELETE`), "Add it later" for the key on hosted.
- **Done in the evening (verified by the orchestrator):** BYOK Phase A (provider registry `packages/core/src/providers/`, per-tenant model cache, `redirect: "manual"` with keys, exact-host check — all server-mode only; Personal untouched). Two Opus 5.5 reviewers (security/code-leak; correctness + abuse walk on the k8s rehearsal) found nothing critical; their findings are fixed in the tree: stale `webapp-deploy/.dockerignore`, the billing test time bomb, `ci-local` false greens, hosted model-cache warm-up after upgrade, hosted enhance without a key → 403, portal retired-code revival, double-submit codes, invite lock on the 5th wrong code, seat cap at the e-mail step, the Edit needs-key note and hosted ffmpeg copy, the Erase button at 360 px. Each is in `docs/internal/unreleased.md`.
- **Next (Rizky paused 2026-10-01):** (1) the leftovers batch is done and verified (hosted first-sign-in locale from `Accept-Language`, no `ffmpeg.setup` on hosted `/edit/doctor`, Edit Go/recipe/Generate quiet without a hosted key; in `unreleased.md`); (2) rebuild the rehearsal and re-run the abuse walk on the fixed portal + app; (3) batch the security register from `nultron-files/register-pending-2026-10-01.md` (SR numbers from SR-86; the register has NOT been updated today beyond SR-85 and the SR-21 wording); (4) BYOK Phase B (chat on five providers, company + personal keys, owner/admin-only key writes — today any member can forget or replace the company key —, cross-provider fallback as an audited company setting, forced fresh portal check at erase).
- **Open owner decisions:** whether Erase also closes the company in the portal (people now sign back in to a fresh empty company), the Indonesian Erase label "Hapus permanen akun perusahaan", who pays testers' model usage, ffmpeg in the image, whether to close the tenant (portal has no org erase), the one-off owner-row demotion (moot on a fresh box), the light-theme mode colours (done), the in-app plan catalog placeholder vs the $24 seat proposal.
- SR-85 is fixed in the tree and not yet packed. The packaged app sets `AGENTFORGE_PACKAGED=1` (`apps/desktop/main.cjs`, `bootstrapPackaged`), and a brand flavor's gateway now travels as `AGENTFORGE_BRAND_GATEWAY_URL`.
- No Nultron-named installer has been packed yet, so every desktop claim is still unproven on a packed app.

**Direction.** Personal is under active development again and released as **0.15.0** — the `0.14.2x` scheme was scoped to maintenance cuts while the desktop was frozen, and 0.15.0 is a product release, so it takes the next minor. Enterprise is priced per user and contacted through DPS. The 2026-09-18 decision record, open decisions, and deploy log are [`docs/internal/web-pivot-2026-09-18.md`](docs/internal/web-pivot-2026-09-18.md). The gateway stays the model backend for both.

This file is the project source of truth for coding agents. Vault memory at `C:\Users\rizky\Documents\Obsidian` is for Rizky, not for this repo’s domain rules.

**Two uses of the word harness.** A *job harness* is a product mode, and it ships. The *agent guardrails* below do not: the verify skill [`.cursor/skills/verify-agentforge`](.cursor/skills/verify-agentforge/SKILL.md), the pack skill [`.cursor/skills/pack-nultron`](.cursor/skills/pack-nultron/SKILL.md), and the Cursor **pstack** plugin (`how` / `why` mapper, `create-verification-skill` / `maintain-verification-skill` verifier). Project skills call the original pstack skills; nobody vendors pstack into `apps/`, `packages/`, the installer, or the UI. Rules and model routing are in **Agent guardrails** below.

## Harness pass (verify skill, mapper, repack) — landed 2026-09-15, maps extended 2026-09-17

This section is the record of that pass. The checklist under it is what the pass was asked to fix; it is not an open task list. Login has since landed (Phase 9): do not treat “no product login” as a current rule.

**Landed 2026-09-15.** Deliverable 1 is done — the verify skill is maintained (`features/locale.md` and `features/gateway-gate.md` added, 15 dead one-off scripts removed, `doctor --base`, live pass driven on webdev) — and so is deliverable 2, eight map pages under [`docs/internal/maps/`](docs/internal/maps/README.md), extended on 2026-09-17 to 23 pages covering every mode plus the shell rail, chat sessions, Knowledge flows, PII and Market Watch, with a new `features/rail.md` recipe and every feature file linked to its map. The findings those mapping passes produced are logged in [`docs/internal/unreleased.md`](docs/internal/unreleased.md) (“Findings from the mapping pass”, “Findings from the knowledge-flow pass”) — they are product bugs to schedule, not map errors. Deliverable 3 was exercised for real rather than rehearsed: 0.14.26 was packed twice (Windows worktree + mac Docker, one supersession) and the traps are in [`.cursor/skills/pack-nultron/traps.md`](.cursor/skills/pack-nultron/traps.md) (the skill was `pack-dpsbuddy` until 2026-09-29). Still owed: a packaged-app drive from the verify skill (a `DPSBuddy.exe` was running during the pass, so the live pass stayed on webdev), and the Legal recipe, which has still never been driven. The mac hardware smoke was done by the owner for 0.14.26 (Rizky installed and launched the dmg on Mac hardware himself; it works — the first release with a mac launch confirmed on hardware).

Rizky’s order (2026-09-15): bring the harness up to the tree first, then build 0.14.26. Three deliverables, each its own PR, each proven by driving, none touching product code.

### 1. Verify skill — run pstack `/maintain-verification-skill` on `verify-agentforge`

The skill was last touched on 2026-09-14, before the locale PRs and the renderer gate landed, so the honest outcome is `changed`, not `clean`. Known rot to fix under that skill’s edit scope:

- `scripts/` holds 15 one-off `drive-*`, `loop-*`, `poll-*`, `probe-*`, `reverify-*` files next to `doctor.mjs`, while **Helpers** says doctor is the only helper. Promote the ones a recipe still needs (executable, invocation documented in the skill body) and delete the rest. `desktop-app-url.mjs` stays; doctor imports it.
- No recipe for the locale switch. Add `features/locale.md` (four-H2 contract): Settings language select `settings-locale`, the restart banner `settings-locale-restart` and its apply button, then an `id` walk of the rail, Chat, and one job mode, plus the parity tests as the source check.
- No recipe for the gateway gate. Add `features/gateway-gate.md` for the states that exist now: `onboarding.gate.*` reasons, the Settings status row `settings-gateway-status` + `settings-gateway-recheck`, 7-day grace, and the `settings-reset` card (already in `features/settings.md`). The host gate and the `403 gateway_blocked` answer both landed on 2026-09-15, so every step is drivable on webdev with a throwaway data dir.
- `features/README.md` still says Edit rail `mode-edit` “lands in Phase 1; Loop 0 only ships the map” — Edit shipped in 0.14.22. Reconcile. Keep “No product login” true, and add that login, when it lands, is the device-code door and never a password.
- SKILL.md **Delegation** names Cursor models only. Add the Claude Code routing line from **Agent guardrails** below.
- The live pass is required: doctor, drive every feature once, evidence under `evidence/<feature>/<run-id>/`, teardown after the last drive. Product bugs it finds go to `docs/internal/unreleased.md` as findings, never into the skill PR.

### 2. Mapper — pstack `how` / `why`, recorded in-repo

pstack `how` and `why` print to the chat and write nothing to disk. The map for agentforge is therefore two things kept in git:

- **Where to press:** `.cursor/skills/verify-agentforge/features/<feature>.md` — user POV, testids, gotchas. Owned by the verify skill.
- **How it works:** `docs/internal/maps/<subsystem>.md` — the dated `how` output (user action → code path → where to fix) and, when a decision needs a record, the `why` findings with their sources and confidence. First page to write: Chat send, moving the 2026-09-06 `## how — Chat send (pstack)` block out of [`docs/internal/0.14-changelog.md`](docs/internal/0.14-changelog.md). Then, in this order: settings + gateway gate, locale boot and the run harness (`localeForRun` → `withOutputLanguage`), knowledge ingest loop, desktop pack routes.
- A feature file’s opening paragraph links its map page once one exists; a map page names the feature file that verifies it. `how` runs read-only. A map page that disagrees with the code is fixed the same day or deleted; a stale map is worse than none.

### 3. Repack skill — `pack-nultron` becomes the Windows + macOS repack route

**The pack skill serves the Personal app.** It still works exactly as written, and it applies to the Mac/Windows Nultron app — currently `0.15.0`. It never packs the hosted web app. That app ships as a container image and a deploy bundle through `scripts/release-web.mjs` (see **Web release (hosted)**).

Today’s skill packs once from HEAD. A repack (same version, after a fix) must be a documented route in that skill, not improvisation:

- **Same version, new artifact.** Remove the previous worktree first (`git worktree remove C:\Users\rizky\agentforge-pack-<v>`) or suffix the new one with the short sha; never rebuild inside the old tree. Move the superseded exe, blockmap and `latest.yml` to `apps/desktop/dist/superseded-<sha>/` before copying new ones in. `latest.yml` is regenerated by the build, never hand-edited.
- **Docker packs HEAD.** Commit the fix first. `--allow-dirty` never produces a shipped artifact.
- **Proof stays per OS.** Windows: launch `dist\win-unpacked\Nultron.exe`, `doctor --desktop` from the main checkout, and the Windows smoke row after any shell change. macOS: `verify-bundle.py` on `.app` **and** dmg/zip per arch. Docker exit 0 is not mac proof; the hardware smoke (Gatekeeper, Keychain, Cmd+V, Cmd+Q, Dock reopen) is still owed, and mac stays labelled preview until it is driven.
- **Record every pack**, shipped or not: the artifact table in [`docs/internal/unreleased.md`](docs/internal/unreleased.md) (source sha, worktree, sha256, bytes, UTC) and a `## Pack + publish` block in the current changelog. `scripts/preflight.mjs` runs before either route; any trap that bites twice becomes a preflight check, not another paragraph in `traps.md`.
- **Release is separate.** `release-desktop.mjs --require-mac --dry-run`, then without `--dry-run`, only when Rizky says ship. A repack never implies a release.

## Agent guardrails (verify, map, pack)

- **Verify skill:** [`.cursor/skills/verify-agentforge/SKILL.md`](.cursor/skills/verify-agentforge/SKILL.md) — Launch / Doctor / Keys / Drive / Evidence / Cleanup / Helpers / Isolate. Read [`features/README.md`](.cursor/skills/verify-agentforge/features/README.md) before driving; each feature file is H1 + one paragraph + exactly four H2s (`Sub-features`, `How to get to it (user POV)`, `Driving it with the Nultron harness`, `Gotchas`). `scripts/doctor.mjs` (no args = webdev on `:3000`; `--desktop` = packaged app via `host-status.json`) is the health check; never drive an instance this run did not doctor. Proof = action + named result + capture + doctor JSON (+ side effect for mutations) under `evidence/` (gitignored except its README). A green `tsc`, a worker summary, or a screenshot without an action record is not proof.
- **Pack skill:** [`.cursor/skills/pack-nultron/SKILL.md`](.cursor/skills/pack-nultron/SKILL.md), [`traps.md`](.cursor/skills/pack-nultron/traps.md), `scripts/preflight.mjs` (the directory was `pack-dpsbuddy` until 2026-09-29). Two routes, never in the same cwd: Windows NSIS in an isolated worktree, macOS dmg/zip in Docker Linux from the main checkout. This PC only; Cloud aborts.
- **pstack** is the Cursor plugin (`~/.cursor/plugins/cache/cursor-public/pstack/…`, 0.15.2) plus the always-on rule `~/.cursor/rules/pstack-guardrails.mdc`. Project skills call `/how`, `/why`, `/create-verification-skill`, `/maintain-verification-skill`; they never copy them. `maintain-verification-skill` edits only `.cursor/skills/verify-agentforge/`; product bugs it finds are reported, not fixed in that PR. Its outcome is one of `clean` / `changed` / `blocked`, said plainly.
- **Claude Code sessions in this repo work the pstack way too.** Read the subsystem's map page before changing it (`how`), and refresh that page plus the matching `features/<feature>.md` in the same change. Prove by driving the real thing, not by a green `tsc` or a worker's summary (`principle-prove-it-works`); cite `file:line` for every claim. Write docs to `technical-writing` and edit them with `unslop`. Read the skills from the plugin path above; never vendor a copy into this repo. The three recipes owed from this round landed on 2026-09-21: [`features/login.md`](.cursor/skills/verify-agentforge/features/login.md), [`features/plans.md`](.cursor/skills/verify-agentforge/features/plans.md), and the Recording section of [`features/meeting.md`](.cursor/skills/verify-agentforge/features/meeting.md).
- **Model routing.** Cursor sessions: explore = Composer 2.5, worker = Grok 4.5, fan-out 2 (as the verify skill says). Claude Code sessions: every subagent on Sonnet 5.5 — explorers at medium effort, implementation and review workers at xhigh (set in `~/.claude/agents/`), and the orchestrator verifies every result itself before reporting. Neither adopts pstack’s own Fable/GPT Task slugs.
- **Maps:** [`docs/internal/maps/`](docs/internal/maps/README.md) — 46 pages, one per subsystem (`ls docs/internal/maps/*.md` minus `README.md`), each with a `Last verified: <date> at <sha>` line and `file:line` citations. Read the page before working in a subsystem; if your change makes it false, refresh it in the same PR (rewrite in place, bump the verified line) and refresh the matching `features/<feature>.md`. Product bugs a mapping pass finds go to `unreleased.md` as findings, not into the map PR as fixes.
- **Changelog is the checklist.** Every product change appends to the current changelog; the pack step reads it back; the verify pass drives it. Harness-only changes (skills, `.vscode`, `biome.json`) are labelled “harness, never ship” and stay out of the installer.

## After the harness pass: 0.14.26 — host-side gateway gate, then portal login

Read this before any work on onboarding, Settings, `/api/v1/settings`, keys, or the desktop shell.

**Phase 0 (landed 2026-09-15 on this branch): the host owns the key gate.** Contract: [`packages/core/src/gateway/gate-types.ts`](packages/core/src/gateway/gate-types.ts) — `{ status, allowed, grace, endpoint, endpointLocked: true, checkedAt, lastOkAt, message? }`, `status` in `stub | needs_key | ok | invalid_key | unreachable | error`. Host: [`packages/host/src/gateway-gate.ts`](packages/host/src/gateway-gate.ts) derives the payload from `<dataDir>/gateway-gate.json` (verdict per key fingerprint, never the key), `settingsPayload()` carries it as `gateway`, saving a key runs one 3 s live `GET <endpoint>/models`, and `POST /api/v1/settings/gateway/check` re-validates. Renderer: [`apps/web/lib/gateway-gate.ts`](apps/web/lib/gateway-gate.ts) parses it, [`apps/web/src/App.tsx`](apps/web/src/App.tsx) calls `resolveGate(payload.gateway, isElectron())` and listens for `GATE_EVENT`. **Start over** (Settings card `settings-reset`): `POST /api/v1/settings/reset` with `scope: "key"` forgets the gateway key on every desk and drops to onboarding; `scope: "all"` + `confirm: "RESET"` queues `reset-pending.json`, which [`packages/db/src/reset.ts`](packages/db/src/reset.ts) applies on the next boot before SQLite opens (named entries only — the data dir is also Electron userData), then the shell relaunches over IPC `app:relaunch` and clears Chromium storage. Proven on webdev with a throwaway data dir on 2026-09-15 (live check, sign-out, wipe on reboot); packaged Windows drive still owed. Every gateway-calling handler (runs, jobs, finance, market, legal, knowledge, enhance, edit agent) calls `requireGatewayAllowed()` and answers a flat `403 { error: "gateway_blocked", status, message }` when `allowed` is false; settings, workspaces, threads, artifacts, media, usage and the model refresh stay open so a closed gate is always recoverable. A saved key with no verdict on disk opens under grace and the host re-checks in the background (throttled, 10 min); an `ok` verdict older than 24 h falls back to the 7-day grace. Owed: the packaged Windows drive of all of it. Rules that still hold:

- The host decides, the renderer displays. `allowed` is the only thing the renderer branches on; it never re-derives a decision from `hasOpenai` or key shape. Grace = the same key validated within 7 days (`lastOkAt`), so the app opens offline.
- Every route that calls the gateway checks the same gate and answers `403 gateway_blocked` when `allowed` is false. Stub runtime reports `status: "stub", allowed: true` so Cloud / Playwright keep working.
- `endpoint` is the pinned gateway URL and `endpointLocked` is always `true` in the payload. Since 0.14.26 (`8831bc4`) the endpoint is pinned to `https://api.tokotokenai.com/v1` and the owner cannot change it — the 0.14.21 override is gone, and `POST /api/v1/settings` no longer reads `openaiBaseUrl` from the body. Since 2026-09-17 it is also hidden from Settings and onboarding: neither surface renders the URL. `AGENTFORGE_GATEWAY_URL` is a dev/test-only hook, ignored when packaged or when `NODE_ENV=production`; a packaged brand flavor gets its gateway only through `AGENTFORGE_BRAND_GATEWAY_URL`, which `bootstrapPackaged` sets from `brand.json` (SR-85).
- The key validation call reuses the 3 s budget in [`packages/core/src/gateway/account.ts`](packages/core/src/gateway/account.ts) and never blocks first paint.

**The gate is advisory, and that is on purpose.** `allowed` is a UX signal — it decides what the desk shows and which local handlers answer `403 gateway_blocked`. It is not an entitlement check and must never be read as one. Every rule in it fails **open**: `deriveGatewayGate` opens the gate when `gateway-gate.json` is missing or unreadable (the upgrade case, and any desk whose data dir was rolled back), the background re-check swallows its own failures, a verdict that cannot be written costs a cached decision and nothing else, and the whole file is plain JSON in a directory the owner can edit, delete or replace. Anyone who wants past it can delete one file. That is the right trade for a local-first desk that has to keep working offline — and it is exactly why **the 20-seat entitlement, plan limits and any spend cap have to be enforced server-side, by the gateway and the licence service, against the bearer on the request.** The client is a thin display of a decision made elsewhere (see Phase 1 below); `gateway-gate.json` is a cache of the last answer, never the authority. If a limit can be defeated by editing a local file, it was never enforced.

**Portal login (in this branch since Phase 9).** The design below was written when device-code login was still next. The client and `apps/portal` now implement it; the invariants still hold. Design is locked in [`docs/internal/portal/device-code-login.md`](docs/internal/portal/device-code-login.md) (flow, endpoints, tokens, reason codes, client integration plan), [`docs/internal/portal/schema.md`](docs/internal/portal/schema.md) (control-plane Postgres, RLS, seat count, wallet) and [`docs/internal/portal/migrations/`](docs/internal/portal/migrations/README.md) (SQL 0001–0005). The portal side was the backend team’s when this was written. Since **Phase 9 (2026-09-21)** this repo also builds `apps/portal`, a stand-in that implements those docs on the wire; see the Phase 9 section below for what that does and does not change. Names in code match those docs. Client invariants:

- **Thin client.** The app holds no licence state and makes no entitlement decision. Seats, plan, spend, model allowlist are rows in the portal DB; the client only shows the reason code it was given.
- **BYO key stays the floor.** Pasting a raw gateway key keeps working exactly as today. Login is a second, additive door. Bearer choice happens in one place, `resolveProviderKeys` in [`packages/core/src/secrets.ts`](packages/core/src/secrets.ts): explicit workspace key (unless `allow_byo_key` is `false`) → live session access token → stub.
- **New machine-scoped `StoredSession`** in `packages/core/src/session.ts`, persisted to `<localDataDir()>/session.enc` by `packages/host/src/session-store.ts` using `encryptJson` / `decryptJson` from [`packages/core/src/crypto/envelope.ts`](packages/core/src/crypto/envelope.ts). Not new fields on `StoredSecrets` (that struct is per workspace and has a renderer-facing masked projection). No new keychain slot: `apps/desktop/main.cjs` does not change for login. That is the desktop path, unchanged; the hosted web app needs a server-side equivalent for the session store and its wrap key — open decision 2 in [`docs/internal/web-pivot-2026-09-18.md`](docs/internal/web-pivot-2026-09-18.md) (browser login flow with the portal).
- **Tokens never reach the renderer and never cross IPC.** Access token lives in host memory only; a cold start refreshes. `GET /api/v1/auth/session` returns ids, email, org, seats, device label, expiry — never tokens. `MaskedSecrets` gains no token field.
- **Two device identifiers, never interchangeable.** `install_id` is client-minted (UUIDv4 in `<localDataDir()>/device.json`, mirrored in `session.enc`, never hardware-derived, survives sign-out). `device_id` is the server’s `devices.id`, returned by the token response, sent on every refresh, carried as the `did` claim.
- **Boot never waits on the network.** `hasSession` is read from disk; refresh, tenant-config revalidation and the poll all run after first paint with 3 s / 5 s timeouts and backoff. A `401` with a terminal reason clears the session; a timeout does not.
- **Tenant comes from brand config.** Add `tenantSlug` to `apps/desktop/branding/<brand>/brand.json` (today: `agentforge`, `kemenkeu`, `metranet`; no `tenantSlug` yet) and send it as `tenant_hint`. Never resolve a tenant from an e-mail domain.
- **Renderer gate (as built 2026-10-01):** on hosted, a closed gate opens the desk only for a live session plus the host's per-person `keyLater` record (the onboarding "Add it later" choice, `POST /api/v1/settings/key-later`, `apps/web/lib/gateway-gate.ts:101`); a session alone does not open it, and Personal never. The host keeps refusing every model route with `403 gateway_blocked` until a key is saved; each pane shows a needs-key note with a Settings link. Reason codes (`seat_cap_reached`, `device_revoked`, `org_past_due`, …) map to the copy table in the login doc, in both locales, through the `onboarding` catalog — not to a generic “API error”.
- New host routes go through [`packages/host/src/router.ts`](packages/host/src/router.ts) with handlers in `packages/host/src/handlers/auth.ts`; the renderer reaches them through `@/lib/api-client` like everything else. Portal calls reuse `assertAllowedEndpointUrl` and `redactSecrets`; `user_code`, `device_code`, refresh tokens and JWTs are never logged.

**Decisions Rizky has not made — do not assume an answer in code or copy:** offline grace length (7 days is the draft), whether a pasted key beats a live session, seat reclamation after 30 idle days, where BYO-key spend is billed (schema open question 7 / login doc open question 9 — there is no per-user wallet), and a per-device keypair (v1.1, needs a shell change). Payment provider (Xendit / Paddle / Stripe) is still undecided, which is why the webhook is provider-neutral. **Answered on 2026-09-21, do not re-open in code:** every tier name, price, seat cap and number is a placeholder in one config file, and there is **no token allowance** — see Phase 9 below. The "20-seat free tier" above is a draft number of that kind, not a rule.

Product rules for the client stay as before: no password, no Better Auth, no “join Harbor State”. Mail and sessions belong to the portal, not to a package inside `apps/web`. Everything local still works without the portal.

## Phase 9 — portal login and pricing (in progress, 2026-09-21)

Plan of record: [`docs/internal/web-phase9-portal-login.md`](docs/internal/web-phase9-portal-login.md). Read it before touching auth, billing or `apps/portal`. The owner's rulings, one line each:

- **Real portal login, not a dev bypass.** `apps/portal` is a new workspace app that implements `docs/internal/portal/**` on the wire. It is reached only over HTTP through `AGENTFORGE_PORTAL_URL`, never imported by the product, and it never imports `@agentforge/db` or `@agentforge/host`.
- **Postgres from day one for the portal.** `PORTAL_DATABASE_URL` is required and is never `DATABASE_URL`; `docs/internal/portal/migrations/0001-0005` run unchanged and new tables go in `apps/portal/migrations/0006+`. `apps/portal/compose.yml` carries `postgres:16` and `mailpit`, both published on `127.0.0.1` only. This says nothing about the product database, which is still SQLite.
- **Real SMTP against a sandbox** (Mailpit locally). Until a mail provider is bound the owner's team hands codes out by hand with the portal's `otp` script, which needs `PORTAL_ALLOW_MANUAL_OTP=1`, is refused in production, and writes an `otp.issued_manually` audit row. No plaintext outbox files.
- **Two placeholder plans, Personal and Enterprise**, in `packages/core/src/plans/catalog.ts`, every number marked `placeholder: true`. **No token allowance:** tiers leave `allowance_usd_micros` null, the catalog has no `tokenAllowance`, and the usage panel shows seats and plan status only.
- **Review instance on 4000 / 3100 / 3443** through `scripts/review-instance.ps1`, with its own data dir under `$HOME\.nultron-review` and **never** `.webdev-data`. `scripts/review-proxy.mjs` terminates TLS on 3443. Harness, never ships.
- **Build local, owner reviews, then a PR.** The branch is [PR #97](https://github.com/Kyoo032/agentforge/pull/97). It is not merged and not deployed.

## On `main`, not in an installer (the 0.15.0 ship list, 2026-09-17 onward)

Everything here is proven by unit tests and webdev only; none of it is packed. The log is [`docs/internal/unreleased.md`](docs/internal/unreleased.md); each line below names the map page to read before touching it.

- **Finance is task-based.** Five tasks under the rail entry — brief, ratios, budget, cash flow, appraisal — registered in `packages/core/src/finance/tasks.ts` + `tasks/`, with the maths in `packages/core/src/finance/{ratios,budget,cashflow,appraisal}/`. **Figures are computed in core, deterministically; the model names categories and writes the narrative, it never produces an amount** (`number-guard.ts`, `stated-facts.ts`, `packages/host/src/finance-section-repair.ts`). Host pipeline: `packages/host/src/finance-task.ts` → `finance-tasks/runner.ts`. Files come in through `POST /api/v1/finance/import` (25 MB / 30 sheets / 5000 rows, `import-table/limits.ts`) and go out through `POST /api/v1/finance/export` (`packages/host/src/renderers/`: xlsx, pptx, docx; pdf answers 501). An unknown `?task=` resolves to `brief`, never an error. Maps: [`finance-parse-and-generate.md`](docs/internal/maps/finance-parse-and-generate.md), [`finance-tasks.md`](docs/internal/maps/finance-tasks.md).
- **Local file extraction.** `packages/host/src/file-extract` reads pdf / docx / pptx / xlsx / odt / rtf / epub and friends on the machine through `@firecrawl/anydoc` (a napi-rs native module) with a fallback reader; 25 MB / 20 s caps, extension and magic bytes must agree or the file is refused as `format_mismatch`. **No hosted OCR, ever**: a scan is refused locally as `needs_ocr` and `no-hosted-ocr.test.ts` holds that line. Knowledge ingest and Finance import both use it. **The owner never installs it.** It is a dependency of `apps/desktop` and `asarUnpack`ed, so a packaged Windows build carries it, and the Docker mac route swaps in the pinned darwin package per arch (`build-mac.sh`, sha512 from the same manifest — a Linux install would otherwise ship ELF binaries into the `.app`, which is how the first 0.14.27 mac pack failed); where the bundled copy does not load the first-run **component installer** fetches it — see **Components** below. Not yet proven on a packed installer or on Mac hardware.
- **Components (first-run installer, 2026-09-17).** `packages/host/src/components/` is the only way the app installs a native dependency, modelled on Hermes' bootstrap: a frozen manifest → stages `check, download, verify, unpack, probe, marker` → `job.phase` / `job.step` events → an atomic completion marker → every stage `skipped` on the next launch. `GET /api/v1/components` reports `ready | missing | installing | failed | unsupported` with `source: bundled | downloaded`; `POST /api/v1/components/install/stream` runs it. Neither is gated — it runs during onboarding, before a key exists. Onboarding shows the panel (`component-setup`) and starts it on its own; an already-onboarded desk runs it silently after the gate opens. Rules: URLs and sha512 integrity come **only** from `manifest.ts`, never from a request; the hash is checked before a byte reaches the final directory; the tar reader refuses absolute paths, `..`, links and oversize archives; files land in `<dataDir>/components/<id>/<version>/` and Start over (`scope: "all"`) removes them; a failure never blocks onboarding because `file-extract` falls back. `auto` is `false` when `AGENTFORGE_RUNTIME=stub` is set or under test, so Cloud and Playwright never download. **A new native dependency is a manifest entry, never an instruction to the owner** — ffmpeg is the next candidate and today still shows the manual `ffmpeg-setup-notice`.
- **PII on the outbound copy** masks eight kinds including Indonesian identifiers (`packages/core/src/security/pii.ts`, `pii-id.ts`), and Finance adds a column-aware scanner (`finance/pii-scan.ts`, `pii-columns.ts`). Rule: redaction may hide an identifier, never a figure — `restoreFinanceAmounts` in `packages/host/src/finance-privacy.ts` puts any masked amount back. Map: [`pii-and-key-security.md`](docs/internal/maps/pii-and-key-security.md).
- **Job model fallback.** A job call that fails with a transport-class error (502/503/504, refused socket, no first token) retries once on the next live model of that mode's list (`packages/core/src/models/job-fallback.ts`, `mode-defaults.ts`, `packages/host/src/job-model-fallback.ts`), never on a pinned model, never to a second gateway; a failed model is skipped for five minutes and saving Settings clears the breaker. The result carries a `model_fallback` notice. Recipe: `features/models.md`.
- **Market Watch team.** Eleven specialist agents share one pipeline (`packages/core/src/market/specialists.ts`), a team run in `packages/host/src/market-team.ts`, per-desk watchlists, and new keyless sources (CoinGecko, metals, Reddit, StockTwits, fundamentals, global news) beside Yahoo. The host computes every number in the packet; the briefing is guarded and always carries the disclaimer. Plans: [`market-team-plan.md`](docs/internal/market-team-plan.md); map: [`market-watch.md`](docs/internal/maps/market-watch.md).
- **Rail.** Up to four recent Chat sessions sit under the Chat entry with `All sessions` expanding in place (owner decision 2026-09-17, see `docs/product-modes.md`); Finance tasks and Market specialists are rail submenus (`rail-submenu.tsx`, `rail-finance-tasks.tsx`, `rail-market-specialists.tsx`, `rail-recent-threads.tsx`). `chat-thread-list.tsx` is deleted — there is no second column. Maps: [`chat-sessions-and-rail.md`](docs/internal/maps/chat-sessions-and-rail.md), [`shell-rail-and-workspaces.md`](docs/internal/maps/shell-rail-and-workspaces.md).
- **Knowledge.** Soul store, graph prune and source-delete cascade (`knowledge-soul.ts`, `knowledge-graph-prune.ts`), a health summary in the renderer (`apps/web/lib/knowledge-health.ts`), and Market briefings now leave a work card like every other analyst desk. Maps: [`knowledge-flows.md`](docs/internal/maps/knowledge-flows.md), [`knowledge-base-page.md`](docs/internal/maps/knowledge-base-page.md).
- **Music (2026-09-21).** The rail always offers the relay-only model `suno_music`, whatever the gateway catalog lists (`RELAY_ONLY_MUSIC_MODEL_IDS`, `packages/core/src/models/media-kind.ts`). It is not a `/v1` route: requests go to `{gateway origin}/suno/*` with the gateway key and a browser `User-Agent` (`packages/core/src/tools/platform/gateway-audio.ts`). The origin is derived only from the validated gateway base URL, never from a request. The wire has never been driven live. Map: [`music-mode.md`](docs/internal/maps/music-mode.md).
- **Meeting (2026-09-21).** Mode has a live in-browser recorder as well as upload: microphone, or microphone plus tab audio (`apps/web/lib/meeting-recorder.ts`, `components/meeting-recorder.tsx`). The transcription leg walks a preference chain of gateway models and must be **proven against the live gateway**, not against a stub. Recording in the hosted app also needs the `Permissions-Policy` change in [`docs/internal/security-register.md`](docs/internal/security-register.md), SR-14. Map: [`meeting-minutes.md`](docs/internal/maps/meeting-minutes.md).
- **Finance eval harness — dev only, never ships.** `packages/host/eval/finance/` (runner, synthetic cases, README): loopback-only against webdev, `results/` gitignored, not reachable from any build. Synthetic data only; never put a real filing or a real person in a case.

## Product (locked 2026-09-02 GTM; closed beta)

- **Gateway-first.** Nultron exists because buying a key at `api.tokotokenai.com` leaves the question “where do I use this?” Open the hosted app, sign in, work. A pasted gateway key still runs the models. Native Anthropic / Google / Ark stay in the settings store, unexposed. The endpoint is pinned to `https://api.tokotokenai.com/v1` since 0.14.26 (`8831bc4`) — the 0.14.21 owner override is gone — and hidden from Settings and onboarding: since 2026-09-26 onboarding does not show the gateway address at all, and Settings still names the host in its intro sentence. `AGENTFORGE_GATEWAY_URL` is a dev/test-only hook, ignored when packaged or when `NODE_ENV=production`.
- **Two doors, no password.** Portal sign-in (browser one-time code and device code) is the account. A pasted gateway key stays the floor for model calls. No password, no Better Auth, and no account stack inside `apps/web` or `packages/host`. Mail and portal sessions live in the portal, reached over HTTP. `apps/portal` is the in-repo stand-in for that portal; the product never imports it.
- **One server, many tenants.** Every row belongs to a tenant; the host enforces tenancy, the renderer displays. Data lives in the server's data dir, not on a user's machine.
- **First-run guide (2026-09-29).** When first-run setup ends, a short guided tour is offered once: coach marks on the real rail, Workspaces, the Chat composer, the Knowledge Base and Settings, each with Next, Back (not on the first), a visible Skip and a close button; Esc closes and a click outside does nothing. It is a state machine (`idle | offered | step(n) | done`, `apps/web/lib/guide-machine.ts`) over a step registry (`guide-steps.ts`). How it ended is stored by the host beside the language (`users[…].guide` in the sealed `settings.enc`, `POST /api/v1/settings/guide`, `guide` on `GET /api/v1/settings`), so it is machine-wide on a desk, never opens on its own again, and "Start over" (which removes `settings.enc`) shows it again. Settings has "Replay the guide". Map: [`docs/internal/maps/first-run-desk-and-guide.md`](docs/internal/maps/first-run-desk-and-guide.md); recipe: `features/guide.md`.
- **First-run needs:** a gateway API key or a portal sign-in (and later optional local models such as Ollama). The wrap key comes from `AGENTFORGE_SECRETS_KEY` (env / secret manager) on the server; keys never reach the renderer, never go in git, never in `NEXT_PUBLIC_*`. The OS keychain is the desktop path only.
- **Workspaces** are the user’s own desks (which tabs they need) — not an org membership table they must join. On **Personal** the first desk of a fresh install has only Research, Images, Videos and Presentation plus Chat (**hard rule, 2026-09-29**, see Non-negotiables); an existing desk keeps whatever it has, and the hosted first desk keeps every work mode. Creating another desk (Legal, Marketing, Students, or custom checkboxes) is optional, and editing the current desk's modes on `/workspaces` is how the owner adds the rest.
- Chat is ready immediately. Model picker + composer. Building custom agents is parked, not a gate.
- Pack templates are optional workspace presets. Default Chat never uses a pack template.
- University/Harbor State is an **optional pack of templates**, not the identity of the app. Kernel stays industry-neutral (`student` / `course` do not belong in core schema).
- Do not merge **Toko Token** with **TokenKu** in copy or catalogs.
- Custom agents / Studio stay in the tree and redirect to Chat. Do not add a GTM “hidden Build” door.

### Web target

The product is the existing **Express host** (`apps/web/server.ts`) serving the built **Vite renderer**, over HTTPS behind a reverse proxy on Rizky's server. **SQLite** in the server data dir for the first deployment; the tenancy model in the schema and SQLite vs Postgres are open decision 1 in [`docs/internal/web-pivot-2026-09-18.md`](docs/internal/web-pivot-2026-09-18.md), not rules — do not write "use Postgres".

### Desktop (Personal product; current cut 0.16.0)

Installer (**Electron**) + **SQLite** in the user data dir. No Docker Postgres. **Under active development again since 2026-09-23**, as the table at the top of this file says: 0.15.0 is a product release, not a maintenance cut. From 2026-09-18 to 2026-09-22 it was maintenance-only (frozen at 0.14.27); that freeze is over.

### What to keep from this repo

Chat composer, job-mode studios, workspace templates, modality-fail-closed run APIs, OpenAI-compatible wire (`/v1/chat/completions` + `/v1/responses`) against the gateway. Agent tables and Studio files stay for a later “show Build again” pass — they are not GTM surfaces.

### What to remove from the product (later)

Harbor State seed as identity leftovers (`packages/university/src/labels.ts` still names the org). Better Auth is already gone from code; keep it gone. Public rename / UI redesign / customer-only ship is parked until closed beta feedback lands.

## Non-negotiables

- Kernel schema, APIs, and packages must not use `student`, `course`, or campus nouns. Those live in `packages/university` (optional pack).
- **The first desk of a fresh Personal install has exactly Chat, Research, Images, Videos and Presentation (Rizky, 2026-09-29; a hard rule, not a default).** Every path that writes a first desk goes through the one constant `FIRST_RUN_MODES` by way of `firstDeskModes(isServerMode())` in `ensureLocalOwner`; the hosted path (`ensurePortalOwner`) reads `HOSTED_FIRST_DESK_MODES` (every mode) and is a separate function. `packages/host/src/first-run-modes.test.ts` fails if a fresh data dir's first desk has any other mode, through the real router and through Start over; `packages/db/src/first-desk-modes.test.ts` fails if a second place starts writing desk rows. Changing the list is an owner decision made in that test's literal, in the same commit. It never rewrites an existing desk.
- Modalities are fail-closed: wrong content type on `/runs/text|image|video` is **400**, never silently dropped. `text` is always on; image/video are optional per agent and per model.
- Never commit `.env`, API keys, or passwords.
- Do not commit or push unless Rizky asks.
- **Never `git add -A` or `git add .` in the webdev worktree `C:\Users\rizky\agentforge-webdev-0f994f5`.** It holds uncommitted work from several lanes at once plus untracked binaries such as `apps/web/public/brand/logo.png`. Stage files explicitly by path. See [`docs/internal/security-register.md`](docs/internal/security-register.md), SR-17.
- Login is the portal flow in `docs/internal/portal/`: browser one-time code and device code. No password, no Better Auth, and no account stack inside the product app. The client makes no entitlement decision: the host enforces, the renderer displays.
- **The HTTP server is the product.** Local webdev binds `127.0.0.1:3000`; the hosted app is the same Express host behind a reverse proxy. The loopback-only Origin allowlist in `packages/host/src/local-request.ts:75-84` (`isAllowedMutatingApiRequest`, wired at `packages/host/src/http-adapter.ts:188`) must become a trusted-origin allowlist **plus CSRF protection** before the web app is exposed — open decision 3. Until that lands the host still binds loopback and sits behind the proxy. Personal desktop: packaged Electron has **no HTTP server** — the renderer talks to the host over IPC (`window.agentforge`). Outbound HTTPS from the host to the gateway and the portal is the only network traffic that carries anything of a tenant's. One exception, and it carries nothing: the component installer fetches pinned, sha512-verified packages from `registry.npmjs.org` (see **Components**); plus the keyless public market and search sources a mode calls by design. Since 2026-09-20 there is a second destination that *does* carry a desk's content, by the owner's own act: **`api.telegram.org`**, for the Channels page (`docs/internal/telegram-channels-plan.md`). It is pinned in code like the gateway, HTTPS only, never followed through a redirect, and **pull-only** — inbound messages are fetched with `getUpdates`, never pushed to a webhook, so it opens no inbound route.
- Every row belongs to a tenant; the host enforces tenancy, the renderer displays.
- Every user-facing string exists in both `en` and `id` catalogs, and every job harness applies the output-language rule (see **Locale**).

## Layout

```
apps/web                 Vite + React Router renderer; Express is the product server (webdev on :3000, hosted behind a proxy)
apps/web/locales         en/ and id/ catalogs, one JSON per namespace (see Locale)
apps/portal              Portal stand-in (Postgres, Mailpit). The product reaches it over HTTP only; it never imports the host or the product database.
apps/desktop             Electron shell + Windows installer (the Personal product, 0.15.0; packaged: IPC host, no loopback HTTP)
apps/desktop/branding    Per-brand brand.json (agentforge, kemenkeu, metranet); tenantSlug lands here for login
apps/desktop/platform    Per-OS shell rules: README.md matrix + windows/ + macos/ (read before touching menus, quit, keychain, paths, installer, updater)
apps/mobile              Mobile client home (Expo, Android first, iOS after). Rules only until Phase 0 scaffold; see apps/mobile/AGENTS.md
packages/host            Local API dispatch (webdev HTTP adapter + Electron IPC); job harnesses; locale boot; file-extract/ (local document reading); renderers/ (xlsx, pptx, docx export)
packages/host/eval       Dev-only eval harnesses (finance); loopback against webdev, never bundled
packages/core            Content parsers, tools, AgentRuntime, AgentService, secrets, gateway gate types, locale primitives; channels/ (channel records + the pinned Telegram origin)
packages/host/src/channels  Telegram Bot API client + the per-desk channel store (account-rail Channels page)
packages/db              Drizzle schema (SQLite in the user data dir); localDataDir()
packages/university      Optional Students templates and mock campus tools
packages/marketing       Optional Marketing templates
packages/legal           Optional Legal templates
docs/                    Product docs + docs/internal engineering notes (index: docs/internal/README.md); docs/internal/maps = one how-it-works page per subsystem
```

**Shell vs app (locked).** UI lives in `apps/web`, and `apps/web` is the renderer for **both** products — the packaged desktop app compiles it into the installer (`apps/desktop/package.json`, `stage-renderer.mjs`). Since 2026-09-23 the desktop app is **under active development again** (released `0.15.0`); before that it was frozen at 0.14.27 for maintenance only. Do not import `electron` from the renderer. The only file that may read `window.agentforge` is `apps/web/lib/desktop-bridge.ts`; everything else goes through `@/lib/api-client`. Lint/format is **Biome** (`pnpm lint`) — do not add ESLint or Prettier. Agents use `pnpm dev` for features. Packaged Windows: `pnpm desktop:build` + WinApp F5. Packaged Mac: on a Mac, `pnpm desktop:build:mac` / `desktop:build:mac:dir` then F5 the `.app` or `pnpm desktop:mac`. This Windows checkout cannot run Apple’s Simulator or a `.app`. **Platform rules (2026-09-07):** every OS-specific shell behavior is owned by a folder with its own `AGENTS.md`: [`apps/desktop/platform/windows`](apps/desktop/platform/windows/AGENTS.md), [`apps/desktop/platform/macos`](apps/desktop/platform/macos/AGENTS.md), and [`apps/mobile`](apps/mobile/AGENTS.md). A change to `main.cjs`, menus, quit, keychain, paths, installer, or updater is checked against each affected folder before it ships. Mobile lives in-repo under `apps/mobile` (supersedes the earlier sibling-repo note); Expo / iOS Simulator work starts there, not in `apps/desktop`.

**`nultron-files/` (Rizky, 2026-10-01)** holds every Nultron working file that is not code: marketing videos, the Lumina kit, brand art, IP (KI) filings and deploy decks. It is gitignored and cursorignored, so never `git add` it. New Nultron documents go there, not to Desktop or Downloads. Its `README.md` is the index.

pnpm 9.15.9 + Turborepo. If corepack hits EPERM on Windows, use `npx pnpm@9.15.9`.

## Locale (en / id)

Bahasa Indonesia landed across every mode in PRs #37–#49 (2026-09-14/15). The rules that keep it whole:

- **Primitives:** [`packages/core/src/locale.ts`](packages/core/src/locale.ts) — `APP_LOCALES = ["en", "id"]`, `DEFAULT_APP_LOCALE = "en"`, `parseAppLocale()`. An unknown or missing value becomes English; a typo is never treated as Indonesian.
- **Storage and boot:** the owner settings file carries one machine-wide `locale` (not per desk). [`packages/host/src/locale-boot.ts`](packages/host/src/locale-boot.ts) freezes it on the first read of the host process; Settings’ language select saves via `POST /api/v1/settings`, and the “Restart” banner applies it via `POST /api/v1/settings/apply-locale`. There is no product env override; `AGENTFORGE_LOCALE` is not read on the boot path.
- **Renderer:** [`apps/web/lib/i18n.ts`](apps/web/lib/i18n.ts) — `t("namespace.path.key", vars)`, `freezeLocale`, `applyLocale`, `getLocale`. Catalogs are `apps/web/locales/{en,id}/<namespace>.json`, one namespace per surface (common, rail, settings, onboarding, guide, chat, documents, research, images, videos, presentation, knowledge, workspaces, usage, market, data, finance, legal, edit). A missing `id` key falls back to `en`; a missing key returns the raw key.
- **Rule for new UI copy:** add the key to **both** `en` and `id` JSON in the same change. Each namespace has a parity test in `apps/web/lib/*locale*.test.ts` that asserts identical sorted leaf keys — keep it green, and add one for a new namespace. No English literals in product JSX.
- **Rule for job harnesses:** read `localeForRun()` from [`packages/host/src/run-context.ts`](packages/host/src/run-context.ts) and apply `withOutputLanguage(prompt, surface, locale)` from [`packages/core/src/output-language.ts`](packages/core/src/output-language.ts) (surfaces: documents, research, finance, data, videos, edit, knowledge, meeting) or the mode-specific helper (`agents/chat-locale.ts`, `legal/locale.ts`, host `presentation-locale.ts`, host `image-output-locale.ts`, market `briefing-prompt.ts`). A new mode adds its surface there before it ships. A harness that writes English when the owner chose `id` is a bug, not a default.
- **Host copy stays host-side.** Model instructions and stub replies live in TS beside the mode (comments point at the JSON they mirror); the host never imports the renderer catalogs.
- **Portal copy:** the portal returns `message_en` / `message_id`; the client prefers its own catalog copy for known reason codes and shows the portal text verbatim only for unknown ones.

## How to run

```
npx pnpm@9.15.9 install
npx pnpm@9.15.9 db:seed          # optional; first visit also creates the local owner
npx pnpm@9.15.9 dev               # http://127.0.0.1:3000 → /chat, no login
```

Root `pnpm dev` also starts `apps/portal`, which exits without `PORTAL_DATABASE_URL` (Postgres) and takes the whole turbo run down with it. For webdev alone, run `npx pnpm@9.15.9 --filter @agentforge/web dev`.

**Webdev check before any drive (Rizky, 2026-09-17).** `http://127.0.0.1:3000` is Rizky's **isolated** webdev: throwaway data, no real key, kept up for agents. Every agent that verifies UI or host behaviour drives that instance — including locale switches, seeded threads, desks, datasets, matters — and cleans up what it created. Check first: `GET http://127.0.0.1:3000/api/v1/workspaces` returning 200 means it is on. Do **not** start a second instance on another port while :3000 answers; Rizky has had to repeat this. Remember `tsx server.ts` has no watcher: after host or core edits the :3000 process must be restarted (agents cannot kill node processes here, so say “restart :3000” in the report and Rizky restarts it); Vite hot-reloads only the renderer. Doctor it before driving (`scripts/doctor.mjs`).

**Where :3000 comes from (2026-09-23).** It is served from **this checkout**, `C:\Users\rizky\agentforge\apps\web` (`tsx server.ts`, data dir `.webdev-data-design`, `.env` with `AGENTFORGE_RUNTIME=ai` and a real key), so it follows whatever branch the main checkout has out — on 2026-09-23 that was `design/warm-desk-0.15`. Check with the listening pid's command line before assuming otherwise. The worktree `C:\Users\rizky\agentforge-webdev-0f994f5` (PR #97's review desk) is idle and no longer serves anything. Renderer edits hot-reload; host and core edits need the process restarted, and only Rizky restarts it — a host fix is "not driven" until then, say so in the report. Stage by path everywhere — the `git add -A` rule in **Non-negotiables** still holds.

Optional: `npx pnpm@9.15.9 db:push` (`drizzle-kit push` escape hatch). Canonical path is `drizzle-kit generate` in `packages/db` + app-side migrate (`ensureSchema`) on SQLite open.

SQLite file: `data/agentforge.sqlite` (or `AGENTFORGE_DATA_DIR`). **SQLite until the tenancy design says otherwise** — do not set `DATABASE_URL` to Postgres on a hunch; Postgres for tenancy is open decision 1 in the pivot record. That rule is about the **product** database and still holds. The Postgres in `docs/internal/portal/migrations/` is the portal’s own control plane, and since Phase 9 `apps/portal` runs it locally under `PORTAL_DATABASE_URL`. It is never a product dependency, and `DATABASE_URL` is never its variable.

**Desktop (the Personal product; current cut 0.16.0):**

- **Webdev window:** `pnpm desktop:dev` — Electron around local Vite/Express on `:3000` (no preload / no IPC). Not the installed product.
- **Packaged app:** `pnpm desktop:build` → NSIS x64 (Windows product path). Stages the Vite renderer + esbuild `host.cjs` (no bundled `node.exe`, no loopback port). Native modules (`better-sqlite3`, `keytar`) need `@electron/rebuild` **on Windows** — do not run that on Cloud. On launch the main process loads the renderer from `extraResources` and dispatches APIs over IPC. Writes `host-status.json` under Electron userData. Window close exits the whole process tree. Running setup.exe again replaces the existing install and keeps `%APPDATA%\Nultron`. Uninstall (not upgrade) kills `Nultron.exe`, deletes `%APPDATA%\Nultron`, and removes Credential Manager `Nultron` / `wrap-key`, plus the pre-rename `%APPDATA%\DPSBuddy` and `DPSBuddy` / `wrap-key`. mac/linux: `pnpm desktop:build:mac` / `pnpm desktop:build:linux` on that OS (unsigned; notarization is not done); `pnpm desktop:build:mac:docker --arch all` builds the static mac bundle from this Windows desk. Cloud cannot prove packaged Windows and must not run `pnpm desktop:build`. Move log: [`docs/internal/moves.md`](docs/internal/moves.md).
- **Ship list for 0.16.0 (the Personal app, cut 2026-10-06):** see [`docs/internal/0.16.0-changelog.md`](docs/internal/0.16.0-changelog.md) and [`docs/public/0.16.0-notes.md`](docs/public/0.16.0-notes.md). The first installer under the Nultron name, with no data migration from DPSBuddy. It carries the first-run desk and guide, the 3D mascot and desk buddy, the model policy table, the mode harness and agent tools (desk files, the Personal folder with an approval per write, `knowledge_search`, `run_code` on by default on Personal), the per-mode checks from PRs #119 to #133, and stepped motion in the packaged app. The DPSBuddy → Nultron upgrade on Windows and SR-112's injected-file drive are owed before it is published. macOS stays preview until a Mac opens the dmg.
- **Ship list for 0.15.1 (the Personal app, cut 2026-09-28):** see [`docs/internal/0.15.1-changelog.md`](docs/internal/0.15.1-changelog.md) and [`docs/public/0.15.1-notes.md`](docs/public/0.15.1-notes.md). In-app update checks retry a dropped GitHub connection, and the feed repo is `Nultron`. The installer also carries Education, the simpler Presentation and Open Slide stage, the Finance guided path, the Chat figure and cards, the three-step welcome, keyless Research search, and the desk scroll lanes. macOS stays preview until a Mac opens the dmg.
- **Ship list for 0.15.0 (the Personal app, cut 2026-09-23):** see [`docs/internal/0.15.0-changelog.md`](docs/internal/0.15.0-changelog.md) and [`docs/public/0.15.0-notes.md`](docs/public/0.15.0-notes.md) — a light-first warm desk with a blue float and 4px corners, DM Sans + Source Serif 4 bundled locally, every mode cut to title + one outcome line with optional controls behind disclosures, the Chat empty state rebuilt as intent cards, tool calls folded into the Thinking disclosure, and a batch of bugs the pass exposed (dark-on-dark rail footer, Market/Finance names squeezed out, three invisible prompt boxes, "Offline demo" claiming a connection that did not exist). **Nothing is packed** — the changelog's "What is NOT proven at this cut" says exactly what is owed, and its pack block is still a skeleton. **The enterprise Phase 9 plans/pricing/portal work in the same working tree is deliberately not in this cut** — it belongs to its own pull request. See the Personal / Enterprise table at the top of this file.
- **Ship list for 0.14.27 (published 2026-09-18):** see [`docs/internal/0.14.27-changelog.md`](docs/internal/0.14.27-changelog.md) and [`docs/public/0.14.27-notes.md`](docs/public/0.14.27-notes.md) — Finance task modes with deterministic figures and file import/export, local file extraction through anydoc with no hosted OCR, the first-run component installer, PII's eight kinds including Indonesian identifiers, job model fallback, the Market Watch specialists and analyst team, rail recent sessions and submenus, the Knowledge hygiene and health work, the hidden gateway endpoint, and the five findings fixes. All of it landed as PR #52 (`e8a7118`) plus the bump `e2e477e`. What is proven and what is not is in that changelog's "What is NOT proven at the 0.14.27 cut".
- **Ship list for 0.14.26 (published 2026-09-15):** see [`docs/internal/0.14.26-changelog.md`](docs/internal/0.14.26-changelog.md) and [`docs/public/0.14.26-notes.md`](docs/public/0.14.26-notes.md) — host gateway gate + Start over, the Bahasa Indonesia sweep across every mode, the Finance fixes, the Images/Videos cost estimate, and the security passes; Rizky overrode the harness-first order above for this cut, so 0.14.26 was cut before the harness pass landed.
- **Ship list for 0.14.25 (published 2026-09-12):** Market Watch, workspace desk management, and builtin Knowledge Phases 0–4, listed in [`docs/internal/0.14.25-changelog.md`](docs/internal/0.14.25-changelog.md); public notes in [`docs/public/0.14.25-notes.md`](docs/public/0.14.25-notes.md). Windows + mac preview (7 assets) on `Kyoo032/DPSBuddy`. Previous: [`docs/public/0.14.24-notes.md`](docs/public/0.14.24-notes.md) (published 2026-09-09, Windows-only); what is on `main` but not in the public installers is tracked in [`docs/internal/unreleased.md`](docs/internal/unreleased.md). Shipped: [`docs/internal/0.14.22-changelog.md`](docs/internal/0.14.22-changelog.md) (Research dossier / Data / Finance, macOS preview; plan in [`docs/internal/research-dossier-analyst-modes-plan.md`](docs/internal/research-dossier-analyst-modes-plan.md)), [`docs/internal/0.14.21-changelog.md`](docs/internal/0.14.21-changelog.md). Earlier: [`docs/internal/0.14.1-changelog.md`](docs/internal/0.14.1-changelog.md) is the reference of everything that must be inside the 0.14.1 `setup.exe`. Development and quick testing happen on **webdev** (`pnpm dev`, `:3000`), so a feature that works there is *not shipped* until it is staged into `host.cjs` + the renderer, packed, and driven on the installed app (`doctor --desktop`). Every agent that changes product code after 0.14.0 appends to the current changelog (`docs/internal/0.14.27-changelog.md` for this cut; `unreleased.md` for anything that lands after it, until the next changelog exists); the pack step reads it back as the checklist.

### Web release (hosted)

- **What runs is an image.** `webapp-deploy/Dockerfile` builds the renderer (`vite build` → `apps/web/dist`) and runs `tsx server.ts` behind the reverse proxy on Rizky's server. Secrets come from the environment, starting with `AGENTFORGE_SECRETS_KEY`, and never from a file in the repo or the image.
- **Nothing counts as shipped until it is deployed to the hosted environment and driven there.** A green webdev, a green `tsc` or a passing test is not a deploy.
- **A web release is a deploy bundle, cut by one script.** `node scripts/release-web.mjs --tag <tag> --sha <sha>` (`--dry-run` first) does, in order: preflight (clean tree unless `--allow-dirty`, sha resolves, `docs/public/<tag>-notes.md` exists and is free of banned marks); `git archive <sha>` into a temp dir and `docker build` + `docker push` of `ghcr.io/kyoo032/nultron-ent:<tag>` from there (`--skip-image` skips only this step); a temp clone of `Kyoo032/NultronEnt` gets `compose.yml` pinned to that tag, `.env.example` (the names the hosted app refuses to boot without), `DEPLOY.md` and `Caddyfile`, committed as `Release <tag>` and pushed to `main`; then `gh release create` and `gh release view`. The temp dir is deleted on every exit. The deploy that goes with it is logged by sha, with the tag beside it, in the deploy log in [`docs/internal/web-pivot-2026-09-18.md`](docs/internal/web-pivot-2026-09-18.md). The script constant `RELEASE_REPO` is `Kyoo032/NultronEnt` since 2026-09-29 (it was `Kyoo032/DPSBuddy-Ent`, which GitHub still redirects).
- **The image is private and builds only from a sha.** Today the image carries the whole TypeScript source tree, because the runtime stage copies the build tree wholesale. A build from a working checkout would also pick up untracked local state such as a webdev data dir or `apps/web/.env.local`. The script builds only from `git archive <sha>`, and the ghcr package stays private until the Dockerfile ships compiled output only ([`security-register.md`](docs/internal/security-register.md), SR-49).
- **Web deploys carry no semver.** The release and image tag is `ent-YYYY.MM.DD` (`ent-YYYY.MM.DD.2` for a second release the same day), and the release body always ends with `Source: agentforge@<sha>`, `Image: ghcr.io/kyoo032/nultron-ent:<tag>` and `Portal image: ghcr.io/kyoo032/nultron-portal:<tag>`, all appended by the script. Since 2026-10-01 the release builds and pushes both images from the same sha and the bundle's compose runs the app, Caddy (pinned `caddy:2.11-alpine`), the portal, its Postgres and a one-shot prepare step, with the portal's secrets in a separate `portal.env` the app never loads. Restart `app` and `proxy` together, never `app` alone (the proxy shares its network namespace). Rizky has not confirmed the tag scheme; ent-CalVer is the working default.
- **The Dockerfile and the source stack live in [`webapp-deploy/`](webapp-deploy/README.md).** `webapp-deploy/Dockerfile` builds from the repo root, and `webapp-deploy/compose.yml` is the stack that builds from source. The released `compose.yml` on NultronEnt is generated from the same hardening and pins the pulled image instead. `webapp-deploy/scripts/deploy.sh` still builds on the server from a checkout; moving the Jakarta box to the released bundle is not done yet. Which server, TLS, and backups of the data dir stay in the pivot record. Do not invent a third deploy path in passing. **Kubernetes is the one sanctioned addition (Rizky, 2026-10-01):** manifests live in `webapp-deploy/k8s/` (base, `overlays/local` for a Docker Desktop rehearsal on localhost, `overlays/production` for Tencent TKE, not applied). They run exactly one app pod and one portal pod (`strategy: Recreate`), because the host is single-process (SQLite, SR-66, SR-29). A local rehearsal image is built from a git-ls-files snapshot and is never pushed. Phase 0 (10 testers) still ships on one Lighthouse box with compose; TKE is Phase 1.

### Three repos: work in agentforge, release to Nultron (Personal) and NultronEnt (Enterprise)

Rizky decided on 2026-09-23: one private source repo, one public release repo per product. The record is the "Three repos" entry in [`docs/internal/web-pivot-2026-09-18.md`](docs/internal/web-pivot-2026-09-18.md).

- **`Kyoo032/agentforge` (private, this repo)** is the only source repo for both products: all code, docs, branches, webdev, packing, and the full verify pass. Nothing is released until it is proven here. For a Personal cut that means staged into `host.cjs` + renderer, packed, installed, and driven on the packaged app (`doctor --desktop`). For an Enterprise release it means deployed to the hosted environment, driven there, and logged by sha.
- **`Kyoo032/Nultron` (public; renamed from `Kyoo032/DPSBuddy` on 2026-09-25)** is Personal releases only: README + `Nultron Setup <v>.exe` + `.blockmap` + `latest.yml` + the mac dmg/zip, published with `pnpm desktop:release`. From 0.15.1 the packaged app's updater requests `Kyoo032/Nultron` (`brand.json` `updates.repo`). Installs from 0.15.0 and earlier still request `Kyoo032/DPSBuddy`, and GitHub redirects that name. Release notes come from `docs/public/<version>-notes.md`. Nothing about the hosted web app is published there. The README was set to the Nultron text in `620689f`, outside a release.
- **`Kyoo032/NultronEnt` (public; created 2026-09-23 as `Kyoo032/DPSBuddy-Ent`, renamed 2026-09-25, default branch `main`)** is the Enterprise deploy-bundle and release repo, in the same relationship to agentforge as `Kyoo032/Nultron` has to the installers. `main` holds the README, the LICENSE and the current bundle: `compose.yml` pinned to `ghcr.io/kyoo032/nultron-ent:<tag>`, `.env.example`, `DEPLOY.md` and `Caddyfile`. Each release is a `Release <tag>` commit plus a GitHub Release whose body is `docs/public/ent-YYYY.MM.DD-notes.md` followed by the `Source:` and `Image:` lines. Everything is written by `node scripts/release-web.mjs` (see **Web release (hosted)**). It never holds TypeScript source, and nothing about the desktop app is published there. The README was set to the Nultron Enterprise text in `54da47a`, outside a release.
- **The only local checkout is `agentforge`.** `Kyoo032/Nultron` and `Kyoo032/NultronEnt` are written only by their release scripts (`pnpm desktop:release`, `node scripts/release-web.mjs`). Keep no clone of either on disk. `release-web.mjs` clones NultronEnt into a temp dir under `%TEMP%` and deletes it before it exits. The 2026-09-25 README updates were a one-off through the GitHub contents API, not a clone and not a release.
- **Rules for both public repos.** Never source, never flavor builds, never `docs/internal/` notes, never any AI/agent marks. Notes come only from `docs/public/`. Commits and releases are authored as Rizky, with plain messages and no trailers. Published by the script, never by hand, and never with a `git push` from agentforge. Both release scripts — `scripts/release-web.mjs` and `apps/desktop/scripts/release-desktop.mjs` — refuse a notes file that names `Claude`, `Anthropic`, `agent`, `Co-Authored` or `docs/internal`, from one shared list in `scripts/release-marks.mjs`. `release-desktop.mjs`, which takes `--notes <file>`, also refuses a notes path under `docs/internal` in any letter case or through a link; `release-web.mjs` only ever reads `docs/public/<tag>-notes.md`, and also runs the mark check on every file it would push and on the release body, and there the only exception is the source repo's own name `agentforge`, which the app's `AGENTFORGE_*` variables and the `Source:` line cannot avoid.
- Order is fixed: work → verify inside agentforge → only when everything on the ship list is proven, cut the release into that product's repo. A release to one repo never implies a release to the other.
- **Pack/ship on this Windows desk:** [`.cursor/skills/pack-nultron`](.cursor/skills/pack-nultron/SKILL.md) (isolated NSIS worktree + Docker mac dmg). Cloud must not run it.
- **Versioning (Rizky, 2026-09-07; re-scoped 2026-09-23):** two products, two schemes. **Personal (the desktop app)** uses semver — `0.16.0` is the current cut (Rizky asked for v0.16 on 2026-10-06; it is the first installer under the Nultron name), and the next maintenance cut would be `0.16.1`. Do not use `0.14.3+`. The old "never bump to 0.15 until Rizky says so" rule is spent: he said so on 2026-09-23. The `0.14.21`…`0.14.27` line was scoped to desktop *maintenance* cuts while the desktop was frozen; 0.15.0 is a product release and takes the next minor. Semver still orders these correctly for the updater. Current tree: `apps/desktop/package.json` is `0.16.0`. **Enterprise (the hosted web app)** is tracked by commit sha, not by this scheme; its release tag on NultronEnt, which is also the image tag on ghcr, is `ent-YYYY.MM.DD` (working default, not yet confirmed by Rizky — see **Web release (hosted)**).

**Packaged Windows installer exists.** Cloud Linux must not run `pnpm desktop:build`.

- Artifacts: `apps/desktop/dist/Nultron Setup <v>.exe` + mac arm64/x64 `Nultron-<v>-mac-<arch>.dmg|zip` (gitignored). 0.16.0 is the first Nultron-named pack (2026-10-06, see its changelog's pack block). The 0.15.1 files in the main checkout's `dist/` are named `DPSBuddy Setup 0.15.1.exe` and `DPSBuddy-0.15.1-mac-<arch>.*`; archive them into `published-0.15.1/` before a release runs from that `dist/`. Anything older in `dist/` (`published-*`, `superseded-*`) is history, not current.
- Packaged proof is an Electron window + `doctor.mjs --desktop` (in `.cursor/skills/verify-agentforge/scripts/`) reading `host-status.json` (`transport: "ipc"`). There is no `app-url.txt` and no child `node.exe`.

Webdev has no account: workspaces belong to the local owner and the gateway key is pasted in Settings. On the hosted app the portal session is the account and workspaces belong to the tenant (open decision 2 in the pivot record). `AGENTFORGE_RUNTIME=stub` until a key is saved (then live models from the gateway). Env `AGENTFORGE_RUNTIME=ai` still uses `.env` keys.

## Runtime and tools

- `createRuntime()` selects stub vs Vercel AI SDK. Live chat uses the gateway base URL unless the owner pasted a different one. Provider keys come from `resolveProviderKeys` and nowhere else; the session access token joins that function in Phase 1.
- Tools: `defineTool` + registry + bindings. Platform: `calculator`, `datetime`, `web_search`, `image_generate`, `video_generate`. Packs add more.
- Gateway key runs chat **and** image/video generation (`POST /v1/images/generations`, `POST /v1/video/generations` + poll). Search still needs Tavily/Brave. FAL is optional BYOK.
- New industry = new pack package, not kernel tables.

## Secrets and prompt security

The user pastes their gateway key into settings. The host process holds it. Runs use it. The UI never gets the raw key back after save (`hasOpenai` only). Optional extras: native Google / Anthropic / Ark, plus dedicated tool keys (Tavily/Brave/FAL) in Settings Extras.

Do not use Hermes tools or Hermes dashboard tokens to process Nultron keys.

- **Gateway key** → `settings.enc` (AES-256-GCM), per workspace.
- **Portal session (Phase 1)** → `session.enc` next to it, machine-scoped, encrypted under a key derived from the same wrap key (`HKDF(wrapKey, "session-v1")`). Refresh token on disk only there; access token in host memory only.
- **Wrap key** → `AGENTFORGE_SECRETS_KEY` from the environment / a secret manager on the server: [`packages/db/src/vault-key.ts:37-51`](packages/db/src/vault-key.ts) reads the env first and only falls back to `data/.master-key` in the local data dir. That env path is the hosted product's; never a file in the repo. Electron keytar `Nultron` / `wrap-key` (injected as the same env var by `apps/desktop/main.cjs`) is the **desktop** path. Never in the renderer, never in git, never in `NEXT_PUBLIC_*`. Login adds no keychain slot.
- Remote inference and portal URLs must be HTTPS. `http://` is only for loopback (Ollama).
- Nultron does not log prompts. Message bodies, system prompts, and tool I/O are encrypted at rest. Gateway retention is Toko Token’s policy, not ours.
- OpenRouter’s `provider.zdr: true` is sent only when the saved URL is OpenRouter. Do not send that field to Toko Token.
- Wallet / usage / key-admin on the gateway stay parked until this privacy pass is solid; the portal’s wallet is server-side and the client only displays balances it is told.
- Never commit `.env`, `data/settings.enc`, `data/session.enc`, `data/.master-key`, or API keys. `.gitignore` enforces those four and `.webdev-data*/`; it did not until 2026-09-21, so check `git check-ignore -v <path>` before trusting it for a path not on that list.
- **Every security flag raised in a session is recorded in [`docs/internal/security-register.md`](docs/internal/security-register.md) in the same change**, with `file:line` evidence, a severity, a status and the gate it blocks (`blocks Tencent deploy`, `blocks PR merge`, `dev only`). A flag that turns out to be nothing is recorded as "checked, not an issue" with the evidence, so nobody chases it twice. That file also carries the must-be-true checklist for the Tencent Cloud deploy. The OWASP pass it builds on is [`docs/internal/security-owasp-2026-09.md`](docs/internal/security-owasp-2026-09.md); the hosted perimeter is [`docs/internal/maps/hosted-security-controls.md`](docs/internal/maps/hosted-security-controls.md).

## Tests

**Local CI (Rizky, 2026-09-24).** CI is local. There is no GitHub Actions workflow in this repo and none is coming back: every Actions run on this account has ended in `startup_failure` since the repo was created (billing lock, `docs/internal/0.14.22-changelog.md:118`), and Rizky decided not to rely on them at all. `.github/workflows/` (`ci.yml`, `e2e.yml`, `desktop-mac.yml`) is deleted.

- Run `npx pnpm@9.15.9 ci:local` (`node scripts/ci-local.mjs`) before any PR, merge or pack. It runs Biome lint, `tsc --noEmit` per workspace with a tsconfig, `vitest run` per package one at a time with a fresh `AGENTFORGE_DATA_DIR`, `node --test scripts/*.test.mjs`, the `apps/desktop` node tests, the deployed-closure audit gate (`scripts/audit-deployed.mjs --level high`), and as advisory steps the workspace-wide `pnpm audit --audit-level moderate`, `maps:check`, `edit:starters:check` and `videos:examples:check`. `--install` adds the `--frozen-lockfile` check; `--e2e` adds Playwright (off by default, per the rule below). `--only <step|group>` and `--skip <step|group>` narrow it; `--help` lists the steps.
- Every step runs even after a failure. Exit 1 means a required step failed. Logs land in `.ci-local/<timestamp>/<step>.log` (gitignored), and `summary.md` beside them is the table to paste into the PR. A PR without that table has not been through CI.
- It only runs when someone runs it. Nothing checks a push on its own; that is the residual risk, recorded as SR-80 in [`docs/internal/security-register.md`](docs/internal/security-register.md).

- Unit: Vitest in `packages/core`, `packages/host`, `packages/db`, `packages/legal`, `packages/marketing`, `packages/university`, `apps/web` (`pnpm test` runs all through Turbo). `apps/desktop` has plain Node tests (`pnpm --filter @agentforge/desktop test`). Local coding agents run these. Run host tests with `AGENTFORGE_DATA_DIR` pointed at a temp dir so stub media rows do not land in the dev desk.
- Locale parity tests live in `apps/web/lib/*locale*.test.ts`; the gate contract test is `apps/web/lib/gateway-gate.test.ts`. Both must stay green on every UI change.
- Do **not** run Playwright locally — `foundation.spec.ts` is a long serial pass (Vite dev server + stub chat + workspaces).
- E2E: Playwright `apps/web/tests/e2e/foundation.spec.ts` (Chat → Settings → job modes → Legal workspace smoke). Owned by **Cursor Cloud Agents**, not the local Windows session. See **Cursor Cloud specific instructions** below.
- Verify UI in the IDE browser when changing layout. Do not block on `pnpm test:e2e` on this machine.
- **No known local reds (2026-09-24).** Every suite is green on this Windows desk, and a red is now a regression. The old reds were test-harness problems, fixed without touching product code: the SSRF tests mock `node:dns/promises` (a real lookup of `example.test` took 11 s to fail) and still assert the loopback / private / metadata refusals; `wrap-key-rotation-script.test.ts` and `scripts/components-cli.test.mjs` spawn `process.execPath` with tsx's JS entry (`createRequire(...).resolve("tsx/cli")`), never the `.bin` shim; suites that import `@agentforge/db` close `sql` before `rmSync(..., { maxRetries: 10, retryDelay: 100 })`, so no more `EPERM` in `afterAll`; router-importing setups share the 180 s budget in `packages/host/src/__fixtures__/test-budgets.ts`; and `packages/host/test/setup.ts` gives every test file a unique `mkdtemp` data dir (it used the pid, which Windows reuses, so files silently shared a database). Keep cleanup hooks, never raise the global vitest timeout, and never skip a test to get `ci:local` green.
- Feature verification recipes: [`.cursor/skills/verify-agentforge/features/`](.cursor/skills/verify-agentforge/features/README.md). `locale.md`, `gateway-gate.md`, `rail.md`, `login.md`, and `plans.md` exist. A feature without a recipe is not verified.

## Cursor Cloud specific instructions

Cloud clones GitHub. Push the branch first; uncommitted local files are not on the VM. Launch from the Cursor **Cloud** agent dropdown, or `/in-cloud` from a local chat.

Boot uses [`.cursor/environment.json`](.cursor/environment.json): `install` → `scripts/cloud-install.sh` (pnpm 9.15.9, Playwright Chromium). `start` → `scripts/cloud-start.sh` (prepares the data dir only; the host creates the schema on first open). Stub runtime only — no gateway key.

This image has **no Docker**. `docker`, `dockerd`, and `sudo service docker start` fail (`docker: unrecognized service`). Do not run `docker compose`. Product DB is SQLite. Default file: `data/agentforge.sqlite`.

The Windows closed-beta checkout also uses SQLite (`ensureSchema` migrates on open; `pnpm db:push` is optional). On the **Personal** desktop app, Electron injects the wrap key from the OS keychain and packaged uses IPC in-process — no loopback HTTP server. On the **Enterprise** hosted web app the wrap key is `AGENTFORGE_SECRETS_KEY` from the environment.

### What a Cloud Agent on this VM can do

- Node 22 + pnpm 9.15.9 (corepack). Workspace `node_modules` after `install`.
- SQLite via `ensureSchema` on open (not Docker Compose, not required Postgres). `pnpm db:push` is optional.
- Run the stub Playwright suite against `http://127.0.0.1:3000` (`pnpm test:e2e` from repo root also works). That is **webdev**, not the packaged app. Playwright `webServer` starts `pnpm dev` if needed. Do not use a LAN IP.

```
cd apps/web
AGENTFORGE_RUNTIME=stub npx playwright test
```

- Run Vitest unit tests (`pnpm test` / package `vitest run`).
- **Knowledge Base (builtin only).** Prove Phases 0–4 with [`.cursor/skills/verify-agentforge/features/knowledge-phases.md`](.cursor/skills/verify-agentforge/features/knowledge-phases.md). No WeKnora sidecar, no `AGENTFORGE_WEKNORA_BIN`, no `:3100`. Stub Chat injects chunks but cannot write `cites`; skip live cites on this VM.
- **Gate and login in stub mode.** The host gate reports `status: "stub", allowed: true`; the portal is unreachable, so login tests use a mocked portal (`msw` or an in-process fake) and never a real `api.tokotokenai.com` call.
- Browser / computer-use against the local **webdev** app when those tools are available. Bind is `127.0.0.1:3000`. Packaged desktop is not on this VM.
- Read GitHub with `gh` (PRs). Do not use `gh` to create PRs — use the Cursor PR tool.

### What a Cloud Agent on this VM cannot do

- Docker Postgres / `docker compose` (not installed).
- Live Toko Token / gateway inference or a live portal login. There is no gateway key. Keep `AGENTFORGE_RUNTIME=stub`. Do not paste keys into the VM or commit `.env`.
- Product password login, e-mail, or session. There is none.
- See the operator’s unpushed Windows working tree.
- Merge PRs or enable auto-merge unless Rizky asks.

There is no GitHub Actions CI any more (see **Local CI** under **Tests**). Cloud Agents still own the stub Playwright suite on this VM; locally it runs only through `pnpm ci:local --e2e`.

## Known traps

- Cursor’s browser can inject `data-cursor-ref` and block clicks. Use Chrome or Playwright.
- Playwright `/studio/**` redirects to Chat (Build is parked).
- Dev server binds `127.0.0.1:3000` (webdev only: Vite + Express + `@agentforge/host`). Playwright and the IDE browser must use `http://127.0.0.1:3000` (not a LAN IP). (desktop) Packaged Nultron has no HTTP port; `doctor.mjs --desktop` reads Electron userData `host-status.json` (Windows `%APPDATA%\Nultron`, Linux `$XDG_CONFIG_HOME/Nultron` or `~/.config/Nultron`, macOS `~/Library/Application Support/Nultron`). A phone on a LAN `:3000` is not a product surface — see [`docs/mobile.md`](docs/mobile.md).
- **Start over is destructive.** `settings-reset-all-submit` erases the desk it runs on and relaunches; `settings-reset-key-submit` forgets the key on every desk. Never press either on the operator’s shared Windows instance unless asked. Drive them on a throwaway `AGENTFORGE_DATA_DIR`.
- Host tests read the operator’s `data/` unless the test file sets its own `AGENTFORGE_DATA_DIR` (`enhance-prompt.test.ts` fails when the desk locale is `id`). Do not fix that with one shared temp dir for the whole run: parallel workers then race `ensureSchema` (`table agent_tool_bindings already exists`). Isolation is a per-file `mkdtempSync`.
- `pnpm -r test` stops at the first failing package and the db `drizzle-kit check` drift test is timing-sensitive under a full parallel run; re-run a package alone before calling it red.
- A literal control character in source (a raw NUL used as a split sentinel, for instance) makes git treat the file as binary and hides every later diff. Write the escape (`"\u0000"`), never the byte.
- `@firecrawl/anydoc` is a native module loaded through `createRequire`; esbuild leaves it as a runtime require, so it must exist as a real `node_modules` entry outside the asar in the packaged app. A green webdev says nothing about the installer here. Inside the esbuild CJS bundle `import.meta` is `{}`: `createRequire(import.meta.url)` throws there, so every runtime require in host code uses the guard `typeof require === "function" ? require : createRequire(import.meta.url)` (`file-extract/anydoc.ts`, `sql-runner.ts`).
- Unit tests with an injected probe are not proof for the component installer: the first live run failed `probe_failed` because the probe wanted the marker that is written after it. Prove installer changes with one real install into a temp `AGENTFORGE_DATA_DIR`.
- `docs/internal/unreleased.md` was started over at the **0.16.0** cut (2026-10-06) and is titled "after the 0.16.0 cut". Its whole log from after 0.15.0 (the 0.15.1 cut never started it over) is folded into [`docs/internal/0.16.0-changelog.md`](docs/internal/0.16.0-changelog.md), and the full old text is readable from git at `de95267`. Append only what lands *after* the 0.16.0 cut, and start the file over again when the next `<version>-changelog.md` is created rather than appending under a stale header.
