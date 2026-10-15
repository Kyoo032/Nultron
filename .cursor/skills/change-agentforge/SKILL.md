---
name: change-agentforge
description: The ordered sequence for ANY change to this repo. First check where you are (pnpm where, or the two git commands), then pick the row that fits the change: a bug on main, a feature on the tester, docs, or a release. Name the lanes, read the map page, check blast radius on shared files, edit only owned paths, refresh the map and recipe, run lane-guard and ci:local, then open the pull request or commit as the row says, then run the sync steps. Use before editing, and when briefing a subagent.
---

# Change agentforge

Agent guardrail, same class as `AGENTS.md`. Not part of any product. It ships in no installer or image.

Lanes: `main` is the published code (Nultron as the OPC web app, and the Enterprise base). The tester (`C:\Users\rizky\agentforge-chat`, branch `tester/chat-first`) is the staging code at every stage. HYP AI is its own repo since 2026-10-15 (`Kyoo032/hyp-ai`, folder `C:\Users\rizky\hyp-ai`) and takes nothing from here. Nultron Personal is retired and owes nothing. The rules are in `AGENTS.md` ("Where am I?", "Where a change goes", "Lanes"); the working form is [`release-and-sync-lanes.md`](../../../docs/internal/maps/release-and-sync-lanes.md).

pstack stays in the Cursor plugin. Call it by path, never copy it: `~/.cursor/plugins/cache/cursor-public/pstack/*/skills/how/SKILL.md` and `.../skills/blast-radius/SKILL.md`. The standard block to paste at the top of every subagent prompt is [`preamble.md`](preamble.md).

## Step 0: where am I, and which row

Run `pnpm where` (`scripts/where-am-i.mjs`, added on branch `chore/agent-guardrails`). Until it lands, run `git rev-parse --show-toplevel` and `git branch --show-current`. The folder and branch must match a row in `AGENTS.md` "Where am I?". If they match none, stop and ask Rizky.

Then pick the row in `AGENTS.md` "Where a change goes" that fits the change. Short form:

| The change | Work in | Pull request |
|---|---|---|
| A bug seen on the live app, the preview or `:3000` | a worktree cut from `main` | to `main` |
| A new feature, a behaviour change, or a bug in a feature that exists only in the tester | `C:\Users\rizky\agentforge-chat`, `tester/chat-first` | none; drive on the staging instance first, then a promotion PR Rizky approves |
| Docs, maps or skills about shared code | a worktree cut from `main` | to `main` |
| A release or a deploy | `C:\Users\rizky\agentforge`, `main` only | none; Rizky's go at that moment |

## The sequence

1. **Pick the row.** Step 0 names the folder, the branch and the pull request target. Work only there. Never open a fix pull request from `tester/chat-first`, never fix a shared change by hand in the tester folder, and do not switch branches under someone else's work. A fix made there is lost or conflicts at the next merge from `main`.
2. **Name the lanes.** Shared code reaches `enterprise` and `tester`. `personal` is retired and owes nothing. Find your paths in [`lanes.json`](../../../lanes.json): each entry lists its map page, the lanes it reaches and whether it is `protected`. Decide the product (see `AGENTS.md`, "Which product a change reaches") and the brand (shared code names none). Write the lanes down; they go in the commit and the PR.
3. **Read the map page first** (pstack `how`). The page named in `lanes.json`, plus its **Touches / Do not touch** section where it has one. If the page disagrees with the code, that is a finding, fix the page in step 7.
4. **Blast radius on any shared file.** A file is shared when it is `protected` in `lanes.json` (the tester branch edits it too), when many modes call it (`packages/host/src/job-regen.ts`), or when it sits in `packages/core` or `packages/db`. Run pstack `blast-radius` on the diff before you finish, and prove the one fact the change depends on by running code, not by writing it up.
5. **Edit only owned paths.** Stay inside the page's Touches list. Anything in Do not touch belongs to another page: change it in its own PR. Rules that always apply:
   - **Brand-neutral.** Shared code never types `Nultron`, `Toko Token`, `TokenKu`, `HYP AI` or `Hypey`; it reads `productName` and `gatewayName`. New copy goes in both `en` and `id` catalogs.
   - **Enterprise-only work** is gated on `isServerMode()` and carries a Personal-parity test. Personal work must not read hosted state.
   - **Deploy differences stay in their lane.** HYP AI's Cloudflare edge is not in this repo; do not carry it into `webapp-deploy/`. Password sign-in is a portal setting (`PORTAL_SIGNIN_MODE`) that both bundles can set, not a HYP AI-only lane.
   - **Release, pack and deploy scripts** need Rizky's word. Never run one from `C:\Users\rizky\agentforge-chat`.
6. **Prove it by driving.** A green `tsc` or a worker summary is not proof. Follow [`verify-agentforge`](../verify-agentforge/SKILL.md): doctor, drive the recipe, keep evidence. A tester change is driven on the staging instance (the tester's staging subdomain, name pending). Say "not driven" when you did not.
7. **Refresh the docs in the same change.** Rewrite the affected section of the map page and bump its `Last verified: <date> at <sha>` line; update the matching `.cursor/skills/verify-agentforge/features/<feature>.md`; append to `docs/internal/unreleased.md` and name the lanes. If you touched a tester shared file or added one, update `lanes.json` and the vault note in the same session.
8. **Commit by path, with the lanes.** `git add <path> ...`, never `git add -A` or `.`. Conventional message, then a `Lanes: enterprise, tester` line (name only the lanes you touch; `personal` is retired). No `git stash`, `checkout`, `restore` or `reset`.
9. **Run the guards.** `pnpm lane-guard` (map page not refreshed, protected file without a `Lanes:` line, a new brand literal), `pnpm maps:check`, then `pnpm ci:local`. Paste the `ci:local` summary table into the PR. `lane-guard` only warns; read each warning and fix it or say why it is wrong.
10. **Pull request, only where the row names one.** For a row that goes to `main`, open it only when Rizky asks, from the branch off `main`. The body lists the lanes and the lanes still owed their sync step. A tester change has no pull request until Rizky approves a promotion.
11. **After a pull request merges to `main`, the sync steps, in this order:**
    1. **Tester.** In `C:\Users\rizky\agentforge-chat`: clean tree, `git fetch origin`, `git merge origin/main`, `pnpm install --frozen-lockfile`, `ci:local`. On a conflict keep the `main` side of any fix; if both cannot be kept, `git merge --abort` and ask Rizky.
    2. **Enterprise.** Only when Rizky says release (`scripts/release-web.mjs`). Personal is retired: no step. A sync never implies a release.

A fix is not done for a lane until its step has run.

## When the guard warns wrongly

`scripts/lane-guard.mjs` reads `lanes.json` and `scripts/lane-guard.baseline.json`. A wrong map mapping is a `lanes.json` edit. A brand count that fell after a cleanup is lowered with `node scripts/lane-guard.mjs --write-baseline` on a clean tree; never regenerate it to excuse an increase. It skips itself where `lanes.json` is missing.
