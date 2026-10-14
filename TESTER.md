# Tester rules (apply only in the tester folder)

These rules apply only when `git branch --show-current` prints `tester/chat-first` in `C:\Users\rizky\agentforge-chat`. In `C:\Users\rizky\agentforge` (branch `main`) and in any worktree cut from `main`, they do not apply: that code is the published code, and its rules are in `AGENTS.md`. This file is kept identical on `main` and `tester/chat-first`, so a merge never fights over it.

Rizky's rule, 2026-10-06, must follow: Nultron is kept as two codes.

- **Published:** `C:\Users\rizky\agentforge`, branch `main`. Nultron as released, with the mode screens. HYP AI is built from it.
- **Tester:** `C:\Users\rizky\agentforge-chat`, branch `tester/chat-first`. Chat only, with the modes running behind the chat as workers.

The full map is in Rizky's Obsidian vault at `C:\Users\rizky\Documents\Obsidian\40-Dev\nultron-two-codes-map.md`. It says which change goes where, which files the tester may edit, and how to update. Read it before editing in `C:\Users\rizky\agentforge-chat`.

## The short version

- A problem that shows on the published webdev at `:3000` is fixed in `agentforge` on `main`, then merged into `C:\Users\rizky\agentforge-chat`. It is never fixed by hand in both.
- A problem that shows only in the tester, on `:3200`, is fixed in `C:\Users\rizky\agentforge-chat`.
- Changes move one way, from `main` into `tester/chat-first`: `git fetch origin` then `git merge origin/main`.
- Never merge or cherry-pick `tester/chat-first` into `main`. Tester work reaches `main` only through a pull request Rizky approves.
- Never run a release command from `C:\Users\rizky\agentforge-chat`.
- The tester's webdev uses port 3200 and the data folder `.webdev-data-chat`. It never shares a database with `:3000`.

## Priority when the two disagree

Published wins (Rizky, 2026-10-06).

1. A bug in the public version is fixed first, on `main`.
2. In a merge conflict, keep the published side of the line. Never drop or weaken a fix from `main`.
3. Then rebuild the chat-only behaviour on top of it, by changing the tester code.
4. A security or data-safety fix beats a feature on both sides.
5. If both cannot be kept and the answer is not obvious, run `git merge --abort` and ask Rizky.

A file that exists only in the tester has no published version, so the tester copy stands. Edit shared files as little as possible.

## Staging instance

The tester is the staging code at every stage (Rizky, 2026-10-14). New work is driven on the staging instance before a promotion pull request to `main`.

- **Nultron:** the tester's staging subdomain (name pending). Rizky will give the name.
- **HYP AI:** HYP AI as a whole is still in the tester stage. Rizky, 2026-10-14: "the current stage are all still tester". Its server, `aiopc.innovationhypernet.com`, is not yet production.
- **Open, for Rizky:** HYP AI still imports from `main` per `C:\Users\rizky\hypey\intake\SYNC.md`. Whether that changes is Rizky's call. Nothing here changes it.

## What the tester is building

- [`docs/internal/chat-first-plan.md`](docs/internal/chat-first-plan.md)
- [`docs/internal/chat-workers-spec.md`](docs/internal/chat-workers-spec.md)
- [`docs/internal/model-tiers-spec.md`](docs/internal/model-tiers-spec.md)
- [`docs/internal/chat-computer-spec.md`](docs/internal/chat-computer-spec.md)
- [`docs/internal/team-board-spec.md`](docs/internal/team-board-spec.md) (design only: the team board, each person's own agent, the company and personal agent stores)
