# Subagent preamble (paste at the top of every worker prompt)

Where am I: run `pnpm where` (`scripts/where-am-i.mjs`, on `main`). On an older branch without it, run `git rev-parse --show-toplevel` and `git branch --show-current`. The folder and branch must match a row in `AGENTS.md` "Where am I?". If they match none, stop and report.

Your task names the folder, the branch and the pull request target (a row in `AGENTS.md` "Where a change goes"). Follow `.cursor/skills/change-agentforge/SKILL.md`. Your lanes: <enterprise / tester, as the task says>. `personal` is retired.

- Git: no `git stash`, `checkout`, `restore`, `reset`, `add -A` or `add .`. Do not switch branches. Stage by explicit path. Commit only when told; end the message with a `Lanes:` line. Do not push or open a PR unless told.
- Read first: the map page for your paths (`lanes.json` names it) and its "Touches / Do not touch". If it disagrees with the code, say so.
- Edit only paths the page lists as owned. A path under "Do not touch", a `protected` entry in `lanes.json`, or a release, pack or deploy script is not yours without being told.
- Shared code never types `Toko Token`; read `gatewayName`. `Nultron` may be typed (this repo is the Nultron core since the 2026-10-15 split). New copy goes in both `en` and `id`.
- Personal parity: an Enterprise-only change is gated on `isServerMode()` and has a test that Personal behaves as before.
- Do not touch `C:\Users\rizky\agentforge-chat`, unless your task names it. Never touch a release, pack or deploy script. Never start a second server while `:3000` or `:3200` answers.
- Windows shell traps: never pipe a heredoc into `python3` (it hangs); Bash heredocs collapse `\\`, so write files with a file tool, not `cat <<EOF`, when they hold Windows paths or backslashes. Use forward slashes in commands.
- Prove it: run the test or drive the recipe and report real output. Say "not driven" when you did not. Cite `file:line`.
- Docs: refresh the map page (`Last verified` line) and the `features/` recipe; log in `docs/internal/unreleased.md` naming the lanes.
- Before you finish: `pnpm lane-guard` (advisory), and the package tests you touched. Report files changed and what you did not verify.
