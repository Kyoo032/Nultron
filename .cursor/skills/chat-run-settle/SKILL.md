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
| `Termination` | Every run whose database writes return reaches its end. | A hung model call keeps a run, and its run slot, open for good. |
| `StreamEnds` | The person's stream always closes, even when a database write never returns. | The composer stays on Running with no message, and the hosted run slot stays taken. |

Scope: one run, one settle (a second is a no-op because `queueClosed` is already true), and three model outcomes: it answers, it fails, or it hangs. On a driver that yields, the run also picks one database wait that may never return (`hangAt`), or none.

`Termination` reads `hangAt = "none" => <>(pc = "done")`. On every behavior the model had before 2026-11-09, that is the old `<>(pc = "done")`. A run stuck on an `await` that never settles cannot reach its end whatever the code does, so `StreamEnds` is the promise for those runs.

## Run it

```bash
node scripts/formal/chat-run-settle.mjs
```

It needs Java 11 or later and TLC 1.7.4, pinned by sha256 in the script. The script looks for the jar at `~/.cache/nultron-formal/tla2tools-1.7.4.jar`, or at `TLA2TOOLS_JAR`. If it is missing, the script prints the one `curl` line that fetches it and exits 3. A run takes about two seconds.

GitHub publishes no digest for that release asset, so the pinned hash is from the copy this check was built with. Its size matches the v1.7.4 release asset (2,274,532 bytes), and its banner reads `TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)`. If a fresh download hashes differently, stop and find out why before you change the pin.

The script first reads the covered code and prints sixteen switches, one per guard or call the model depends on, then runs TLC with those values. So when a change removes one of those sixteen sites, the check runs as if it were removed, with no edit to the model. A change anywhere else in the covered code is not read, so check it against the table below by hand.

- `PASS`: every property holds for every order of events in the model.
- `FAIL: <names>`: TLC found an order of events that breaks those properties. The counterexample is printed above the line.
- `DRIFT`, exit 2: an anchor the script reads in the code is gone. The covered code changed shape, and the model must be re-derived before any result means anything.

Two more modes:

- `--break <Switch>` forces one guard off, to show the check can still fail. Use it after every update to the model.
- `--hazard` assumes a database driver whose calls yield to timers and sockets, such as Postgres, and lets one of those calls never return. It checks each property in its own run and lists the ones that break. Run it before any move off `better-sqlite3`, and after every change to covered code. Since 2026-11-09 it prints `PASS: nothing breaks`. Before the stand-down in `onStall` it printed `FAIL: StreamEnds`.

## Reading a failure

Read every TLC result with the pstack `/statechart` skill. It turns a violation into its shortest path in plain words, and draws the state chart when the check passes.

Then replay the path against the code, step by step, with the table below. If a step cannot happen in the code, the model is wrong, so fix the model and say what was wrong. If every step can happen, it is a bug in the code. Report the steps in the code's words, the harm, and the commit that introduced it. Do not weaken a property or the model to make it pass, and do not change product code unless the person asks.

## How the model maps to the code

Line numbers are as of the sync commit below.

| Model | Code |
| --- | --- |
| `Settle` (watchdog or closed connection) | `onStall` at `packages/host/src/runs.ts:273` and `onClientAbort` at `:294`, both calling `settleRun` at `:259`. The abort that landed before the listener existed is `:308`, the `Settle` from `"start"`. Neither settles while `finishing` is set: `onStall` takes its finishing branch (`:277-286`), which returns without `settleRun`, and `onClientAbort` returns (`:295`). That is the `~(CancelYieldsToClaim /\ finishing)` conjunct. |
| `StandDown` | The finishing branch of `onStall` (`:277-286`): the watchdog fires while the claim is held. It closes the queue (`:284`) and returns. It never calls `settleRun`, `finishRun` or `modelAbort.abort()`, so the row, the meter and `settled` are left to the run's own path. While the answer is not saved (`if (!persisted)`, `:278`) it sends `run.failed` with `chatTurnCopy(locale).saveTimeout`, unless the model already sent one (`failedMessage`), and then `run.completed`. The `outcome = "fail"` branch of `seen'` is that `failedMessage` check. |
| `hangAt` | One database `await` the run never resumes from, chosen once per run, and only when `DbYields` is true. `Work` stays disabled at that `pc`. The waits are those of `DbWaits`: the two writes before the model call, `finishRun` after `insertRun`, the assistant `insertMessage` (`:383`) from each of its three callers, `finishRun(..., "completed")` (`:694`), the `getThread` in the knowledge tail (`:720`) and the catch path's `finishRun` (`:748`). |
| `settled`, `queueClosed` | The flags set by `settleRun` and `closeQueue` in `runs.ts` |
| `persisted` | Set right after the assistant `insertMessage` returns (`:384`). It lives beside `finishing` (`:254`) so `onStall` can read it. |
| `finishing`, `Claim` | `finishing = true`, the first statement of `persistAssistant` (`:342`). Each call of `persistAssistant` follows an `if (settled)` check with no `await` between them, so the claim is taken in the same step as that check: the not-settled branch of `ModelAnswers`, `AfterAttempt` and `Catch`. |
| `CancelFinish` | The fire-and-forget `finishRun(..., "failed")` inside `settleRun`. It is its own step only when `DbYields` is true. |
| `StoreUser`, `InsertRun` | `insertMessage(..., "user", ...)` at `:394` and `insertRun` at `:402`, then the `if (settled)` at `:404` |
| `FinishAfterInsert` | `finishRun(..., "failed")` at `:406` |
| `"model"` with `ModelAnswers`, `ModelFails`, `ModelAborted` | `runtime.execute` inside `attempt()`, awaited at `:670`, and its `run.completed` and `run.failed` events. `ModelAborted` is `modelAbort.abort()` making the call reject. The runtime emits `run.completed` as its last act (`packages/core/src/runtime/ai-sdk-runtime.ts:668`), so a claim taken in that handler leaves no network wait unguarded, and no model call is left for `StandDown` to abort. |
| `ModelAnswers` when settled | The `if (settled)` in the `run.completed` handler at `:597`, which meters and drops the answer |
| `PersistEv` | `await persistAssistant()` and `send(event)` in the same handler (`:603-604`) |
| `AfterAttempt` | The `if (settled)` between the last `await attempt()` (`:686`) and `finishRun(..., "completed")` (`:694`) |
| `PersistFinal`, `FinishCompleted`, `AfterFinish` | `persistAssistant()`, `finishRun(..., "completed")` at `:694` with `recordChatRunUsage`, then the knowledge tail before the `finally` at `:774` |
| `Catch`, `CatchFinish` | The `catch` at `:739` with its `if (settled)`, then `persistAssistant()` at `:745` and `finishRun` with `status` |
| `MeterOk` | `meterSettledRun` at `:334` and its `settledRunMetered` flag |
| `Applies`, `FinishTo` | `finishRun` at `packages/host/src/threads.ts:312`, which updates only a `streaming` row (`:327`) |
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
| `MeterOnFinish` | `recordChatRunUsage(options.tenant, run.id, finished, runUsage)` follows `finishRun(..., "completed")` (`:698`) |
| `MeterOnSettledCompletion` | The settled branch of the `run.completed` handler calls `meterSettledRun();` (`:600`) |
| `MeterAfterAttempt` | The `if (settled)` after the model call calls `meterSettledRun();` (`:690`) |
| `ClaimOnPersist` | `finishing = true;` is the first statement of `persistAssistant`, and no `await` sits between each `if (settled) {` and its `persistAssistant()` call: the `run.completed` handler (`:597`→`:603`), after the model call (`:688`→`:693`) and the catch path (`:740`→`:745`). The script prints which part made it false. |
| `CancelYieldsToClaim` | `onClientAbort` starts with `if (queueClosed \|\| finishing) {` and a `return;`, and `onStall` either does the same or has an `if (finishing) {` branch before `settleRun(message)` that ends in `return;` and calls neither `settleRun` nor `finishRun`. One handler alone is not enough, so the switch is false unless both do. |
| `StreamBound` | The finishing branch of `onStall` calls `closeQueue();` (`:284`) |
| `QuietOnceSaved` | Every `send(` in the finishing branch of `onStall` sits inside its `if (!persisted) {` (`:278`) |

`:600` and `:690` back each other up. Removing either one alone still passes, and removing both breaks `BilledIsMetered`.

Each property fails when the code it guards is broken:

| `--break` | Fails |
| --- | --- |
| `GuardAfterInsert`, `SettleFinishes` | `EndsSettled` |
| `GuardOnCompleted`, `GuardAfterAttempt`, `GuardInCatch` | `FailedRowHasNoAnswer` |
| `MeterOnce` | `AtMostOneUsageRow` |
| `MeterOnFinish`, or both `MeterOnSettledCompletion` and `MeterAfterAttempt` | `BilledIsMetered` |
| `StallGuard` | `Termination`, and under `--hazard` also `StreamEnds` |
| `--hazard` | Nothing. `PASS: nothing breaks`. |
| `--hazard --break ClaimOnPersist`, `--hazard --break CancelYieldsToClaim` | `FailedRowHasNoAnswer`, `NoFailureAfterSuccess`, `BilledIsMetered` |
| `--hazard --break StreamBound` | `StreamEnds` |
| `--hazard --break QuietOnceSaved` | `NoFailureAfterSuccess` |

The same three fail under `--hazard` when the code itself loses the claim's position: `finishing = true;` moved inside `if (persisted) {`, or an `await` added before `persistAssistant()` at any of the three call sites. Each makes `ClaimOnPersist` false. They also fail when the finishing branch of `onStall` loses its `return;` or gains a `settleRun(message)`, which makes `CancelYieldsToClaim` false. Removing `closeQueue();` from that branch fails `StreamEnds`, and moving its frames out of `if (!persisted) {` fails `NoFailureAfterSuccess`. Each of these was run once on `runs.ts` on 2026-11-09 and reverted.

`ClaimOnPersist`, `CancelYieldsToClaim`, `StreamBound` and `QuietOnceSaved` matter only under `--hazard`. With `better-sqlite3` nothing can cut in once the save starts, and no write can hang, so breaking any of them without `--hazard` still passes. For the same reason `NoFailureAfterSuccess` and `StreamEnds` fail only under `--hazard` with one of them broken.

## Why it holds on both drivers

The product database uses `better-sqlite3`, so every `await db...` finishes in microtasks, before any timer or socket event can run. The watchdog and a closed connection can therefore cut in only while the run waits on the network: before the work starts, or during the model call. The model encodes this. `Settle` is enabled only at `"start"` and `"model"`, unless `DbYields` is true.

A driver that yields (`--hazard`), such as Postgres, lets the watchdog and a closed connection cut in during any database write. Before 2026-11-06 that broke `FailedRowHasNoAnswer`, `NoFailureAfterSuccess` and `BilledIsMetered`. The shortest break was this: the model answers, the host starts saving it, the watchdog fires during the save, the row is marked `failed`, and the save then lands. Now the run claims its end before it saves (`finishing`), and both handlers stand down once it has. A re-check of `settled` after each write could not fix this, because the answer has already landed by then. The claim decides who ends the run before the first write, and JavaScript runs the check and the claim with nothing in between.

The claim had a cost, found on 2026-11-09 (Notion Dev Findings card 62). Once the watchdog stood down, nothing else ended the stream, so a write after the claim that never returned kept the composer on Running and the hosted run slot taken. `--hazard` showed it as `FAIL: StreamEnds`. The shortest path: the model answers, the `run.completed` handler claims and starts the save, the save never returns, and the stream stays open. Now the watchdog takes the finishing branch of `onStall` (`StandDown`). It ends the person's stream and leaves the run row to the run's own path, so it cannot reopen the race the claim closed. If the save lands later, the row still ends `completed` with its answer and one usage row, and the closed queue drops the frames that path would have sent. The branch sends `run.failed` only while the answer is not saved. Once the answer is saved, the success frame has gone out, and a failure after it would break `NoFailureAfterSuccess`.

A closed connection during the claim still does nothing. It does not need to. `onClientAbort` leaves the watchdog armed, because only the `finally` calls `stall.close()`, so the watchdog still ends an abandoned run's stream one stall window later. In the model, a closed connection during the claim changes no variable, and `StreamEnds` holds with only `StandDown` ending the stream. Closing the stream at the abort would free the hosted run slot one window sooner. No property tells the two apart, and the person who left sees neither.

A write that rejects after the claim is not modeled. The catch path calls `persistAssistant` again. The retry does not send the closing sentence twice, because `assistantText` already holds it and `settleChatTurn` appends a note only when the text lacks it (`withClosingNote`, `packages/core/src/agents/chat-turn.ts:256`). One rejection is enough when it is the catch path's own save (`runs.ts:745`, after a model failed mid-answer with partial text) or a `finishRun` (`:694`, then again at `:748`). If that retry also rejects, the run leaves the catch with no `finishRun`, so the row stays `streaming` and the person gets no terminal frame. That was already true before the claim on `better-sqlite3`, where the same write throws.

## What it does not cover

- The fallback retry on a second model (`heldNext`, `:676`) is folded into the one `"model"` wait.
- A write that never returns ends the person's stream, but the run itself never finishes. `work` stays pending on the `await`, and the row stays `streaming`. `EndsSettled` and `BilledIsMetered` hold only vacuously there, because the run never reaches `"done"`. Nothing closes such a row later: no code sweeps `streaming` rows at boot (`threads.ts` writes `streaming` only in `insertRun`, `:301`, and reads it only in `finishRun`, `:327`). The hosted run slot is freed when the stream ends (`guardRunStream`, `packages/host/src/run-limits.ts:210`).
- The person can be told that saving took too long and later find the answer saved and billed, when a slow save lands after the watchdog. The sentence says to reload the chat for that reason.
- The watchdog's timing is not modeled. `StandDown` has weak fairness, which stands for the real timer: `armRunStallGuard` fires once, one idle window after the last runtime event, and nothing touches it after the claim (`packages/host/src/run-stall.ts`).
- The rule that a run sends at most one `run.failed` is not a property. The finishing branch keeps it by checking `failedMessage`, and the partial-answer case in `packages/host/src/runs-settle-async-db.test.ts` holds it (`failedFrames: 1`).
- A write that rejects after the claim and is not saved by the catch path's retry, which leaves the row `streaming` with no terminal frame (see above).
- The usage writes (`recordChatRunUsage`, `meterSettledRun`) are synchronous today and are modeled as part of the step that calls them. On a driver that yields, each becomes a wait of its own. The claim, and `settledRunMetered` being set before the write, should keep the properties, but that is argued here, not checked.
- A model that streamed part of an answer and then failed reaches `CatchFinish` with text to save. The model has no such outcome, so it does not show the claim is needed on the catch path. The claim there is the same line in `persistAssistant`, and `packages/host/src/runs-settle-async-db.test.ts` drives that path with a held write.
- Tool calls, media mirroring, tool invocation rows, knowledge ingestion and retrieval counts are left out.
- Frames are reduced to `failed`, the success end `ok`, and the closing `end`. Deltas and thinking frames are not modeled.
- A run that broke after saving partial text and ends `completed` is modeled for the `answer` outcome only.
- `FinishOnlyFromStreaming` is mirrored, but no property fails when only it is removed, in either database mode. Its job is defense in depth.
- The meter calls on the catch path (`:741` and `:751`) are not modeled. No modeled path reaches the catch with a billed call, because a billed call ends in `run.completed`.
- The hosted run cap (`packages/host/src/run-limits.ts`) and the desktop IPC transport are out of scope, though both reach this same code.

## Keep it in step with the code

Coverage: `startModalityRun` in `packages/host/src/runs.ts`, `finishRun` in `packages/host/src/threads.ts`, `recordChatRunUsage` in `packages/host/src/usage-record.ts`, and the driver import in `packages/db/src/client.ts`.

Sync commit: `9b80459b`. At this commit the model was confirmed to describe the covered code. `runs.ts` last changed at `9b80459b`, which gave `onStall` its finishing branch. The change to `threads.ts` since the previous sync, `f6c9acc1`, reads the vault key outside a `try` in `openJson`, which the model does not cover, and moved its line numbers by one.

To check whether the verification needs another look:

```bash
git log --oneline 9b80459b..HEAD -- packages/host/src/runs.ts packages/host/src/threads.ts packages/host/src/usage-record.ts packages/db/src/client.ts
```

When a change to covered code is intended:

1. Read the diff against the table above. Decide whether it changes the shape (a new await on the network, a guard moved, a new path to `finishRun` or `insertMessage`) or the promise (a property itself, with evidence in the change).
2. Update the model, and the anchors in `scripts/formal/chat-run-settle.mjs` if their text moved. Write the update from the code, not from what makes the check pass.
3. Run the check. Then run `--break` on the guard nearest your change, and confirm it fails.
4. Update the table, the line numbers and the sync commit here. Move the sync commit only after you confirm the model describes the code at the new commit.

For drift that built up across merges, use `/maintain-formal-verification-skill`.
