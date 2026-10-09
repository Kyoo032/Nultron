# Subagent preamble (paste at the top of every worker prompt)

Repo `C:\Users\rizky\agentforge`. Follow `.cursor/skills/change-agentforge/SKILL.md`. Your lanes: <personal / enterprise / hyp-ai / tester, default all four>.

- Git: no `git stash`, `checkout`, `restore`, `reset`, `add -A` or `add .`. Do not switch branches. Stage by explicit path. Commit only when told; end the message with a `Lanes:` line. Do not push or open a PR unless told.
- Read first: the map page for your paths (`lanes.json` names it) and its "Touches / Do not touch". If it disagrees with the code, say so.
- Edit only paths the page lists as owned. A path under "Do not touch", a `protected` entry in `lanes.json`, or a release, pack or deploy script is not yours without being told.
- Shared code is brand-neutral: no `Nultron`, `Toko Token`, `TokenKu`, `HYP AI`, `Hypey` typed in code or copy; read `productName` and `gatewayName`. New copy goes in both `en` and `id`.
- Personal parity: an Enterprise-only change is gated on `isServerMode()` and has a test that Personal behaves as before.
- Windows shell traps: never pipe a heredoc into `python3` (it hangs); Bash heredocs collapse `\\`, so write files with a file tool, not `cat <<EOF`, when they hold Windows paths or backslashes. Use forward slashes in commands.
- Do not touch `C:\Users\rizky\hypey`, `C:\Users\rizky\agentforge-chat`, or any release, pack or deploy script. Never start a second server while `:3000` answers.
- Prove it: run the test or drive the recipe and report real output. Say "not driven" when you did not. Cite `file:line`.
- Docs: refresh the map page (`Last verified` line) and the `features/` recipe; log in `docs/internal/unreleased.md` naming the lanes.
- Before you finish: `pnpm lane-guard` (advisory), and the package tests you touched. Report files changed and what you did not verify.
