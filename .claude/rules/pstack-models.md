# pstack model configuration. One line per role. Delete a line to fall back to the skill default.
# Same file in three places, keep them identical: ~/.claude/rules/ (every Claude Code project), ~/.grok/rules/ (Grok sessions), and a project's .claude/rules/ (cloud threads of that repo).
# The main chat (parent) is Claude Opus 5.5. Each role value is `<model> <effort>`; a list spawns one subagent per entry.
# How to spawn each model inside T3 Code (call `orchestrator_capabilities` once per thread before the first `delegate_task`):
# - `sonnet`, `opus` (Claude): native `Agent` tool with `model: "<name>"` and `effort: "<effort>"`. Efforts: low, medium, high, xhigh, max. A background worker goes through `delegate_task` with `{ providerInstanceId: "claudeAgent", model: "claude-sonnet-5-5", options: { effort: "<effort>" } }`.
# - `fable` (Claude Fable 5.2): `delegate_task` with target `{ providerInstanceId: "claudeAgent", model: "claude-fable-5-2", options: { effort: "xhigh" } }`, never the native `Agent` tool, because a native subagent cannot start its own children.
# - `grok-4.7`: `delegate_task` with target `{ providerInstanceId: "grok", model: "grok-4.7", options: { reasoningEffort: "<effort>" } }`. Efforts: low, medium, high, xhigh.
# - `opencode-go/deepseek-v4.1-flash`: `delegate_task` with target `{ providerInstanceId: "opencode", model: "opencode-go/deepseek-v4.1-flash", options: { variant: "max" } }`. Always max (owner's choice), on every budget.
# - `gemini-4-argon`, `gemini-3.8-flash`: `delegate_task` with target `{ providerInstanceId: "antigravity", model: "<slug>", options: { thinking_level: "<effort>" } }`. Efforts: low, medium, high.
# In a non-Claude host (Grok), spawn every model with `delegate_task`; the Claude models use providerInstanceId `claudeAgent` with model `claude-opus-5-5` or `claude-sonnet-5-5` and options `{ effort }`.
# When pstack raises or lowers a role's effort, clamp to the nearest effort that model lists and keep the model. DeepSeek never moves off max.
# Families: claude = opus, sonnet, fable; grok; deepseek; gemini.
# Owner override (2026-11-10): `opus` is the first arena cross-judge even though the parent is Opus. Skip the different-family check for that entry.
#
# Who does what (owner, 2026-11-10, revised the same day because Grok is slow):
# - Opus 5.5 is the main chat the owner talks to. It plans, briefs, reviews and verifies.
# - Sonnet 5.5 is the worker for hard or long-running work: features, bug fixes, refactors, perf work, and the hardest code.
# - DeepSeek V4.1 Flash is the fast, cheap, general worker: explorers, investigations, swarms, hillclimb loops, and any task with few dependencies.
# - Gemini 4 Argon is the reliable worker with the better writing: prose, docs, copy, synthesis.
# - Grok 4.7 is slow and expensive. It takes no worker tasks. It keeps one seat on the arena cross-judge pool and the interrogate panel, which run in parallel and only read.
# - Gemini 3.8 Flash is not a pstack role. Send it screenshots, mockups and visual requirements to analyse, at `high`.
# - Fable 5.2 only judges and advises. It never writes code or edits files.
# How to pick a worker: hard, long-running, or many parts depend on it → `sonnet xhigh`. Small, few dependencies, or exploration → `opencode-go/deepseek-v4.1-flash max`. Docs and copy → `gemini-4-argon high`.
#
# Fable is for important work only: a security-sensitive change, or a feature or bug fix that many other parts of the code depend on. Everything else runs without Fable.
# Fable lead flow for that work:
# 1. The parent runs `how explorer` subagents first to map the code involved.
# 2. The parent spawns Fable (target above). Its task carries the intent and the explorer reports, and says it must delegate the work, not do it.
# 3. Fable judges the approach and the risks, splits the work, and delegates every piece with `delegate_task`: `sonnet xhigh` for the hardest, long-running or highest-dependency code, `opencode-go/deepseek-v4.1-flash max` for small pieces with few dependencies, `gemini-4-argon high` for docs and copy. When a report leaves a gap, it runs another explorer (`opencode-go/deepseek-v4.1-flash max`) before it decides. It does not give code to Grok.
# 4. Fable reviews each result against its plan, sends needed fixes to a fresh worker, and reports its verdict to the parent.
# If Fable cannot start children, it returns the plan with a model per piece. The parent delegates exactly that plan, then hands the results back to Fable to judge.
# On that same important work, add `fable xhigh` to the interrogate reviewers. As a reviewer Fable reads and runs read-only checks only.
#
# `inherit-parent` or `auto` as a value: the role runs on the parent chat model (omit `model`). Alias entries in a panel list still count toward its fan-out.
# budget: large (xhigh). DeepSeek stays at max. Gemini's highest effort is high.
feature, refactoring: sonnet xhigh
bug-fix: sonnet xhigh
perf-issue: sonnet xhigh
hillclimb: opencode-go/deepseek-v4.1-flash max
judgment and prose: gemini-4-argon high
hardest tasks: sonnet xhigh
how explorer: opencode-go/deepseek-v4.1-flash max
how explainer: gemini-4-argon high
why investigators: opencode-go/deepseek-v4.1-flash max
why synthesizer: gemini-4-argon high
reflect tooling: sonnet xhigh
reflect judgment, divergent, synthesizer: gemini-4-argon high
arena runners: sonnet xhigh, gemini-4-argon high, opencode-go/deepseek-v4.1-flash max
arena cross-judge pool: opus xhigh, gemini-4-argon high, grok-4.7 xhigh
swarm workers: opencode-go/deepseek-v4.1-flash max
architect runners: sonnet xhigh, gemini-4-argon high, opencode-go/deepseek-v4.1-flash max
interrogate reviewers: gemini-4-argon high, grok-4.7 xhigh, opencode-go/deepseek-v4.1-flash max
