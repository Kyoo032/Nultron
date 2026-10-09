# White-label structure and agent guardrails: plan for approval

Status: proposal, 2026-10-09. Nothing here is built. Three decisions are Rizky's (section 6).

## 1. Why now

Rizky wants the repo to be safe for agents to work in: they know where a fix goes, how it syncs, what a tester promotion does, and how each asset and each piece of code may differ between products. Today there are two products and one fork. If Nultron is offered to many white labels, the fork model repeats once per brand.

## 2. What the evidence says

The HYP AI clone's whole difference from `main` was measured on 2026-10-09 (`hypey/intake/hyp-brand.patch`, 307 files, read-only classification):

| Bucket | Files | Changed text lines |
|---|---|---|
| Brand content: locale strings, colours, images, mascot manifest | 107 | 855 |
| Tests that assert a brand string, colour or filename | 104 | 1,000 |
| Brand names hard-coded inside code (12 model prompts, error strings, labels, User-Agents) | 31 | 140 |
| Deploy profile files | 18 | 70 |
| Desktop identity (`brand.json`, icons, installer) | 21 | 237 |
| Docs and other | 17 | 218 |
| **Real behaviour** | **9** | **79** |

About 95% of the fork is brand or deploy settings. Real behaviour is about 80 lines. The Cloudflare edge and password sign-in are not in that patch at all; they live in `hypey/deploy`.

What the fork costs, seen on the same day: the clone's `main` is still at the 2026-10-05 sync, with the 10-06 and 10-07 syncs parked on side branches; merging them gave 13 conflicts, so today's sync went on a fresh branch. The sync also had to re-brand two new prompts that said "Nultron". Both are the cost of N forks growing.

The desktop app already solves this for brands: `apps/desktop/branding/<brand>/brand.json` (kemenkeu, metranet, agentforge) is one folder per brand and one pipeline. The hosted app has no equivalent. There is no brand module in shared code; the product and gateway names are copied into about 20 files, and the gateway host six or more times (pin, display, CSP in the code and in two Caddy configs, env examples).

### Nultron is a product too, not the baseline

The numbers above come from HYP AI because it is the one fork that exists. That hides the real structure. Three things are mixed together in the word "lane", and they vary independently:

| Axis | Values today | Where it lives now |
|---|---|---|
| **Brand** (names, gateway, colours, mascot, locale overrides) | Nultron (the default), HYP AI, Kemenkeu AI, AIHub Metranet | Nultron's name is hard-coded as `DEFAULT_PRODUCT_NAME` in `packages/core/src/gateway.ts` and in the prompts; desktop brands in `apps/desktop/branding/<brand>/`; HYP AI is a fork |
| **Product profile** (how the app runs) | Personal (Electron, IPC, SQLite on the machine) and Enterprise (hosted, server mode, portal, per tenant) | Gated in code by `isServerMode()`, with a Personal-parity test for every Enterprise change |
| **Deploy profile** (how it is served) | Nultron: direct, two names, own certificates, e-mailed code. HYP AI: Cloudflare edge or direct, one name plus `:8443`, password sign-in | `webapp-deploy/`, `hypey/deploy` |

Nultron's own needs the plan must cover, not just HYP AI's:
- **Nultron is brand pack zero.** Its name and gateway ("Nultron", "Toko Token") are baked into shared code as if they were neutral. A second brand can only be clean if Nultron moves into `brands/nultron/` like any other, and the shared code stops knowing its name. This is the largest single change, and it is on Nultron's side, not HYP AI's.
- **Personal and Enterprise are profiles, not brands.** Every white label can ship either. The guard needs both rules the repo already has: an Enterprise-only change is gated to server mode and carries a Personal-parity test; a Personal change must not read hosted state.
- **Nultron's release paths differ from a white label's.** Nultron ships Personal through `pnpm desktop:release` to `Kyoo032/Nultron`, and Enterprise through `release-web.mjs` plus the preview's desk-by-desk update. A white label ships through its own bundle. A shared change must not alter either path silently.
- **Desktop brands already exist** (Kemenkeu AI, AIHub Metranet), each with its own `brand.json`. They are the working proof of design A and must be inside the same manifest and guard, so the plan is for N brands across two profiles, not for HYP AI alone.
- **The tester branch is Nultron's.** It tests a new Nultron shape (chat first). A promotion to `main` changes the default brand's UI for every white label too, so the promotion checklist must name which brands inherit it.

## 3. Two designs

**A. Brand packs (recommended).** Each white label is a folder `brands/<id>/` with `brand.json` (names, gateway name and host, app id, update setting), colours, images and mascot manifest, locale overrides, and a deploy profile. One pipeline is parameterised by brand id. Hosted picks its brand at boot; desktop picks it at pack time as it does now. N white labels cost N folders, not N forks. HYP AI's clone shrinks to its pack plus its deploy profile.

The seams that must exist first (all small, all in the patch above):
1. One brand constants module in shared code, with a CommonJS copy for the Electron files, that prompts, error strings and the CSP read.
2. The Caddy CSP generated from the gateway host, not typed twice.
3. A neutral provider id (HYP AI renamed `toko` to `tokenku`, which breaks stored ids).
4. `updates: null` as a real setting (HYP AI uses a fake repo name to switch updates off).
5. A mascot manifest flag for single-still brands.
6. Locale strings that take `{productName}` instead of a baked-in name.

Cost: touches the release scripts, the deploy bundle and the pack scripts, and `AGENTS.md` says a change to those needs Rizky's word. It is a migration, done in steps, with HYP AI as the first pack and Nultron as the default pack.

**B. Keep vendor-branch forks and add guards.** Cheapest today, and sync steps stay as written. Cost grows with every brand, each fork carries its own conflicts, and every shared change needs a leak check per fork.

Recommendation: A, in stages, with the guardrails in section 4 first because they pay off under either design and make the migration safe.

## 4. Guardrails as mechanisms, not more text

Each is harness-only (not shipped in an installer or image) unless noted.

1. **Ownership manifest, `lanes.json` in the repo.** Maps path globs to: the map page that describes them, the lanes the paths affect (Personal, Enterprise, white labels, tester), and a `protected` flag. The tester's shared-files list moves here from the Obsidian note, because agents working in the repo cannot see the vault. The HYP AI import keeps this file (strip rules updated), so the clone can run the same guard.
2. **Guard script, a required step in `ci:local`.** Fails when code under a glob changes and its map page does not change in the same diff. Fails when a `protected` path changes without a lane label in the commit or PR. Fails when a brand literal (Nultron, Toko Token, TokenKu, HYP AI, Hypey) is added to shared code. The brand check ratchets against a recorded baseline, because "Nultron" is the default brand and the mascot name today and a plain check would be red on day one. In the clone it runs a brand-aware variant where HYP AI strings are correct. It skips cleanly where `docs/internal` is stripped.
3. **Make `maps:check` required, after fixing its 6 hard failures** (all in `tenant-usage-ledger.md`). Otherwise agents learn that red is normal.
4. **A project skill, `.cursor/skills/change-agentforge/`.** One sequence for any change: name the lane, read the map (pstack `how`), run `blast-radius` on any shared-file diff, edit only owned paths, refresh the map, run the guard, open the PR to `main`, then run the sync steps. It calls pstack and never vendors it. Every worker prompt starts from one standard preamble file instead of rules pasted by hand.
5. **Sync written as a runbook the guard can check.** What happens after a PR merges, what the tester merge keeps, and what a tester promotion changes (it becomes published code, so its bugs are fixed on `main`, and the manifest's `tester-only` entries move to shared). Lives in `docs/internal/maps/release-and-sync-lanes.md`, extended.
6. **A "Touches / Do not touch" section in each map page**, started on the busiest: Chat, jobs, hosted security, the portal.

## 5. Staging

1. Guardrails 1 to 3 and the preamble, no product code touched. Proven by deliberately breaking each rule in a throwaway diff and watching the guard fail.
2. Brand constants module and the six seams, behind identical output for Nultron (a test pins that the Nultron build is byte-for-byte unchanged in user-visible strings).
3. Nultron moved into `brands/nultron/` (output pinned unchanged), then HYP AI as the second pack; the clone reduced to its pack and deploy profile; sync becomes a version bump.
4. A second, throwaway brand pack to prove N, before any real customer.

## 6. Decisions for Rizky

1. **A or B** for white labels, with Nultron as brand pack zero.
2. **May the release, pack and deploy scripts change** as stage 2 and 3 need (AGENTS.md currently forbids that without his word).
3. **Make the guard and `maps:check` required** in `ci:local`, so red blocks a PR.
