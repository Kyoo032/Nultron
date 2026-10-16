# White-label structure and agent guardrails: plan for approval

Status: proposal, 2026-10-09; revised 2026-10-12 (design B chosen by Kyo, see the decision record in section 6). Brand code never lives in agentforge; each brand is a private downstream repo.

## 1. Why now

Rizky wants the repo to be safe for agents to work in: they know where a fix goes, how it syncs, what a tester promotion does, and how each asset and each piece of code may differ between products. Today there are two products and no white-label fork. If Nultron is offered to many white labels, the fork model repeats once per brand.

## 2. What the evidence says

The desktop app already keeps a brand as one folder (`apps/desktop/branding/<brand>/brand.json`), which is the shape to copy for the hosted app. The hosted app has no equivalent.

### Nultron is a product too, not the baseline

Three things are mixed together in the word "lane", and they vary independently:

| Axis | Values today | Where it lives now |
|---|---|---|
| **Brand** (names, gateway, colours, mascot, locale overrides) | Nultron (the default) | Nultron's name is hard-coded as `DEFAULT_PRODUCT_NAME` in `packages/core/src/gateway.ts` and in the prompts; desktop brands in `apps/desktop/branding/<brand>/` |
| **Product profile** (how the app runs) | Personal (Electron, IPC, SQLite on the machine) and Enterprise (hosted, server mode, portal, per tenant) | Gated in code by `isServerMode()`, with a Personal-parity test for every Enterprise change |
| **Deploy profile** (how it is served) | Nultron: direct, two names, own certificates, e-mailed code | `webapp-deploy/` |

Scope: Nultron, with the web-based Enterprise version first. Personal stays on the same code and keeps its parity rule, but it is not what this plan optimises. Other desktop brands (Kemenkeu AI, AIHub Metranet) are out of scope. Nultron's own needs:
- **Nultron is a downstream brand.** Its name and gateway ("Nultron", "Toko Token") are baked into shared code as if they were neutral. Under the 2026-10-12 decision no brand lives in agentforge, so Nultron moves out to its own private downstream repo and shared code falls back to a neutral default brand. Stripping the Nultron name from shared code is still the largest single change, and it is on Nultron's side. agentforge may keep per-brand docs that explain what each brand uses, but no brand code or assets.
- **Personal and Enterprise are profiles, not brands.** Nultron ships either, but Enterprise (the hosted web version) comes first. The guard needs both rules the repo already has: an Enterprise-only change is gated to server mode and carries a Personal-parity test; a Personal change must not read hosted state.
- **Nultron's release paths differ from a white label's.** Nultron shipped Personal through `pnpm desktop:release` to `Kyoo032/Nultron-Desktop` (retired and archived 2026-10-14), and ships the web app through `release-web.mjs` plus the preview's desk-by-desk update. A white label ships through its own bundle. A shared change must not alter either path silently.
- **The tester branch is Nultron's.** It tests a new Nultron shape (chat first). A promotion to `main` changes the default brand's UI for every white label too, so the promotion checklist must name which brands inherit it.

## 3. Two designs

**A. Brand packs in this repo (rejected 2026-10-12, see section 6).** Each white label is a folder `brands/<id>/` with `brand.json` (names, gateway name and host, app id, update setting), colours, images and mascot manifest, locale overrides, and a deploy profile. One pipeline is parameterised by brand id. Hosted picks its brand at boot; desktop picks it at pack time as it does now. A later white label would cost one folder, not one fork. Rejected: Kyo ruled that no brand is merged into agentforge. What survives from A is the generic loader (brand config schema, boot-time and pack-time selection) and the seams below, with the packs held downstream.

The seams (generic, brand-neutral hooks that still land on `main` under B, so each downstream repo stays thin):
1. One brand constants module in shared code, with a CommonJS copy for the Electron files, that prompts, error strings and the CSP read.
2. The Caddy CSP generated from the gateway host, not typed twice.
3. A neutral provider id (a rename of `toko` breaks stored ids).
4. `updates: null` as a real setting (instead of a fake repo name to switch updates off).
5. A mascot manifest flag for single-still brands.
6. Locale strings that take `{productName}` instead of a baked-in name.

Cost: touches the release scripts, the deploy bundle and the pack scripts, and `AGENTS.md` says a change to those needs Rizky's word. It is a migration, done in steps, with Nultron as the default pack.

**B. Downstream brand repos plus generic hooks (chosen, Kyo 2026-10-12).** Each brand is its own private repo (branches `main`, `upstream` and `sync/*`) that syncs from agentforge `main`. The brand lives there as config and assets read through the hooks above, plus a small named set of brand commits for whatever cannot be config yet. Cost grows with every brand, which the hooks keep small.

Sync model:
- `upstream` is a pristine mirror of agentforge `main`; nothing brand-specific lands on it.
- Each sync: create `sync/YYYY-MM-DD` from the brand's `main`, merge `upstream` (merge, not rebase), replay or adjust the brand layer, run `pnpm ci:local` plus the brand repo's leak check, then PR into the brand's `main`.
- Brand Triage runs the sync, the brand Architect reviews the brand delta and the leak check, Kyo approves the merge to the brand's `main`. Cadence: each agentforge release or weekly, plus ad hoc for security fixes. Merged sync branches are deleted.
- Leak check: each downstream repo owns its forbidden-terms list and allowlist; `main` runs a neutral check that fails when shared code names any brand.

Generic hooks to land on `main`: #158 (`GATEWAY_PROVIDER_ID`), one brand config entry point, host config (with the Caddy CSP generated from the gateway host), asset paths read from config, locale overrides, neutral deploy defaults, and a reusable leak-check script parameterised by a forbidden-terms list.

Recommendation: B with the hooks, and the guardrails in section 4 first.

## 4. Guardrails as mechanisms, not more text

Each is harness-only (not shipped in an installer or image) unless noted.

1. **Ownership manifest, `lanes.json` in the repo.** Maps path globs to: the map page that describes them, the lanes the paths affect (Personal, Enterprise, white labels, tester), and a `protected` flag. The tester's shared-files list moves here from the Obsidian note, because agents working in the repo cannot see the vault.
2. **Guard script, a required step in `ci:local`.** Fails when code under a glob changes and its map page does not change in the same diff. Fails when a `protected` path changes without a lane label in the commit or PR. Fails when a brand literal (Nultron or Toko Token, the `brandLiterals` list in `lanes.json`) is added to shared code. The brand check ratchets against a recorded baseline, because "Nultron" is the default brand and the mascot name today and a plain check would be red on day one. It skips cleanly where `docs/internal` is stripped.
3. **Make `maps:check` required, after fixing its 6 hard failures** (all in `tenant-usage-ledger.md`). Otherwise agents learn that red is normal.
4. **A project skill, `.cursor/skills/change-agentforge/`.** One sequence for any change: name the lane, read the map (pstack `how`), run `blast-radius` on any shared-file diff, edit only owned paths, refresh the map, run the guard, open the PR to `main`, then run the sync steps. It calls pstack and never vendors it. Every worker prompt starts from one standard preamble file instead of rules pasted by hand.
5. **Sync written as a runbook the guard can check.** What happens after a PR merges, what the tester merge keeps, and what a tester promotion changes (it becomes published code, so its bugs are fixed on `main`, and the manifest's `tester-only` entries move to shared). Lives in `docs/internal/maps/release-and-sync-lanes.md`, extended.
6. **A "Touches / Do not touch" section in each map page**, started on the busiest: Chat, jobs, hosted security, the portal.

## 5. Staging

1. **Built 2026-10-09 (advisory, not required):** `lanes.json`, `scripts/lane-guard.mjs` (warns, `--strict` for later), the `lane-guard` step in `ci:local`, the `change-agentforge` skill with its preamble, the Touches / Do not touch sections, and `maps:check` back to zero hard failures. Making the guard and `maps:check` required is still decision 3. Guardrails 1 to 3 and the preamble, no product code touched. Proven by deliberately breaking each rule in a throwaway diff and watching the guard fail.
2. Brand constants module and the six seams, behind identical output for Nultron (a test pins that the Nultron build is byte-for-byte unchanged in user-visible strings).
3. Nultron moved out to its own private downstream repo, and shared code left with a neutral default brand (user-visible output for Nultron pinned unchanged in the Nultron repo).
4. A neutral fixture brand used only in tests (or a throwaway downstream test repo) to prove N brands, before any real customer. No brand pack is added to this repo.

## 6. Decisions for Rizky

1. **A or B** for white labels. **Decided 2026-10-12 (Kyo): B, downstream brand repos.** Brand code is never merged into agentforge. Each brand lives in its own private downstream repo that syncs from agentforge `main` by the sync model in section 3. agentforge holds only generic, brand-neutral hooks and per-brand docs. This replaces the 2026-10-12 16:08 choice of in-repo brand packs.
2. **May the release, pack and deploy scripts change** as stage 2 and 3 need (AGENTS.md currently forbids that without his word).
3. **Make the guard and `maps:check` required** in `ci:local`, so red blocks a PR.
