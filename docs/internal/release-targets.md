# Release targets

This file lists every product built from this repo, one card per target, covering:

- who it is for and what it ships;
- how it looks: name, logo, mascot, colours, type;
- what is running now, and what to work on next.

**Agents read this file before starting any task.** Name the target your task serves, then keep the change inside it. If the change lands on another target, stop and say so.

Last updated: 2026-11-06 (`Kyoo032/Nultron` `main` at `39cd5f0c`). The hex colours below were sampled from each brand's own logo file.

## At a glance

| Target | Type | Company | Product name | Gateway users see | Status | Focus now |
|---|---|---|---|---|---|---|
| [`nultron-personal`](#nultron-personal) | Desktop app | Public (retired) | Nultron | Toko Token | Retired 2026-10-14. Last release v0.15.1 (2026-09-28). 0.16.0 was packed on 2026-10-06 and never published. Repo `Kyoo032/Nultron-Desktop` archived | None. The app is merged into the web app; no new cut |
| [`nultron-enterprise`](#nultron-enterprise) | Hosted web app | Nultron Enterprise customers (via DPS) | Nultron | Toko Token + BYOK | Pilot, never released or deployed (checked 2026-11-06). A password-gated single-desk preview (one private desk per tester) runs at app.nultron-ai.xyz since 2026-10-06; its last logged image is `a8866263` (2026-10-19). On 2026-11-17 its Caddy still answered `401` with `WWW-Authenticate: Basic realm="restricted"`. The app image can serve a form instead (`PREVIEW_BASIC_USER` / `PREVIEW_BASIC_PASSWORD`) once that `basic_auth` block is removed from the out-of-repo site file. It is not an Enterprise deploy. Release repo is `Kyoo032/Nultron-Releases` (renamed from `Kyoo032/Nultron` on 2026-10-15) | The first release and Tencent deploy, when Rizky says go. It was planned for Thu 8 Oct 2026 and did not happen |
| [`kemenkeu-ai`](#kemenkeu-ai) | Desktop flavor | Kemenkeu (Ministry of Finance) | Kemenkeu AI | AIHub | Retired 2026-10-14 with the desktop app. Was built locally. Its brand folder is gitignored | None |
| [`aihub-metranet`](#aihub-metranet) | Desktop flavor | Metranet (Telkom Indonesia) | AIHub Metranet | AIHub | Retired 2026-10-14 with the desktop app. Was built locally. Its brand folder is gitignored | None |

## Which targets a change touches

| Path | Targets |
|---|---|
| `apps/web/**`, `packages/**` | Every target built from here. The renderer and host are shared. |
| Code behind `isServerMode()` / `isHostedBuild()` | `nultron-enterprise`. Personal must stay identical, proven by a parity test. |
| `apps/desktop/**` | `nultron-personal`, `kemenkeu-ai`, `aihub-metranet`, all retired. Nothing ships from it. |
| `apps/desktop/branding/<id>/**` | That one desktop target only |
| `apps/portal/**`, `webapp-deploy/**`, `scripts/release-web.mjs` | `nultron-enterprise` |
| `apps/mobile/**` | None. It holds rules only, and nothing ships from it. |

## Brand rules for every target

- **Gateway names stay distinct.** Toko Token and AIHub are two different gateways. Never merge or swap their names in copy, catalogs or prompts.
- **Nultron keeps Toko Token** as its gateway, in the UI and in the backend (Rizky, 2026-10-05).
- **Each client's art stays in its own build.** A client's logo, mascot or colours never appear in another target's installer, image or screenshots.
- **Never edit a client's logo.** Use the file exactly as received. To shrink a logo, crop it; never redraw it.
- **Copy follows `{productName}` and `{gatewayName}`.** A literal product or gateway name in UI copy is a bug on every other target.

---

## nultron-personal

<img src="../../apps/web/public/brand/logo.png" alt="Nultron app logo" width="96">

**Retired (Rizky, 2026-10-14).** Nultron Personal is being merged into the web app. Its release repo `Kyoo032/Nultron-Desktop` is archived and gets no new releases. Do not pack or publish a desktop cut. The code and the identity below stay in the tree until the merge.

**Identity**

| Element | Value | Files |
|---|---|---|
| Name | Nultron | `DEFAULT_BRAND` in `apps/desktop/brand-read.cjs` (`productName`) |
| Logo | Nultron's painted head on a blue tile | master `docs/internal/brand/nultron/reference/app-logo.webp`; `logo.png` (256 px, under 200 KB); `icon.ico`, `icon.icns` in `apps/desktop/build`; favicons in `apps/web/public/brand/`; rail marks `apps/web/components/brand-art/mark-{24,32,48,64}.png` |
| Mascot | Nultron, a 3D robot with a glowing antenna, in 21 states | renders in `apps/web/components/nultron/images/` (`full`, `head`, `clips`, `loops`, `manifest.json`); state table `apps/web/lib/mascot-states.ts`; render scene `tools/nultron-3d` |
| Wordmark | Gradient blue → cyan, rail only (`.wordmark-nultron`) | `apps/web/app/globals.css:2259`, `apps/web/lib/product-brand.tsx` |
| Type | DM Sans (UI) and Source Serif 4 (display), bundled locally | `apps/web/app/globals.css:1-30` |
| Look | Light-first warm desk, blue float, 4 px corners | 0.15.0 design pass |

| Colour | Hex | Role |
|---|---|---|
| Accent (light) | `#0E58F0` | buttons, links, focus |
| Accent (dark) | `#6EA4FF` | the same roles on dark |
| Nultron blue | `#1277C8` | wordmark start, brand art |
| Nultron cyan | `#19BDDC` | wordmark end |
| Cream | `#E4D9CD` | mascot face, warm accents |
| Ink | `#131617` | brand dark |

**Release**

- **Type:** Electron desktop app. It talks to the host over IPC, opens no HTTP port, and keeps SQLite in the user's data dir.
- **Company:** public. Users bring their own Toko Token key.
- **Codebase:** this repo, `main`.
- **Gateway:** Toko Token, pinned to `https://api.tokotokenai.com/v1`.
- **Services:**
  - Windows NSIS installer.
  - macOS dmg/zip, still a preview: nobody has smoke-tested it on a Mac yet.
  - In-app updater: this tree's `brand.json` names `Kyoo032/Nultron-Desktop` (archived). Installed 0.15.1 copies still read `Kyoo032/Nultron`, which has been the private source repo since 2026-10-15. The 0.15.1 build's `publish` block names provider, owner, repo and release type, with no `private` flag and no token (`apps/desktop/package.json:157-162` at `43c1de3`, the 0.15.1 pack commit), so the updater asks without auth. A private repo answers an unauthenticated request with `404` (measured 2026-11-06 on the repo and its `releases/latest`), so the check fails with the app's "Update feed not found (404)" message (`apps/desktop/auto-update.cjs:12`).
- **Ships by:** nothing now. The [pack skill](../../.cursor/skills/pack-nultron/SKILL.md) and `pnpm desktop:release` are retired with the repo.
- **Versions:** semver. Published `v0.15.1` (2026-09-28), the last release. `0.16.0` was packed on 2026-10-06 (branch `chore/release-0.16.0`, [`0.16.0-changelog.md`](0.16.0-changelog.md)) and was never published. It will not be published.
- **Focus now:** none. Do not drive the packed app or cut a release for it.
- **Logs:**
  - Pack table in the current changelog's `## Pack + publish`; published rows in [`unreleased.md`](unreleased.md).
  - Changelogs: `0.15.x-changelog.md`, `0.16.0-changelog.md`.
  - Public notes: `docs/public/<v>-notes.md`.

## nultron-enterprise

**Identity:** same as [`nultron-personal`](#nultron-personal): name, logo, mascot, colours and type. Differences:

- The portal sign-in pages carry the Nultron logo (`apps/portal/assets/logo.png`) and the product name from portal locale `product`.
- The sender is `DEFAULT_SMTP_FROM` (`apps/portal/src/config.ts:100`).

**Release**

- **Type:** hosted multi-tenant web app: the Express host plus the built renderer, behind Caddy.
- **Company:** Nultron Enterprise customers, priced per user and contacted through DPS. Phase 0 pilot: 10 testers.
- **Codebase:** this repo, `main`.
- **Gateway:** Toko Token (pinned). Server mode adds BYOK keys for Toko Token, OpenAI, Anthropic, Google and OpenRouter, set per company or per person.
- **Services** (one compose stack, `webapp-deploy/compose.yml`):

  | Service | What it is |
  |---|---|
  | `app` | `ghcr.io/kyoo032/nultron-ent`, production dependencies only |
  | `proxy` | Caddy 2.11, TLS and `sign_in_filters`. Restart it together with `app`. |
  | `portal` | `ghcr.io/kyoo032/nultron-portal`, the sign-in. This bundle uses a username and password (`PORTAL_SIGNIN_MODE=password`). The e-mailed one-time code is the portal's own default. |
  | `portal-db` | Postgres 16 |
  | `portal-prepare` | one-shot migrations |

- **Live on the box (2026-10-06):** dpscloud.co.id, tokotokenai.com and nultron-ai.xyz are live static sites. app.nultron-ai.xyz is the preview: off server mode, still Caddy Basic Auth as of 2026-11-17, 11 private desks (security register SR-133). The form gate in `apps/web/server/preview-gate.ts` replaces that dialog once `basic_auth` is removed from the out-of-repo site file and `PREVIEW_BASIC_USER` / `PREVIEW_BASIC_PASSWORD` are set. Company mailboxes moved to Lark; SES stays for sign-in codes and invites, which the portal sends only under `PORTAL_SIGNIN_MODE=code`. Runbook: `nultron-files/deploy/tencent/README.md`.
- **Where it runs (updated 2026-10-05):** Phase 0 is one Tencent Lighthouse box in Jakarta that will also host dpscloud.co.id (the parent site) and tokotokenai.com. Nultron goes on **nultron-ai.xyz**, with sign-in on **portal.nultron-ai.xyz**. **Never point api.tokotokenai.com at it.** Email is Tencent SES only, for sign-in codes and invites: "Nultron <no-reply@mail.dpscloud.co.id>", no mailboxes. Both go through the portal's one mailer (`apps/portal/src/main.ts:28`), which sends only under `PORTAL_SIGNIN_MODE=code`. Under the bundle's `password` default the mailer refuses every message (`apps/portal/src/mail/index.ts:18`, `apps/portal/src/config.ts:291-294`), so the portal would send nothing through SES. After a 1-month test, move to a bigger Tencent CVM by sharing a Lighthouse custom image to CVM (same region), restoring the newer data, and switching DNS. Multi-site build: branch `feat/multi-site-edge`. Guide: `nultron-files/deploy/hosting-guide.html`. Before that, Phase 0 was one Tencent Lighthouse box in Jakarta. Phase 1 is TKE; its manifests are in `webapp-deploy/k8s/`, not yet applied.
- **Ships by:** `node scripts/release-web.mjs --tag <tag> --sha <sha>`, with `--dry-run` first. It pushes both images, plus a deploy bundle to `Kyoo032/Nultron-Releases` (the release repo, renamed from `Kyoo032/Nultron` on 2026-10-15 and from `Kyoo032/NultronEnt` on 2026-10-14).
- **Tag:** `ent-YYYY.MM.DD`. Every deploy is logged by sha.
- **Current:** nothing has been released or deployed. Checked 2026-11-06:
  - The deploy logs in [`web-pivot-2026-09-18.md`](web-pivot-2026-09-18.md#deploy-log) and [`webapp-deploy/DEPLOY-LOG.md`](../../webapp-deploy/DEPLOY-LOG.md) have no row.
  - `Kyoo032/Nultron-Releases` has no GitHub Release, and its last push was on 2026-09-25.
  - `docs/public/ent-2026.10.02-notes.md` was written and never published.

  The Tencent deploy planned for Thursday 8 October 2026 is in neither log, so it did not happen. Whether a `ghcr.io/kyoo032/nultron-ent` image was ever pushed is unknown. The ghcr lookup answered 404, and the token used for it may lack package access.
- **Focus now:**
  1. Build the image, driven with a real hosted Chat.
  2. Dry run of the release.
  3. Release, after Rizky confirms at that moment.
  4. The first Tencent deploy, logged by sha. No date is recorded since the 8 October plan lapsed.
- **Logs:**
  - [Deploy log](web-pivot-2026-09-18.md#deploy-log).
  - [`security-register.md`](security-register.md), the deploy gate.

## kemenkeu-ai

**Retired with the desktop app (2026-10-14).** Do not pack it. Its brand folder `apps/desktop/branding/kemenkeu/` is gitignored (`.gitignore:23`) and exists only on the operator's machine, so none of the files named below is in this repo.

**Identity**

| Element | Value | Files |
|---|---|---|
| Name | Kemenkeu AI | `apps/desktop/branding/kemenkeu/brand.json` |
| Logo | The Kemenkeu emblem: a blue pentagon, gold wings, rice and cotton, and the motto "Nagara Dana Rakça". It is a government emblem: use it unaltered. | `logo.svg` (vector master), `logo.png`, `icon.ico`, `splash.png` in `apps/desktop/branding/kemenkeu/` |
| Mascot | Nultron's, unchanged in the app | There is no flavor mascot |
| Wordmark | Plain product name. The gradient is for Nultron only (`apps/web/app/globals.css:191`). | |
| Type and app colours | Nultron's. A flavor swaps only the name, logo, splash and gateway. | |

| Colour (from `logo.svg`) | Hex | Role in the emblem |
|---|---|---|
| Emblem blue | `#275AB1` | the pentagon field |
| Gold | `#FAB20B` | wings, rice, pillar |
| Green | `#00A650` | the cotton |
| Outline black | `#231F20` | the border |

**Release**

- **Type:** Windows desktop flavor. Packed with `AGENTFORGE_BRAND=kemenkeu node apps/desktop/scripts/pack-brand.mjs`.
- **App id:** `id.go.kemenkeu.ai`. Installer: `Kemenkeu AI Setup <v>.exe`.
- **Gateway:** AIHub, `https://aihub.metranet.co.id/v1`. Metranet runs this gateway.
- **Services:** the installer only. There is no updater, because `updates` is not set.
- **Ships by:** a local pack on Rizky's machine. There is no public release repo.
- **Current:** retired. No pack was recorded.
- **Focus now:** none.

## aihub-metranet

**Retired with the desktop app (2026-10-14).** Do not pack it. Its brand folder `apps/desktop/branding/metranet/` is gitignored (`.gitignore:24`) and exists only on the operator's machine, so none of the files named below is in this repo.

**Identity**

| Element | Value | Files |
|---|---|---|
| Name | AIHub Metranet | `apps/desktop/branding/metranet/brand.json` |
| Logo | The Metranet logo: a red circle with a white wave "m", the "metranet" wordmark, and "by Telkom Indonesia" with the Telkom mark. Use it unaltered. | `logo.png` (the master). `logo.svg` wraps a raster image, so it is not a true vector. Also `icon.ico` and `splash.png`. |
| Mascot | Nultron's, unchanged in the app | There is no flavor mascot |
| Wordmark | Plain product name | |
| Type and app colours | Nultron's. The flavor swaps only the name, logo, splash and gateway. | |

| Colour (sampled from `logo.png`) | Hex | Role in the logo |
|---|---|---|
| Metranet red | `#E92214` | the circle |
| Wordmark dark | `#202020` | "metra" |
| Wordmark grey | `#808080` | "net" |

**Release**

- **Type:** Windows desktop flavor. Packed with `AGENTFORGE_BRAND=metranet node apps/desktop/scripts/pack-brand.mjs`.
- **App id:** `id.co.metranet.aihub`. Installer: `AIHub Metranet Setup <v>.exe`.
- **Company:** Metranet, a Telkom Indonesia company. It also operates the AIHub gateway that the Kemenkeu flavor uses.
- **Gateway:** AIHub, `https://aihub.metranet.co.id/v1`.
- **Services:** the installer only, with no updater.
- **Ships by:** a local pack on Rizky's machine. There is no public release repo.
- **Current:** retired. No pack was recorded.
- **Focus now:** none.

---

## Keeping this file true

- When you release or deploy a target, update its **Current** and **Focus now** lines in the same change.
- Add a target the day a new company or product is agreed, with its logo file and colours sampled from that file. Never add one in passing.
- When a brand asset moves, update its file path here in the same PR.
- When the "Which targets a change touches" table stops matching the code, fix the table in the same PR.
