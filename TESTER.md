# This folder is the tester code

Rizky's rule, 2026-10-06, must follow: Nultron is kept as two codes.

- **Published:** `C:\Users\rizky\agentforge`, branch `main`. Nultron as released, with the mode screens. HYP AI is built from it.
- **Tester:** this folder, `C:\Users\rizky\agentforge-chat`, branch `tester/chat-first`. Chat only, with the modes running behind the chat as workers.

The full map is in Rizky's Obsidian vault at `C:\Users\rizky\Documents\Obsidian\40-Dev\nultron-two-codes-map.md`. It says which change goes where, which files this folder may edit, and how to update. Read it before editing here.

## The short version

- A problem that shows on the published webdev at `:3000` is fixed in `agentforge` on `main`, then merged into this folder. It is never fixed by hand in both.
- A problem that shows only here, on `:3200`, is fixed here.
- Changes move one way, from `main` into this branch: `git fetch origin` then `git merge origin/main`.
- Never merge or cherry-pick this branch into `main`. Tester work reaches `main` only through a pull request Rizky approves.
- Never run a release command from this folder.
- This folder's webdev uses port 3200 and the data folder `.webdev-data-chat`. It never shares a database with `:3000`.

## Priority when the two disagree

Published wins (Rizky, 2026-10-06).

1. A bug in the public version is fixed first, on `main`.
2. In a merge conflict, keep the published side of the line. Never drop or weaken a fix from `main`.
3. Then rebuild the chat-only behaviour on top of it, by changing the tester code.
4. A security or data-safety fix beats a feature on both sides.
5. If both cannot be kept and the answer is not obvious, run `git merge --abort` and ask Rizky.

A file that exists only here has no published version, so this folder's version stands. Edit shared files as little as possible.

## What this folder is building

- [`docs/internal/chat-first-plan.md`](docs/internal/chat-first-plan.md)
- [`docs/internal/chat-workers-spec.md`](docs/internal/chat-workers-spec.md)
- [`docs/internal/model-tiers-spec.md`](docs/internal/model-tiers-spec.md)
- [`docs/internal/chat-computer-spec.md`](docs/internal/chat-computer-spec.md)
- [`docs/internal/team-board-spec.md`](docs/internal/team-board-spec.md) (design only: the team board, each person's own agent, the company and personal agent stores)
