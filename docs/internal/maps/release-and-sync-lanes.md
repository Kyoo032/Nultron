# Release and sync lanes

Last verified: 2026-10-14 at 9e77ccda. The Workspace knowledge (W1) section and the `lanes.json` entries it names were read from the tester tree over that commit. The Chat-first shell section was last read at e8a7eca8 (2026-10-12), and the rest of the page at cc346b0c (2026-10-09). Neither was re-read in this pass.

## Overview

One source repo (`Kyoo032/agentforge`, branch `main`) feeds four lanes: Nultron Personal, Nultron Enterprise, HYP AI and the tester code. This page says how a fix made on `main` reaches each lane, what each lane may differ in, and what has to be true before a lane counts as fixed. It is the working form of the "Two codes" and "Sync lanes" rules in `AGENTS.md`; the longer story of the tester split is in Rizky's vault note `40-Dev/nultron-two-codes-map.md`. It does not cover how a release is cut (see [`desktop-pack-routes.md`](desktop-pack-routes.md) and the "Web release" section of `AGENTS.md`).

## Chat-first shell (2026-10-12)

The tester added 16 `protected` entries (32 in all) to `lanes.json`: the shared files it edits (the composer, the rail, `product-modes.ts`, `i18n.ts` and others) and its own paths (`virtual-agents*`, `packages/host/src/workers/**`, the agent components), whose map is [`virtual-agents.md`](virtual-agents.md). Once PR #157 merges, `main` carries the chat-first shell, so those files are no longer tester-only: a fix to them is still a pull request to `main`, and the one switch back to the mode screens is `SHELL_LAYOUT` (`packages/core/src/agents/product-modes.ts:29`). The "Tester shared file" notes in `lanes.json` describe the state before the merge.

## Workspace knowledge, W1 (2026-10-14)

Two `lanes.json` entries cover the tester's first Workspace slice (team board W1, [`team-board-spec.md`](../team-board-spec.md) section 2b). Both map to [`knowledge-flows.md`](knowledge-flows.md).

- **Projects, tester only.** The entry for `packages/db/src/projects-schema*.ts`, `packages/host/src/projects/**`, `packages/host/src/handlers/projects.ts` and the projects tests has `lanes: ["tester"]` and `protected: false`. Collective projects run in server mode only, and the routes answer the router's 404 on Personal (`lanes.json`, note on that entry).
- **Knowledge, all four lanes.** The entry for the knowledge backend, retrieval, `knowledge-search-tool.ts`, `run-context.ts`, `threads.ts`, its handler and the two db schema files has `lanes` for all four and `protected: true`. A source may carry a `project_id`, and retrieval takes a `projectId` scope that `knowledge_search` reads from the run context. The note on the entry says Personal writes no `project_id`, so its SQL and answers do not change.

**Coverage (added 2026-10-14).** Each file the W1 slice touched has its own `lanes.json` entry. The projects renderer is tester only. The Chat document cards, Add to Workspace, the tool-row reader, the chip's kept original and its hook are tester only. `composer-attachment-chip.tsx` and `composer-documents.ts` are on `main`, so they are protected and reach all four lanes. `packages/host/src/doc-tools/**` and `chat-documents/original.ts` are tester only. Whether a file is on `main` was read with `git ls-tree main`. A file with no narrower entry still falls under the broad `apps/web/**` and `packages/host/**` entries, which name no map, so `lane-guard` raises no map warning for it.

## How it works

A fix starts as a pull request to `main` from a branch cut from `main`. Nothing is fixed first in the tester folder or the HYP AI clone, because both would then hold a change `main` does not have, and the next sync would conflict or drop it.

| Lane | Folder or repo | Built or released by | Takes a fix by |
|---|---|---|---|
| Nultron Personal | `agentforge`, `main` | `pnpm desktop:build`, then `pnpm desktop:release` (`apps/desktop/scripts/release-desktop.mjs`) to `Kyoo032/Nultron` | the next pack |
| Nultron Enterprise | `agentforge`, `main` | `node scripts/release-web.mjs` to `Kyoo032/NultronEnt`; the preview at `app.nultron-ai.xyz` by its safe desk-by-desk update | the next release or preview update |
| HYP AI | `C:\Users\rizky\hypey\app`, a git repo with no remote | its own bundle in `C:\Users\rizky\hypey\deploy` | vendor-branch import, `C:\Users\rizky\hypey\intake\SYNC.md` |
| Tester | `C:\Users\rizky\agentforge-chat`, `tester/chat-first` | never released | `git merge origin/main` |

After a pull request merges to `main`:

1. **Tester.** In the tester folder: `git status` clean, `git fetch origin`, `git merge origin/main`, `pnpm install --frozen-lockfile`, `ci:local`. Conflicts: keep the `main` side of any fix. If both cannot be kept, `git merge --abort` and ask Rizky.
2. **HYP AI.** Follow `SYNC.md`: stop the demo server on :3301, `commit-upstream.mjs <sha>` imports the sha onto the clone's `upstream` branch, `git merge upstream`, then `check-leaks.sh` for any new string that says Nultron, Toko Token or DPSBuddy, then `drive-leaks.mjs` against the running demo, then add a row to the sync history. The clone's last import was `e8a069c9` (recorded in `intake/SOURCE_SHA`), so it is behind everything merged since 2026-10-07.
3. **Personal and Enterprise.** Only when Rizky says release. A release never implies a sync, and a sync never implies a release.

## Where things live

| Thing | Where |
|---|---|
| The rule | `AGENTS.md`, "Two codes" and "Sync lanes" |
| Which path reaches which lane, which files the tester also edits | `lanes.json` at the repo root; `pnpm lane-guard` (`scripts/lane-guard.mjs`) warns, advisory; the sequence is `.cursor/skills/change-agentforge/SKILL.md` |
| The tester split in full | vault `40-Dev/nultron-two-codes-map.md`, and `agentforge-chat/TESTER.md` |
| HYP AI sync steps and history | `C:\Users\rizky\hypey\intake\SYNC.md`, `SOURCE_SHA`, `hyp-brand.patch` |
| HYP AI leak checks | `intake/check-leaks.sh` (static), `intake/drive-leaks.mjs` (running demo) |
| Brand of the desktop flavors | `apps/desktop/branding/<brand>/brand.json` |
| Hosted differences by setting | `PORTAL_SIGNIN_MODE` (portal), the edge mode of the HYP AI bundle (`ship.ps1 -Cloudflare`) |
| Preview safe update | `nultron-files/deploy/tencent/README.md`, "Update the app image only: the safe route" |

## Gotchas

- **Brand strings arrive un-rebranded.** New upstream strings never conflict in the HYP AI merge, so a hard-coded `Nultron` or `Toko Token` in shared code ships to HYP AI unless `check-leaks.sh` catches it. Shared code reads `productName` and `gatewayName`.
- **Line endings.** The HYP AI import converts CRLF the same way the first import did (`core.autocrlf=true` in `commit-upstream.mjs`). Do not import with a plain copy and `git add`.
- **HYP AI keeps its own backend and mascot.** It maps every mascot state to the Hypey still and keeps its interim gateway host; a new upstream mascot state needs a manifest entry in the clone or its manifest test goes red.
- **Deploy modes are not forks.** The Cloudflare edge is HYP AI's deploy only; Nultron uses its direct two-name setup. Password sign-in is the default of both bundles since 2026-10-09 (the Nultron bundle's `portal.env.example` sets `PORTAL_SIGNIN_MODE=password`; the e-mailed code stays selectable), but each bundle sets it in its own files. Changes to one deploy path do not enter the other.
- **Published wins.** If tester and `main` disagree, `main` stands and the tester code adapts. Tester work reaches `main` only through a promotion pull request Rizky approves.
- **A fix is not done until each lane has run its step.** The pull request lists the lanes still owed.
