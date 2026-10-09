---
name: change-agentforge
description: The ordered sequence for ANY change to this repo, so a fix lands once on main and reaches every lane. Name the lanes, read the map page, check blast radius on shared files, edit only owned paths, refresh the map and recipe, run lane-guard and ci:local, open the PR to main from a branch off main, then run the sync steps. Use before editing, and when briefing a subagent.
---

# Change agentforge

Agent guardrail, same class as `AGENTS.md`. Not part of any product. It ships in no installer or image and is stripped with `docs/internal` from the HYP AI import.

One source repo feeds four lanes: **Personal** (Nultron desktop), **Enterprise** (the hosted app), **HYP AI** (Hypernet's white label, imported from `main`) and **tester** (`agentforge-chat`, branch `tester/chat-first`). A fix is made once, on `main`. The rules are in `AGENTS.md` ("Two codes", "Sync lanes"); the working form is [`release-and-sync-lanes.md`](../../../docs/internal/maps/release-and-sync-lanes.md).

pstack stays in the Cursor plugin. Call it by path, never copy it: `~/.cursor/plugins/cache/cursor-public/pstack/*/skills/how/SKILL.md` and `.../skills/blast-radius/SKILL.md`. The standard block to paste at the top of every subagent prompt is [`preamble.md`](preamble.md).

## The sequence

1. **Branch off `main`.** `git fetch origin`, then a new branch from `origin/main`. Never work on `tester/chat-first`, never in the HYP AI clone (`C:\Users\rizky\hypey\app`), and do not switch branches under someone else's work. A fix made in either of those two places is lost or conflicts at the next sync.
2. **Name the lanes.** Default is all four. Find your paths in [`lanes.json`](../../../lanes.json): each entry lists its map page, the lanes it reaches and whether it is `protected`. Decide the product too (Personal, Enterprise, or both) and the brand (Nultron and HYP AI both import this code). Write the lanes down; they go in the commit and the PR.
3. **Read the map page first** (pstack `how`). The page named in `lanes.json`, plus its **Touches / Do not touch** section where it has one. If the page disagrees with the code, that is a finding, fix the page in step 7.
4. **Blast radius on any shared file.** A file is shared when it is `protected` in `lanes.json` (the tester branch edits it too), when many modes call it (`packages/host/src/job-regen.ts`), or when it sits in `packages/core` or `packages/db`. Run pstack `blast-radius` on the diff before you finish, and prove the one fact the change depends on by running code, not by writing it up.
5. **Edit only owned paths.** Stay inside the page's Touches list. Anything in Do not touch belongs to another page: change it in its own PR. Rules that always apply:
   - **Brand-neutral.** Shared code never types `Nultron`, `Toko Token`, `TokenKu`, `HYP AI` or `Hypey`; it reads `productName` and `gatewayName`. New copy goes in both `en` and `id` catalogs.
   - **Enterprise-only work** is gated on `isServerMode()` and carries a Personal-parity test. Personal work must not read hosted state.
   - **Deploy differences stay in their lane.** HYP AI's Cloudflare edge and password sign-in are not in this repo; do not carry them into `webapp-deploy/`.
   - **Release, pack and deploy scripts** need Rizky's word. Never run one from the tester folder.
6. **Prove it by driving.** A green `tsc` or a worker summary is not proof. Follow [`verify-agentforge`](../verify-agentforge/SKILL.md): doctor, drive the recipe, keep evidence. Say "not driven" when you did not.
7. **Refresh the docs in the same change.** Rewrite the affected section of the map page and bump its `Last verified: <date> at <sha>` line; update the matching `.cursor/skills/verify-agentforge/features/<feature>.md`; append to `docs/internal/unreleased.md` and name the lanes. If you touched a tester shared file or added one, update `lanes.json` and the vault note in the same session.
8. **Commit by path, with the lanes.** `git add <path> ...`, never `git add -A` or `.`. Conventional message, then a `Lanes: personal, enterprise, hyp-ai, tester` line (name only the lanes you touch). No `git stash`, `checkout`, `restore` or `reset`.
9. **Run the guards.** `pnpm lane-guard` (advisory: map page not refreshed, protected file without a `Lanes:` line, a new brand literal), `pnpm maps:check`, then `pnpm ci:local`. Paste the `ci:local` summary table into the PR. `lane-guard` only warns; read each warning and fix it or say why it is wrong.
10. **PR to `main`.** Open it only when Rizky asks, from the branch off `main`. The body lists the lanes and the lanes still owed their sync step.
11. **After the PR merges, the sync steps, in this order:**
    1. **Tester.** In `C:\Users\rizky\agentforge-chat`: clean tree, `git fetch origin`, `git merge origin/main`, `pnpm install --frozen-lockfile`, `ci:local`. On a conflict keep the `main` side of any fix; if both cannot be kept, `git merge --abort` and ask Rizky.
    2. **HYP AI.** Follow `C:\Users\rizky\hypey\intake\SYNC.md`: `commit-upstream.mjs <sha>`, merge, `check-leaks.sh` for any new brand string, `drive-leaks.mjs` against the running demo, then the sync history row.
    3. **Personal and Enterprise.** Only when Rizky says release. A sync never implies a release.

A fix is not done for a lane until its step has run.

## When the guard warns wrongly

`scripts/lane-guard.mjs` reads `lanes.json` and `scripts/lane-guard.baseline.json`. A wrong map mapping is a `lanes.json` edit. A brand count that fell after a cleanup is lowered with `node scripts/lane-guard.mjs --write-baseline` on a clean tree; never regenerate it to excuse an increase. It skips itself where `docs/internal` or `lanes.json` is missing.
