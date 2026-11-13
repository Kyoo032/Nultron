---
name: verify-paid-media-gate
description: Formally checks the paid media Run gate (SR-167): a picture or clip starts only for a request the person pressed Run on, once per press. Use when a change touches the gate's files (listed here), starts a model run some new way (channel, WhatsApp, routine, delegate), changes image_generate or video_generate, or before promoting such a change.
---

# Verify the paid media gate

Agent guardrail, same class as `AGENTS.md`. Not part of the Nultron app. Made with pstack `/create-formal-verification-skill`; keep it true with `/pstack:maintain-formal-verification-skill`.

**The promise.** A paid picture or clip starts only for a request the person pressed Run on, and one Run press starts it at most once.

**The harm if it breaks.** The owner's gateway key is billed for media nobody approved, or for more than the card showed, after text in a page or a file steers the model.

Where the promise lives: [SR-167](../../../docs/internal/security-register.md#sr-167). The model asks first, the screen shows a card, Run sends the next turn with a grant for exactly that request, and the gate lets one call with the same arguments through per grant.

## Use it when

- You edit any file in the coverage table below.
- You add or change a way to start a model run with tools: a new channel, WhatsApp, a routine, a scheduled run, `delegate`, a new route that calls `runtime.execute`. Such a run has no card to press Run on unless you bring it through the gate. This is the case the check was built for.
- You add `image_generate` or `video_generate` to a tool list, a harness spec or an agent template.
- You promote or merge a change that did any of the above (the code is shared: lanes `enterprise` and `tester`).

## Run it

One command from the repo root (about 20 s). It needs `pnpm install` done, nothing else.

```
pnpm verify:paid-gate
```

That is `node .cursor/skills/verify-paid-media-gate/scripts/check.mjs`. It runs two vitest groups, which `ci:local` also runs with core and host:

| Group | Files | Proves |
|---|---|---|
| `gate` (core) | `packages/core/src/runtime/media-permission.property.test.ts`, plus the older `media-permission.test.ts` and `invoke-guarded.test.ts` | The real gate against a specification with no hash in it |
| `reach` (host) | `packages/host/src/paid-media-reach.property.test.ts`, plus the older `paid-media-body.test.ts` and `runs-paid-media.test.ts` | Every way into a run is accounted for |

Green looks like `pass  gate: N tests` and `pass  reach: N tests`. Red lists the failing test names. A run that finds no tests is red too.

Flags: `--only gate` or `--only reach` runs one group. `--property-only` runs only the two property files, not the older unit tests beside them, to show what the property files catch on their own. `--teeth` is described below. The exit code is 0 when every check passes (and, with `--teeth`, every break is caught), and 1 otherwise.

## What a pass covers

Within these bounds, and no further:

- **Every call sequence up to 3 calls against every grant list up to 2 grants** (8,775 cases). The requests are two pictures that differ in the prompt and two 12-second clips that differ only in the model (a list price 8x apart). Each request is sent tidy and noisy (extra spaces, a placeholder `model`, an `example.com` picture, unknown fields). For each case the gate must agree with the specification: a call starts exactly when an unspent grant names the same request, starting it spends that grant, and what starts is the request the card showed. The specification borrows only `mediaRequestArgs` (what the card shows) from the code under test; the identity of a request is compared as text. The count is 15 grant lists (the order of grants does not matter to the gate, so each list is taken once, as a multiset) times 585 call sequences over 8 call forms (four requests, tidy and noisy).
- **A random search at a larger size** (up to 6 grants, 14 calls) on the same specification.
- **Parallel calls** through the real `invokeToolGuarded`: eight calls at once against three grants start exactly three tools.
- **Which tool sets can bind a paid tool.** Only the Chat harness spec lists them; a delegated run never does, whichever agent is asked.
- **Every way into a run.** The tree is scanned for each `.execute({ bindings })` call. Each must be on the list in the reach test with a reason: `runs.ts` (gated, and must pass `mediaPermission` as an argument), delegation (tools stripped), `job-regen.ts` (bounded by the mode spec), the Edit agent (its own tools, a named residual). A new one fails until somebody writes down how it holds the gate. The same for any file that uses `imageGenerateTool` or `videoGenerateTool` itself. The scan reads the TypeScript syntax tree, so a comment or a string that says `mediaPermission` does not count; the property must be an argument of the call.
- **One gate per run.** `createMediaPermission` is called once, directly in `AiSdkRuntime.stream`, outside any loop or closure, so the runtime's retries share one set of unspent grants. Nothing else builds one.
- **The request body.** Forty-odd hostile bodies: the gate always asks, at most 12 grants survive, and every kept grant is one a card could have shown. Only the person's own client may send grants, and nothing in a body may switch the gate off.
- **The check can fail.** The specification is run against four wrong gates and must catch each; the scan is run on tiny wrong sources. `--teeth` below does the same to the real code.

## What it does not cover

- **The web card** (`apps/web/components/chat-media-permission-card.tsx`) and the thread's rule that only the newest reply's card can be pressed. Two tabs on one thread can each press Run on the same card; the host keeps no record of a spent grant between turns. By design today ("a grant is the person's press", SR-167), not checked.
- **The Edit agent's `generate_image` and `generate_video`.** They are not these tools and are not gated (SR-167 residual).
- **Price.** The card shows a list price, not a quote.
- **A model call made inside another tool** (a worker such as `build_deck`) and any run started without `.execute`.
- **The runtime past the gate.** That `buildAiTools` hands the gate to `invokeToolGuarded` is read from code (`ai-tools.ts`), and covered by the older tests, not by this one.
- **A real gateway.** Nothing here makes a picture. No paid media has been made by this check, and the live Run press that SR-167 still owes is not replaced by it.
- **Why a call fails to match.** Whether `12` and `"12"` are one request, or `Square` and `square`, is whatever `mediaRequestArgs` says; the tests pass numbers as numbers and strings as strings.

## Open finding

**F1 (SR-195, Low): two different requests can share a key, so a grant for one lets the other start.** The identity of a request is `fingerprint(...)` in `media-permission.ts`, two 32-bit passes with a comment that says "Not a security hash". Counterexample, in the code's words:

1. The person presses Run on a 12-second clip on `veo-3.1-lite` whose prompt ends in `癋戕紥萐两`. The body's grant reaches `readMediaPermission`, then `createMediaPermission`, which files it under `mediaRequestKey` = `a64e1d812a3b147e`.
2. The model calls `video_generate` for 12 seconds on `veo_3_1`, prompt `a calm lake at dawn, very soft light 妰蟖纐倨之`. `mediaRequestKey` returns `a64e1d812a3b147e` again, `beforeCall` finds one unspent grant and returns null, and `argsToRun` hands the tool the dear request's own fields.
3. The tool starts the dearer model for 12 seconds: 8x the card's list price per second ($4.80 against $0.60), or a different picture than the card showed at the same price.

Needs someone who controls what the model writes (text in a page or file) and a pair computed ahead (about five minutes on four cores, `scripts/find-collision.mjs`). The two prompts are the same length up to a five-character tail, and the tails are the only odd part of either prompt. The list prices come from `media-pricing.ts`: `veo-3.1-lite` at 0.05 USD per second and `veo_3_1` at 0.40 USD per second at 720p. The pair is pinned in `media-permission.property.test.ts` as two `it.fails` tests (the `CHEAP` and `DEAR` constants). The code is unchanged, as this check never edits product code. The fix is one function: make the key the canonical text itself (`${tool}\n${lines}`; values are already single-spaced strings, so it is unambiguous) and delete `fingerprint`. When that lands, the two `it.fails` turn red; change them to `it` and the finding is closed.

### Finding a new colliding pair

Only needed if the pinned pair ever has to be replaced. The script needs only Node and makes no network calls.

1. Run `node .cursor/skills/verify-paid-media-gate/scripts/find-collision.mjs <seed>` with seeds 1 to 4 at once, one per core.
2. Each run prints `RESULT {"tailLite":..,"tailFull":..}` after about five to eight minutes, when it finds a pair that crosses the two prefixes. Otherwise it keeps going.
3. Append each tail to its prompt and put the pair in `CHEAP` and `DEAR`.

How it works: `fingerprint` in `packages/core/src/runtime/media-permission.ts` keeps a 64-bit state (two 32-bit passes) that moves to a new state one character at a time. Two requests whose texts are the same length up to a tail, and differ before it (here the model id and a few words of the prompt), collide when their states agree after the tail. The search is Floyd's cycle finding on a function from 64 bits to the state after the tail, on the cheap prefix or the dear prefix: one bit picks the branch and 63 bits spell the five-character tail. It takes about 2^32 steps. The tail uses the 16,384 CJK characters from U+4E00, none of which is whitespace; the first four characters carry 14 bits each and the fifth carries 7. The script copies `fingerprint` from the source on purpose, so the test checks the pinned pair against the real `mediaRequestKey`.

## When it goes red

1. Read the failing test name. For a `gate` failure the message names the grants and calls; replay them by hand in `createMediaPermission` and read what `beforeCall` returned against the code. For a `reach` failure the message says which file to classify.
2. **If a step of the counterexample cannot happen in the real code**, the verification is wrong: fix the test or the specification and say why. **If every step can happen, it is a bug in the code**: report it with the steps and the harm, and register it ([SR-167](../../../docs/internal/security-register.md#sr-167) style). Do not weaken a property or enlarge a bound to turn it green, and do not edit product code unless asked.
3. A new run entry is not a bug by itself. Decide how it holds the gate (pass `mediaPermission`, bind no paid tool, or Rizky's ruling that it needs none), then add it to `RUN_ENTRIES` with that reason.

## When the change is intended

- The promise changed on purpose (Rizky rules it, the register row says so): change the property and quote the evidence in the commit. Old wording, new wording, evidence.
- A request the model can now make (a new field in `REQUEST_FIELDS`, a new paid tool): add it to `CLASSES` and `variants` in the gate test so the 8,775 cases cover it, and to the tool-set checks.
- A bound is too small for a new case: raise it and say so in the report, with the new run time.
- Move the sync commit below only after you confirm the tests describe the code at the new commit.

## Prove it can fail (`--teeth`)

```
node .cursor/skills/verify-paid-media-gate/scripts/check.mjs --teeth
```

Applies eleven breaks to the real source one at a time (a grant never spent, any grant opens any request, the key ignores the model, the model's own fields run, the gate skipped in `invokeToolGuarded`, a delegated run keeping the paid tools, the body turning the gate off, grants uncapped, the gate built in a closure, `runs.ts` without the gate, a new unlisted run entry), requires the right group to go red, restores each file, and runs the checks clean at the end. About two minutes. Add `--property-only` to see what the two property files catch without the older tests. A break reported `NOT RUN` means the code changed shape: update `BREAKS` in the script. `MISSED` means the check has lost a tooth: fix the check.

How the breaks work. Each entry in `BREAKS` names a file, the exact text to change (`find`, which must occur exactly once in the file's own line endings, LF or CRLF, or the break is `NOT RUN`) and the groups that must go red (`catchers`). The script refuses to start when the checks are already red, because it would prove nothing. It puts each file back in a `finally` and again on exit. If the process is killed before it restores (power loss), `git diff` shows the file; restore it from git.

Last full run (2026-11-13, base `365d4af6`, on Windows with CRLF checkouts): eleven of eleven caught, none missed, none not run, and `git status` was the same before and after. It is the first run on the AI SDK 5 runtime (`35dd6ff6`, which landed after the run below).

Previous full run (2026-11-03, base `8dfcd9a`, on Windows with CRLF checkouts): eleven of eleven caught, none missed, none not run. Every file was put back: `git status` was the same before and after, and no product file was modified. Every break turned red in one of the two property files; `delegate-keeps-media` and `new-run-entry` turned red only there. An earlier run on the same day had four breaks `NOT RUN` (`grant-never-spent`, `key-ignores-model`, `delegate-keeps-media`, `run-without-gate`), because their `find` text holds a line break and the Windows checkout ends lines in CRLF; `check.mjs` now matches the file's own line endings, and that is the run reported here.

## Coverage record

| Code | What the check reads |
|---|---|
| `packages/core/src/runtime/media-permission.ts` | `createMediaPermission`, `mediaRequestArgs`, `mediaRequestKey`, `fingerprint`, `REQUEST_FIELDS` |
| `packages/core/src/runtime/invoke-guarded.ts` | `invokeToolGuarded`, the `permission` lines |
| `packages/core/src/runtime/ai-sdk-runtime.ts` | `AiSdkRuntime.stream`, where the gate is built |
| `packages/core/src/agents/delegation.ts` | `DELEGATE_EXCLUDED_TOOLS`, `delegateToolKeys` |
| `packages/core/src/harness/specs.ts` and `harness/modes/*` | the `tools` of each harness spec |
| `packages/host/src/paid-media-body.ts` | `readMediaPermission`, `PAID_MEDIA_GRANTS_MAX` |
| `packages/host/src/runs.ts`, `delegation/run-delegation.ts`, `job-regen.ts`, `edit/agent-run.ts` | the `.execute({ bindings })` calls |
| `packages/host/src/studio-generate.ts`, `packages/core/src/tools/platform/register.ts` | uses of the generator tool objects |

**Sync commit: `365d4af6`** (`main`, 2026-11-13). The check was confirmed to describe the files above at that commit. To see what moved since: `git log --oneline 365d4af6..HEAD -- <files above>` and `git diff 365d4af6..HEAD -- <files above>`. After you confirm the tests still describe the code, write the new commit here.

Since the previous sync (`b79a527`), these changes touched covered code, and none of them changes what the check describes:
- `35dd6ff6` moved the runtime to AI SDK 5. The gate is still built once in `stream` and handed to `buildAiTools`. Each tool's `execute` still goes through `invokeToolGuarded` with the gate. A disabled tool is now left out of the tool map instead of getting a refusal `execute`, and neither version reached the gate.
- `5448c4f9` and `9b80459b` changed only the settle logic in `runs.ts`. The `.execute({ bindings })` calls and their `mediaPermission` argument are unchanged.
- `771e9d90` and `3bff8ec1` retry less. Every retry shares the one gate.
- `media-permission.ts`, `invoke-guarded.ts`, the image and video tool schemas, the harness specs and the run entries have not changed.

## Why not TLA+

The question here is not "can steps interleave badly". The gate takes a grant in one synchronous step (`beforeCall` has no `await`), and the real parallel run is in the test. The questions are whether the code agrees with its specification for every input in a scope, and whether every entry into a run is accounted for. Both are best answered by running the real code (property tests, with `fast-check` already in core) and by reading the real syntax tree, with nothing new to install. A hand-written model of the gate would only restate the code, and it would not have found F1.

Next target, if one is wanted (not started): the same promise one layer out, the web card and the thread's "newest reply" rule, as a small TLA+ model of two tabs, a Run press and a failed turn. Use pstack `/create-formal-verification-skill`.
