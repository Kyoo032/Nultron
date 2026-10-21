# pstack model configuration. One line per role. Delete a line to fall back to the skill default.
# Values are `<model> <effort>` (Claude Code `Agent` tool: model is opus, sonnet, haiku or fable). `inherit-parent` or `auto` as a value: the role runs on the parent chat model (omit `model`). Alias entries in a panel list still count toward its fan-out.
# budget: large (xhigh)
feature, refactoring: sonnet xhigh
bug-fix: sonnet xhigh
perf-issue: opus xhigh
hillclimb: opus xhigh
judgment and prose: opus xhigh
hardest tasks: opus xhigh
how explorer: haiku medium
how explainer: opus xhigh
why investigators: sonnet xhigh
why synthesizer: opus xhigh
reflect tooling: sonnet xhigh
reflect judgment, divergent, synthesizer: opus xhigh
arena runners: opus xhigh, fable xhigh
arena cross-judge pool: opus xhigh, fable xhigh
swarm workers: sonnet xhigh
architect runners: opus xhigh, fable xhigh
interrogate reviewers: opus xhigh, fable xhigh
