# Unreleased changes (after the 0.16.0 cut)

**Purpose:** what is on `main` or on a cut branch but not inside a published installer. **0.16.0 is cut and packed, not published** (2026-10-06, branch `chore/release-0.16.0`; Windows from `4dd33fa`, mac from `e7a17c2`). It is the first installer under the Nultron name. Until it ships, the installer in the wild is **v0.15.1** (`DPSBuddy Setup 0.15.1.exe`, published 2026-09-28 04:54 UTC from `43c1de3`). The ship list and the pack table are [`0.16.0-changelog.md`](0.16.0-changelog.md).

This file was started over at the 0.16.0 cut. The 0.15.1 cut never started it over, so the log it held ran from after 0.15.0 to 2026-10-05; that whole log is summarised in [`0.16.0-changelog.md`](0.16.0-changelog.md), and its full text is readable from git at `de95267` (`git show de95267:docs/internal/unreleased.md`). The pre-0.14.27 findings lists are readable at `e2e477e`.

Convention unchanged: at the next bump everything listed here folds into `<version>-changelog.md` and this file starts over. Nothing counts as shipped until it is staged, packed, installed, and driven on the packaged app. Append-only.

## Where each published artifact came from

| Release | Source | Published (UTC) | Record |
|---|---|---|---|
| v0.15.1 | `43c1de3`, worktree `agentforge-pack-0.15.1`; Docker Linux `--arch all` for mac | 2026-09-28 04:54, 7 assets on [`Kyoo032/Nultron`](https://github.com/Kyoo032/Nultron/releases/tag/v0.15.1) | [`0.15.1-changelog.md`](0.15.1-changelog.md) § Pack + publish |
| v0.15.0 | `88bb803`, worktree `agentforge-pack-0.15.0`; Docker Linux `--arch all` for mac | 2026-09-23 11:25, 7 assets on `Kyoo032/DPSBuddy` (now redirects to `Kyoo032/Nultron`) | [`0.15.0-changelog.md`](0.15.0-changelog.md) § Pack + publish |
| v0.14.27 | Windows `05e97a5`, mac `6da52d7` | 2026-09-18 01:47 | [`0.14.27-changelog.md`](0.14.27-changelog.md) |

0.16.0 rows are added here when it is published; until then its pack table lives only in [`0.16.0-changelog.md`](0.16.0-changelog.md). mac is **preview** for every release above: no dmg since 0.14.26 has been opened on Mac hardware.

## Still open, carried over at the 0.16.0 cut

Nothing below is closed by 0.16.0. Carried forward from the old file's "Still open after the 0.14.27 cut" list and its 2026-10-05 findings, as they stood at `de95267`.

### From before 0.15.0

- [ ] **Packaged bundled-anydoc load.** No packed app has been shown to *load* `anydoc.<platform>.node` from `app.asar.unpacked`. Proof owed: `doctor --desktop` plus `GET /api/v1/components` reporting `anydoc` `ready` with `source: "bundled"`.
- [ ] **Any macOS run of the component installer's download route.** Never done.
- [ ] **The onboarding component panel** (`component-setup`) has never been seen on the packaged app.
- [ ] **Legal:** one live matter run against the gateway (`features/legal.md` steps 4 to 8), and the Word / Excel round-trip of the redline and deviation report.
- [ ] **Packaged Windows drive of Start over + the gateway gate** (`doctor --desktop`, `host-status.json` `hasOpenai: false` after sign-out).
- [ ] **The manual Windows smoke list** from `apps/desktop/platform/windows/AGENTS.md`: Ctrl+V and right-click Paste on the onboarding key field, composer clipboard round-trip, the rail-footer update panel, Start over → reset → "Keep my data", model-output links opening the default browser, the model picker on a narrow pane.
- [ ] **Packaged CSP console check** on a packed build (the static half is proven; the runtime half is not).
- [ ] **mac launch smoke on hardware.** Owed for every build since 0.14.26.
- [ ] **ffmpeg is still a manual install** on both platforms (`ffmpeg-setup-notice`). It is the next component-manifest entry.
- [ ] **The unfixed findings** from the 2026-09-17 mapping pass, the knowledge-flow pass and the 2026-09-15 harness pass. Read the lists at `e2e477e`; the harness pass is also P7–P15 in [`blockers-2026-09-15.md`](blockers-2026-09-15.md).
- [ ] **Chat card titles.** A Chat thread's title is never regenerated after turn 1 (`threads.ts` `setThreadTitleFromParts`).
- [ ] **Housekeeping on the owner's desk:** 72 stub Videos rows in the dev `data/agentforge.sqlite`, 36 with no file (shown as "File missing" since 2026-09-29).

### Findings from the verify-skill maintenance pass, 2026-10-05 (product bugs)

Copied as they stood at `de95267`; the evidence is under `.cursor/skills/verify-agentforge/evidence/<feature>/2026-10-05-maintain/`. The first two were fixed on the 0.16.0 cut branch (`f193ab2`, `a0683bd`; see [`0.16.0-changelog.md`](0.16.0-changelog.md), "Fixes made on the cut branch"). The rest are still open.

- [x] **Fixed at the 0.16.0 cut (`f193ab2`).** **A non-`ok` gate verdict never heals (both products, highest impact).** `needsGatewayRefresh` re-checks in the background only an `ok` verdict past its TTL (`packages/host/src/gateway-gate.ts:559-567`). An `unreachable` or `error` verdict stays on disk, and once `lastOkAt` is older than the 7-day grace, `deriveGatewayGate` closes the desk (`:327-330`) until a manual Re-check.
- [x] **Fixed at the 0.16.0 cut (`a0683bd`).** **Settings Save with a blank key field forgets the key (Personal and webdev).** The form posts `openaiApiKey` on every save (`apps/web/components/settings-page.tsx:284-289`); off server mode a blank is forwarded (`packages/host/src/handlers/settings.ts:226-234`) and `mergeSecrets` deletes the key (`packages/core/src/secrets.ts:137-139`). Traced in source; not driven.
- [ ] **Finance loses 1 px of scroll per rail detour.** Cause not found.
- [ ] **Finance shows a vague error, or none, on a closed gate** (`packages/host/src/handlers/finance.ts:52`). Matters on hosted "Add it later".
- [ ] **Empty box above the key form after a component install** (`apps/web/components/onboarding-screen.tsx:293`, `apps/web/lib/use-component-setup.ts:126`). Appears only where a real download runs, such as a packed mac build.
- [ ] **Model label casing.** `gpt-oss-120b` shows as "GPT Oss 120B" (`packages/core/src/models/curation.ts:28`).
- [ ] **Portal: "we already sent a code" after a send that failed** (`apps/portal/src/otp/send.ts:119-122`). Enterprise only.
- [ ] **Portal: a mail outage holds every send for about 8 s before the 503.** Enterprise only.
- [ ] **Pilot rehearsal: Mailpit does not come back after a Docker restart** (`webapp-deploy/compose.local.yml:82`). Rehearsal stack only.
- [ ] **Dead locale key** `auth.account.tenant` (`apps/web/locales/en/auth.json:34`).

## Log

Append below, newest first.

## Hosted team privacy: a Chat card is its person's alone, and only an owner or admin deletes a desk, 2026-10-07 (Enterprise; fixed in the tree, not driven)

Both fixes are hosted only. Personal is unchanged and held by tests. Nothing here is packed, deployed or driven on a running hosted server.

- **Bug.** On the hosted server the people of one company share one desk, and `knowledge_sources` was read by desk, not by person. A member's Sources list, search, Chat prompt, `knowledge_search` results, graph, map and reindex all carried every colleague's Chat card (its text and its thread title), and a company owner could read a member's Chat the same way. The owner's rule of 2026-10-06 is that Chat is private to the person, owner and admins included ([SR-155](security-register.md#sr-155)).
- **Fix.** `packages/host/src/knowledge-visibility.ts` holds the rule: a source with `origin_kind = 'thread'` is visible only to the person who owns the thread, with no role override. Every read path builds its SQL from it: `listSources`, the full-text and vector queries, source names, the context popover's record, the graph and its counts, graph expansion, the map build, reindex and delete by id. It applies when `isServerMode()` is true; off server mode every fragment is empty and the SQL is what it was. Each fragment is a primary-key lookup, not a list of ids; on a desk of 4,000 sources the plan shows no scan of `threads` and a full-text query went from 0.5 ms to 1.3 ms, so no index was added.
- **Map.** A hosted map is built from non-Chat sources only and stamped; a map saved before the stamp reads as no map, so each hosted desk maps once more. That cost was accepted because no hosted desk held real customer data ([SR-160](security-register.md#sr-160)).
- **Bug.** Any member could delete a desk of the company (`DELETE /api/v1/workspaces/:id` with the desk name typed), taking every person's chats on it with it ([SR-156](security-register.md#sr-156)).
- **Fix.** Hosted, `handleDeleteWorkspace` requires an owner or an admin (`canAdminister`) and answers a member or a builder `403 workspace_delete_forbidden`, after the desk is found and before the name is asked for. The Workspaces page hides the button from a member and says who can (`desk-delete-control.tsx`, `desk-delete-access.ts`), in `en` and `id`.
- **Not changed.** Stored media is read by company, so a colleague's picture can be fetched by id and is in the galleries ([SR-157](security-register.md#sr-157), open, needs an owner decision). A member can still create, rename and re-mode a desk ([SR-158](security-register.md#sr-158)). The Soul, pinned memories and retrieval count are the company's ([SR-159](security-register.md#sr-159)). A per-person Knowledge Base is design only ([SR-161](security-register.md#sr-161)).
- **Proof.** Host: `knowledge-team-privacy.test.ts` (27 cases; 21 failed against the old code), `knowledge-visibility.test.ts` (15), `handlers/workspaces-delete-roles.test.ts` (12; 4 failed against the old handler). Web: `lib/desk-delete-access.test.tsx` (14). Each hosted behaviour has a Personal-parity case. Maps: `knowledge-flows.md` § 7, `chat-sessions-and-rail.md`; recipes: `features/knowledge.md`, `features/workspaces.md`.

## Hosted image: the ignore file dropped packages/core/src/data, 2026-10-06 (Enterprise image; fixed in the tree)

- **Bug.** `**/data` in `webapp-deploy/Dockerfile.dockerignore` (and its byte copy `webapp-deploy/.dockerignore`) keeps local data dirs out of the image, and also dropped the source folder `packages/core/src/data` (`ground.ts`, `cuts.ts`). An image built from `main` at `de95267` with `git archive` failed its own load check. Found while preparing the app.nultron-ai.xyz preview.
- **Fix.** Both files re-include `packages/core/src/data` and `packages/core/src/data/**`. `scripts/pilot-deploy.test.mjs` adds a test that every tracked `*/src/data` folder has its re-include (30 tests green).
- **Proof.** `nultron-web:979bd797bdf0`, built on the Tencent Lighthouse box from `git archive 979bd79`, completed with the load check (895 MB). Not yet run as the Enterprise app; the preview runs it in single-desk mode (security register SR-133).
