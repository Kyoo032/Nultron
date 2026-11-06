# Release and sync lanes

Product: both · Instance: every checkout (main, tester); no app drive

Last verified: 2026-10-22 at 7c44963 for the never-promote bullet under "Where things live" only. Nothing else on the page was re-read.

Last verified: 2026-10-17 at 07cb099 for the brand-rule bullet only (Nultron no longer checked, Toko Token still is).

Last verified: 2026-10-15 at 8a42aaed

Repo names and the lane set were re-read on 2026-10-15 at 8a42aaed: the lanes are `main` and the tester, and Personal is retired. The earlier rewrite was on 2026-10-14. The "Chat-first shell" section was read on 2026-10-12 at e8a7eca8, against the tester branch, before PR #157 promoted it to `main`.

## Overview

One source repo (`Kyoo032/agentforge`, branch `main`) is the one place a fix is made. The lanes are:

- `main` is the published code: Nultron as the OPC web app, and the Enterprise base.
- The tester (`tester/chat-first`) is the staging code at every stage. It is never released.
- Nultron Personal (the desktop app) is retired (2026-10-14). No release, no sync step.

The rules for where a change is cut and made are the tables at the top of `AGENTS.md`, "Where am I?" and "Where a change goes". The rules behind them are in `AGENTS.md`, "Lanes". This page is the working form of those rules: how a change reaches each lane, and what must be true before a lane counts as fixed. The longer story of the tester split is in Rizky's vault note `40-Dev/nultron-two-codes-map.md`. This page does not cover how a release is cut (see the "Web release" section of `AGENTS.md`).

Repo names as of 2026-10-15: the Enterprise release repo is `Kyoo032/Nultron-Releases` (`RELEASE_REPO`, `scripts/release-web.mjs:63`; it was `Kyoo032/Nultron` until the rename of 2026-10-15, and `Kyoo032/NultronEnt` until 2026-10-14). The source repo `agentforge` is renamed to `Kyoo032/Nultron` after that rename. The retired Personal release repo is `Kyoo032/Nultron-Desktop`, archived.

## Lanes

| Lane | Folder or repo | Built or released by | Takes a change by |
|---|---|---|---|
| `main` (published) | `C:\Users\rizky\agentforge`, branch `main`, and worktrees cut from it | `node scripts/release-web.mjs` to `Kyoo032/Nultron-Releases`; the preview at `app.nultron-ai.xyz` by its safe desk-by-desk update | a pull request to `main` from a branch cut from `main` |
| Tester (staging) | `C:\Users\rizky\agentforge-chat`, branch `tester/chat-first` | never released. Staging instance: the tester's staging subdomain (name pending, Rizky) | new feature work is committed on the tester and driven on staging; then a promotion pull request Rizky approves. Fixes from `main` arrive by `git merge origin/main` |
| Personal (retired 2026-10-14) | `agentforge`, `main` | nothing. `apps/desktop/scripts/release-desktop.mjs` is still in the tree and targets `Kyoo032/Nultron-Desktop`, which is archived | nothing: no new cut, no sync step owed |

## The chat-first shell (2026-10-12)

The tester added 16 `protected` entries to `lanes.json` on 2026-10-12. There are 32 protected entries in all as of 2026-10-14. They cover the shared files the tester edits (the composer, the rail, `product-modes.ts`, `i18n.ts` and others) and its own paths (`virtual-agents*`, `packages/host/src/workers/**`, the agent components), whose map is [`virtual-agents.md`](virtual-agents.md).

PR #157 (merge `b14faa1a`) promoted the chat-first shell to `main`. So those files are no longer tester-only. A fix to them is still a pull request to `main`. The one switch back to the mode screens is `SHELL_LAYOUT` (`packages/core/src/agents/product-modes.ts:29`). The "Tester shared file" notes in `lanes.json` describe the state before the merge.

## After a pull request merges to `main`

Run these in order. A fix is not done for a lane until its step has run. The pull request says which lanes are still owed.

1. **Tester.** In `C:\Users\rizky\agentforge-chat`: `git status` clean, `git fetch origin`, `git merge origin/main`, `pnpm install --frozen-lockfile`, `ci:local`. On a conflict keep the `main` side of any fix. If both cannot be kept, `git merge --abort` and ask Rizky.
2. **Enterprise.** Only when Rizky says release (`node scripts/release-web.mjs`). Personal has no step. A release never implies a sync, and a sync never implies a release.

## Guards

Two kinds of guard. The first is on `main` today. The second is added on branch `chore/agent-guardrails` and is not on `main` yet; it is named by file, not by line, because another change is writing it.

On `main` today:

- `scripts/lane-guard.mjs` (`pnpm lane-guard`) reads `lanes.json` and prints three kinds of warning: `map` (code under a `lanes.json` glob changed, and none of its map pages did), `protected` (a protected file changed and no commit in the range has a `Lanes:` line), `brand` (a brand literal rose in shared code past `scripts/lane-guard.baseline.json`). It exits 0 unless `--strict`.
- `ci:local` runs `lane-guard` with `--strict` as an advisory step (`scripts/ci-local.mjs`). A warning shows in the table as `warn` and never fails the run.
- `scripts/map-rot.mjs` (`pnpm maps:check`) checks that cited `file:line` paths exist.

Added on branch `chore/agent-guardrails` (not on `main` yet):

- `scripts/where-am-i.mjs` (`pnpm where`): prints the folder, branch and lane, and matches them to a row in `AGENTS.md` "Where am I?". Until it lands, the two git commands `git rev-parse --show-toplevel` and `git branch --show-current` do the same check by hand.
- `lanes.json`, never-promote list: paths that exist only in the tester and must not appear in a diff to `main`. `scripts/lane-guard.mjs` reads it. `.claude/rules/` is the one part of `.claude/` that is tracked on `main` (the pstack model rule, `.gitignore` un-ignores it), so the list names every other part of `.claude/` instead of the whole folder; `scripts/lane-guard.test.mjs` fails if a listed glob matches any file tracked on `main`.
- `scripts/lane-guard.mjs` strict rules: the never-promote list, the `Lanes:` line on protected files, and brand literals in shared code. Read the script for the exact rule.
- `scripts/hooks/pre-push`, installed by `scripts/install-hooks.mjs`: a git pre-push hook. Read the hook for its exact checks.
- `scripts/release-web.mjs` and `apps/desktop/scripts/release-desktop.mjs` refuse to run from any branch other than `main`.

## Where things live

| Thing | Where |
|---|---|
| The rules | `AGENTS.md`: "Where am I?", "Where a change goes", "Lanes" |
| The sequence for any change | `.cursor/skills/change-agentforge/SKILL.md`; the worker preamble is `preamble.md` beside it |
| Which path reaches which lane, which files the tester also edits | `lanes.json`; `scripts/lane-guard.mjs` |
| Where am I (folder, branch, lane) | `pnpm where` (`scripts/where-am-i.mjs`, on `chore/agent-guardrails`) |
| Tester rules | `TESTER.md`, identical on `main` and `tester/chat-first`; it applies only in the tester branch |
| The tester split in full | vault `40-Dev/nultron-two-codes-map.md` |
| Brand of the desktop flavors | `apps/desktop/branding/<brand>/brand.json` (local and gitignored; the tracked `agentforge` kit was deleted on 2026-11-06) |
| Hosted differences by setting | `PORTAL_SIGNIN_MODE` (portal) |
| Preview safe update | `nultron-files/deploy/tencent/README.md`, "Update the app image only: the safe route" |

## Gotchas

- **Shared code reads `gatewayName`.** A hard-coded `Toko Token` in shared code is a brand-rule finding in `pnpm lane-guard`, and the baseline is the ratchet. `Nultron` is no longer checked (2026-10-17).
- **Deploy modes are not forks.** Nultron uses its direct two-name setup, with no Cloudflare edge. Password sign-in is the default of the Nultron bundle since 2026-10-09 (`portal.env.example` sets `PORTAL_SIGNIN_MODE=password`; the e-mailed code stays selectable).
- **Published wins.** If the tester and `main` disagree, `main` stands and the tester code adapts. Tester work reaches `main` only through a promotion pull request Rizky approves.
- **Personal is retired, not deleted.** Its code is still in the tree, so a change that touches it still goes through `main`. No lane is owed a sync for it.
- **A fix is not done until each lane has run its step.** The pull request lists the lanes still owed.
