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

Hermetic Nix CI runs the same check via `nix build .#checks.x86_64-linux.ci-formal-paid-gate` (and inside `pnpm ci:nix:fast`).

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

## Closed finding (F1 / SR-195)

**F1 (SR-195, Low): resolved in `feat/security-phase1-hardening` (2026-11-23).** Previously, the identity of a request used `fingerprint(...)` in `media-permission.ts` (two 32-bit FNV passes with a comment "Not a security hash"), which allowed a precomputed collision pair (`a64e1d812a3b147e`, `veo-3.1-lite` vs `veo_3_1`) to share a grant key. `fingerprint` was removed and `mediaRequestKey` now returns lossless canonical `JSON.stringify([tool, pairs])`; both `F1` tests in `media-permission.property.test.ts` now run as ordinary `it` assertions rather than `it.fails`.

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

Last full run (2026-11-23, base `8871ffdf`, on Windows with CRLF checkouts): eleven of eleven caught, none missed, none not run, and `git status` was the same before and after.

Previous full runs:
- 2026-11-13, base `365d4af6`: eleven of eleven caught, none missed, none not run (first run on AI SDK 5 runtime `35dd6ff6`).
- 2026-11-03, base `8dfcd9a`: eleven of eleven caught, none missed, none not run.

## Coverage record

| Code | What the check reads |
|---|---|
| `packages/core/src/runtime/media-permission.ts` | `createMediaPermission`, `mediaRequestArgs`, `mediaRequestKey`, `defaultModelFor`, `REQUEST_FIELDS` |
| `packages/core/src/runtime/invoke-guarded.ts` | `invokeToolGuarded`, the `permission` lines |
| `packages/core/src/runtime/ai-sdk-runtime.ts` | `AiSdkRuntime.stream`, where the gate is built |
| `packages/core/src/agents/delegation.ts` | `DELEGATE_EXCLUDED_TOOLS`, `delegateToolKeys` |
| `packages/core/src/harness/specs.ts` | `MODE_HARNESS_SPECS` tool sets |
| `packages/core/src/harness/modes/` | the `tools` of each mode harness spec |
| `packages/host/src/paid-media-body.ts` | `readMediaPermission`, `PAID_MEDIA_GRANTS_MAX` |
| `packages/host/src/runs.ts` | Chat/mode `.execute({ bindings, mediaPermission })` |
| `packages/host/src/voice/ask.ts` | `askNultron` `.execute({ bindings, mediaPermission })` via `prepareChatRun` + `voiceBindings` |
| `packages/host/src/delegation/run-delegation.ts` | delegated `.execute({ bindings })` using `delegateToolKeys` (mode agents and team bots via `FULL_CHAT_TOOLS`) |
| `packages/host/src/team-propose.ts` | team proposal `.execute({ bindings: [] })` |
| `packages/host/src/job-regen.ts` | studio/worker `.execute({ bindings })` bounded by `toolKeysWithinSpec` |
| `packages/host/src/edit/agent-run.ts` | Edit agent `.execute({ bindings })` (named residual) |
| `packages/host/src/studio-generate.ts` | direct user-triggered generator tool calls |
| `packages/host/src/workers/video-generate-tool.ts` | `chatVideoGenerateTool` wrapper (`keepRunAlive` around `videoGenerateTool`, gated under `"video_generate"`) |
| `packages/core/src/tools/platform/register.ts` | registers `imageGenerateTool` and `videoGenerateTool` |

**Sync commit: `8af77b99`** (`feat/security-phase1-hardening`, 2026-11-23). The check was confirmed to describe the files above at that commit. To see whether covered files moved since: `pnpm formal:sync-check` (or `git log --oneline 8af77b99..HEAD -- <files above>`). After you confirm the tests still describe the code, write the new commit here.

Since the previous sync (`8871ffdf`), one change touched covered code, and the check changed with it:
- `8af77b99` (SR-195) deleted `fingerprint` and made `mediaRequestKey` return the canonical `JSON.stringify([tool, pairs])` text. Both `F1` cases in `media-permission.property.test.ts` are plain `it` now, and the `key-ignores-model` break in `scripts/check.mjs` finds the `pairs` line.

## Why not TLA+

The question here is not "can steps interleave badly". The gate takes a grant in one synchronous step (`beforeCall` has no `await`), and the real parallel run is in the test. The questions are whether the code agrees with its specification for every input in a scope, and whether every entry into a run is accounted for. Both are best answered by running the real code (property tests, with `fast-check` already in core) and by reading the real syntax tree, with nothing new to install. A hand-written model of the gate would only restate the code, and it would not have found F1.

Next target, if one is wanted (not started): the same promise one layer out, the web card and the thread's "newest reply" rule, as a small TLA+ model of two tabs, a Run press and a failed turn. Use pstack `/create-formal-verification-skill`.
