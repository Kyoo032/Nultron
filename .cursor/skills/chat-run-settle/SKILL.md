---
name: chat-run-settle
description: Formal check (TLA+, TLC) of how a Chat run ends when the stall watchdog, a closed connection and the model's own completion race. Use it before you change startModalityRun in packages/host/src/runs.ts (settleRun, onStall, onClientAbort, meterSettledRun, persistAssistant, the run.completed handler, the catch path), finishRun in packages/host/src/threads.ts, recordChatRunUsage in packages/host/src/usage-record.ts, or the database driver in packages/db/src/client.ts, and after any merge that touched them.
---

# Chat run settle: formal check

A Chat run can be ended three ways at once: the stall watchdog fires, the person's connection closes, or the model finishes. This check proves, for every order those can happen in, that the run ends the way the code promises. It is a TLA+ model run by the TLC model checker. It is not the `verify-agentforge` skill, which drives the app.

## What it proves

| Property | In plain words | The harm if it breaks |
| --- | --- | --- |
| `FailedRowHasNoAnswer` | A run marked `failed` never has a saved assistant answer. | The person was told the run failed, yet the thread shows an answer, and a retry asks twice. |
| `AtMostOneUsageRow` | A run writes at most one usage row. | The desk is billed twice for one answer. |
| `BilledIsMetered` | A run the gateway billed writes exactly one usage row once everything settles. | The desk gets a model answer the ledger never charged. |
| `EndsSettled` | Once everything settles, no run row is left `streaming`. | The run shows as running forever, as was observed under a hung gateway (`runs.ts:246-247`). |
| `NoFailureAfterSuccess` | The person never gets `run.failed` after the success end of the same run. | The screen shows an answer, then an error for the same turn. |
| `Termination` | Every run reaches its end. | A hung model call keeps a run, and its run slot, open for good. |

Scope: one run, one settle (a second is a no-op because `queueClosed` is already true), and three model outcomes: it answers, it fails, or it hangs.

## Run it

```bash
node scripts/formal/chat-run-settle.mjs
```

It needs Java 11 or later and TLC 1.7.4, pinned by sha256 in the script. The script looks for the jar at `~/.cache/nultron-formal/tla2tools-1.7.4.jar`, or at `TLA2TOOLS_JAR`. If it is missing, the script prints the one `curl` line that fetches it and exits 3. A run takes about two seconds.

GitHub publishes no digest for that release asset, so the pinned hash is from the copy this check was built with. Its size matches the v1.7.4 release asset (2,274,532 bytes), and its banner reads `TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)`. If a fresh download hashes differently, stop and find out why before you change the pin.

The script first reads the covered code and prints twelve switches, one per guard or call the model depends on, then runs TLC with those values. So when a change removes one of those twelve sites, the check runs as if it were removed, with no edit to the model. A change anywhere else in the covered code is not read, so check it against the table below by hand.

- `PASS`: every property holds for every order of events in the model.
- `FAIL: <names>`: TLC found an order of events that breaks those properties. The counterexample is printed above the line.
- `DRIFT`, exit 2: an anchor the script reads in the code is gone. The covered code changed shape, and the model must be re-derived before any result means anything.

Two more modes:

- `--break <Switch>` forces one guard off, to show the check can still fail. Use it after every update to the model.
- `--hazard` assumes a database driver whose calls yield to timers and sockets, such as Postgres. It checks each property in its own run and lists the ones that break. Run it before any move off `better-sqlite3`.

## Reading a failure

Read every TLC result with the pstack `/statechart` skill. It turns a violation into its shortest path in plain words, and draws the state chart when the check passes.

Then replay the path against the code, step by step, with the table below. If a step cannot happen in the code, the model is wrong, so fix the model and say what was wrong. If every step can happen, it is a bug in the code. Report the steps in the code's words, the harm, and the commit that introduced it. Do not weaken a property or the model to make it pass, and do not change product code unless the person asks.

## How the model maps to the code

Line numbers are as of the sync commit below.

| Model | Code |
| --- | --- |
| `Settle` (watchdog or closed connection) | `onStall` at `packages/host/src/runs.ts:270` and `onClientAbort` at `:281`, both calling `settleRun` at `:256`. The abort that landed before the listener existed is `:295`, the `Settle` from `"start"`. |
| `settled`, `queueClosed` | The flags set by `settleRun` and `closeQueue` in `runs.ts` |
| `CancelFinish` | The fire-and-forget `finishRun(..., "failed")` inside `settleRun`. It is its own step only when `DbYields` is true. |
| `StoreUser`, `InsertRun` | `insertMessage(..., "user", ...)` at `:382` and `insertRun` at `:390`, then the `if (settled)` at `:392` |
| `FinishAfterInsert` | `finishRun(..., "failed")` at `:394` |
| `"model"` with `ModelAnswers`, `ModelFails`, `ModelAborted` | `runtime.execute` inside `attempt()`, awaited at `:658`, and its `run.completed` and `run.failed` events. `ModelAborted` is `modelAbort.abort()` making the call reject. |
| `ModelAnswers` when settled | The `if (settled)` in the `run.completed` handler at `:581`, which meters and drops the answer |
| `PersistEv` | `await persistAssistant()` and `send(event)` in the same handler |
| `AfterAttempt` | The `if (settled)` between the last `await attempt()` (`:674`) and `finishRun(..., "completed")` (`:682`) |
| `PersistFinal`, `FinishCompleted`, `AfterFinish` | `persistAssistant()`, `finishRun(..., "completed")` at `:682` with `recordChatRunUsage`, then the knowledge tail before the `finally` at `:762` |
| `Catch`, `CatchFinish` | The `catch` at `:727` with its `if (settled)`, then `persistAssistant()` at `:733` and `finishRun` with `status` |
| `MeterOk` | `meterSettledRun` at `:323` and its `settledRunMetered` flag |
| `Applies`, `FinishTo` | `finishRun` at `packages/host/src/threads.ts:311`, which updates only a `streaming` row (`:326`) |
| `metered` | `recordChatRunUsage` at `packages/host/src/usage-record.ts:259`, which writes only when `finished` |

The switches the script reads, and where:

| Switch | True when |
| --- | --- |
| `DbYields` | `packages/db/src/client.ts` does not use `drizzle-orm/better-sqlite3` |
| `StallGuard` | `runs.ts` arms `armRunStallGuard({` and `onStall` calls `settleRun(message)` |
| `GuardAfterInsert` | `runId = run.id;` is followed by `if (settled) {` |
| `GuardOnCompleted` | The `run.completed` handler has `if (settled) {` before `await persistAssistant();` |
| `GuardAfterAttempt` | `if (settled) {` sits between the last `await attempt();` and `finishRun(..., "completed")` |
| `GuardInCatch` | The `catch` before `const saved = await persistAssistant();` starts with `if (settled) {` |
| `SettleFinishes` | `settleRun` calls `finishRun(options.tenant, runId, "failed"` |
| `FinishOnlyFromStreaming` | `finishRun` filters on `eq(runs.status, "streaming")` |
| `MeterOnce` | `meterSettledRun` checks and sets `settledRunMetered` |
| `MeterOnFinish` | `recordChatRunUsage(options.tenant, run.id, finished, runUsage)` follows `finishRun(..., "completed")` (`:686`) |
| `MeterOnSettledCompletion` | The settled branch of the `run.completed` handler calls `meterSettledRun();` (`:588`) |
| `MeterAfterAttempt` | The `if (settled)` after the model call calls `meterSettledRun();` (`:678`) |

`:588` and `:678` back each other up. Removing either one alone still passes, and removing both breaks `BilledIsMetered`.

Each property fails when the code it guards is broken:

| `--break` | Fails |
| --- | --- |
| `GuardAfterInsert`, `SettleFinishes` | `EndsSettled` |
| `GuardOnCompleted`, `GuardAfterAttempt`, `GuardInCatch` | `FailedRowHasNoAnswer` |
| `MeterOnce` | `AtMostOneUsageRow` |
| `MeterOnFinish`, or both `MeterOnSettledCompletion` and `MeterAfterAttempt` | `BilledIsMetered` |
| `StallGuard` | `Termination` |
| `--hazard` | `FailedRowHasNoAnswer`, `NoFailureAfterSuccess`, `BilledIsMetered` |

`NoFailureAfterSuccess` fails only under `--hazard`, because with today's driver nothing can cut in between the success end and the end of the run.

## The assumption that makes it hold

The product database uses `better-sqlite3`, so every `await db...` finishes in microtasks, before any timer or socket event can run. The watchdog and a closed connection can therefore cut in only while the run waits on the network: before the work starts, or during the model call. The model encodes this. `Settle` is enabled only at `"start"` and `"model"`, unless `DbYields` is true.

With a driver that yields (`--hazard`), three properties break: `FailedRowHasNoAnswer`, `NoFailureAfterSuccess` and `BilledIsMetered`. The shortest break is this: the model answers, the host starts saving it, the watchdog fires during the save, the row is marked `failed`, and the save then lands. Moving the product database off SQLite (open decision 1, K-D9 in `AGENTS.md`) must fix these first, for example by re-checking `settled` after each awaited write or by moving the decision into one database transaction.

## What it does not cover

- The fallback retry on a second model (`heldNext`, `:664`) is folded into the one `"model"` wait.
- Tool calls, media mirroring, tool invocation rows, knowledge ingestion and retrieval counts are left out.
- Frames are reduced to `failed`, the success end `ok`, and the closing `end`. Deltas and thinking frames are not modeled.
- A run that broke after saving partial text and ends `completed` is modeled for the `answer` outcome only.
- `FinishOnlyFromStreaming` is mirrored, but no property fails when only it is removed, in either database mode. Its job is defense in depth.
- The meter calls on the catch path (`:729` and `:739`) are not modeled. No modeled path reaches the catch with a billed call, because a billed call ends in `run.completed`.
- The hosted run cap (`packages/host/src/run-limits.ts`) and the desktop IPC transport are out of scope, though both reach this same code.

## Keep it in step with the code

Coverage: `startModalityRun` in `packages/host/src/runs.ts`, `finishRun` in `packages/host/src/threads.ts`, `recordChatRunUsage` in `packages/host/src/usage-record.ts`, and the driver import in `packages/db/src/client.ts`.

Sync commit: `b826a870`. At this commit the model was confirmed to describe the covered code. The covered files last changed at `464b00c5`.

To check whether the verification needs another look:

```bash
git log --oneline b826a870..HEAD -- packages/host/src/runs.ts packages/host/src/threads.ts packages/host/src/usage-record.ts packages/db/src/client.ts
```

When a change to covered code is intended:

1. Read the diff against the table above. Decide whether it changes the shape (a new await on the network, a guard moved, a new path to `finishRun` or `insertMessage`) or the promise (a property itself, with evidence in the change).
2. Update the model, and the anchors in `scripts/formal/chat-run-settle.mjs` if their text moved. Write the update from the code, not from what makes the check pass.
3. Run the check. Then run `--break` on the guard nearest your change, and confirm it fails.
4. Update the table, the line numbers and the sync commit here. Move the sync commit only after you confirm the model describes the code at the new commit.

For drift that built up across merges, use `/maintain-formal-verification-skill`.
