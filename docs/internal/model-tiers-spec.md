# Model tiers spec (2026-10-06)

Status: **draft. Nothing here is built.** Plan: [`chat-first-plan.md`](chat-first-plan.md).

The model picker is replaced by three choices. The host turns a choice into a real model. The renderer shows the choice and, by default, never receives the model's name.

## 1. The three tiers

| Tier id | Label (en / id) | Promise to the person | Thinking |
|---|---|---|---|
| `daily` | Daily / Harian | The default. Good answers at a sensible speed and cost. | The model's default |
| `fast` | Fastest / Tercepat | Answers first. For short questions and drafts. | Off |
| `reasoning` | Reasoning / Penalaran | Thinks before answering. For hard problems and long inputs. | On, at a deep level |

`daily` is the default for a new thread. The choice is remembered per thread, and the last choice seeds the next thread.

The choice lives in the composer's `+` menu, not on the composer. A person who never opens the menu never sees a model decision; they get Daily.

The reasoning-effort control in the composer goes away; the tier sets it. The levels a model accepts still come from `ModelPolicy` (`packages/core/src/models/model-policy.ts:114`).

## 2. Registry

New file `packages/core/src/models/tiers.ts`:

```ts
export const MODEL_TIERS = ["daily", "fast", "reasoning"] as const;
export type ModelTierId = (typeof MODEL_TIERS)[number];
export const DEFAULT_MODEL_TIER: ModelTierId = "daily";

type TierDefinition = Readonly<{
  id: ModelTierId;
  thinking: "off" | "default" | "deep";
  /** Ordered. The first id that is live in the catalog and not on the breaker answers. A provider with no list is skipped. */
  candidates: Readonly<Partial<Record<ProviderId, readonly string[]>>>;
}>;
```

**Built 2026-10-06 (M0).** `packages/core/src/models/tiers.ts` and `tiers.test.ts`, 23 tests, additive: no existing file changed, and the file is not exported from `packages/core/src/index.ts` yet (M1 adds that, a few lines at the end). The seed lists are in the file with their provenance.

Rules for a candidate list:

1. Every id has an entry in `MODEL_POLICY_TABLE` with `verified` set, the rule `JOB_MODE_PREFERENCES` already follows (`packages/core/src/models/mode-defaults.ts:60-64`). A guard test fails otherwise.
2. Every id passed the worker-routing eval in the workers spec. Chat-first depends on tool calls; a model that cannot route does not go on a list.
3. `fast` models are ranked by measured time to first token on the gateway, not by name.
4. `reasoning` models accept a reasoning effort on the wire.

Seed lists, to be confirmed by a gateway probe and Rizky before M1:

- `daily`: start from `CHAT_DEFAULT_PREFERENCES` (`packages/core/src/models/preferred.ts:15`), which is today's default order.
- `fast`: the ids whose hint is "Fast drafts" in `GATEWAY_BEST_FOR` (`packages/core/src/models/gateway-roles.ts:7`).
- `reasoning`: the ids whose hint is "Deep reasoning" in the same table, restricted to those with effort levels.

The existing `ModelTier = "everyday" | "advanced"` is a curation label, not a choice. The earlier draft renamed it `CurationTier` in the same change. That rename is deferred to promotion: `ModelTier` is exported from a file the published code also edits, so renaming it in the tester code would conflict at every sync, and the published-wins rule says the tester code adapts. The new type is `ModelTierId`, and `tiers.ts` says why the two differ.

Built differently from the draft: the `daily` list is imported from `CHAT_DEFAULT_PREFERENCES`, not copied, so a published change to the default list reaches Daily on the next sync. A guard test requires `fast` models to be able to run with Thinking off and `reasoning` models to accept a deep level.

## 3. Resolution

```ts
resolveTier(tier, liveness, definitions = TIER_DEFINITIONS): TierResolution
// liveness = { providers, isListed(provider, id), isDown(id) }, so the walk stays pure and the host supplies the catalog and the breaker
// TierResolution = { ok: true, tier, provider, model, thinking, skipped } | { ok: false, tier, error: "tier_unavailable", skipped }
// readRequestedTier(value): { ok: true, tier } | { ok: false, error: "unknown_tier" }   (absent gives daily, a typo never does)
```

- Walk the tier's candidates for each provider the tenant may use, in provider order. Personal has one provider, the Toko Token gateway.
- Skip an id that the catalog does not list or that the breaker holds down (`JOB_MODEL_DOWN_MS`, five minutes, `packages/host/src/job-model-fallback.ts:27`).
- Try a demoted id last (2026-11-13). `liveness.demoted` names the ids the host holds back for this turn; the walk tries them after every other live candidate of the tier, on any provider, and answers with the first of them when nothing else is live. It demotes and never drops, so a tier still answers. The host demotes the models measured to misread a picture (`PICTURE_MISREADS`, `packages/core/src/models/image-input.ts`) on a turn that carries one: an image run, or a text run whose thread replays an earlier picture. What a tier advertises does not change.
- No candidate left: answer `tier_unavailable`, a flat error with copy in both locales. Never fall through to another tier silently; a person who chose Reasoning and got a fast model was lied to.

**Chat gains fallback.** Today a chat run has retries but no second model. With a tier, an unpinned run that fails with a transport-class error (`isGatewayUnavailableFailure`, `packages/core/src/models/job-fallback.ts:61`) and has streamed nothing moves to the next candidate of the same tier, once. The failed id goes on the breaker.

## 4. Wire

**Request.** `POST /api/v1/threads/:id/runs/text` accepts `tier` in place of `model`:

```json
{ "content": [...], "tier": "reasoning" }
```

- `tier` present: the host resolves it. `thinking` and `reasoningEffort` in the body are ignored.
- `model` present and the tenant has real names switched on (section 6): today's path, pinned, no fallback.
- Both absent: `daily`.
- Both present: 400.
- An unknown tier: 400 `unknown_tier`, never a default.

Job routes accept `tier` the same way, replacing `model` + `modelPinned`.

**Catalog.** `GET /api/v1/models` answers, by default:

```json
{ "tiers": [ { "id": "daily", "available": true }, { "id": "fast", "available": true }, { "id": "reasoning", "available": false } ], "default": "daily" }
```

No ids, no labels, no provider names. `available` is whether any candidate is live. Labels and hints are renderer catalog keys, not host strings.

**Run stream.** `run.started` carries `tier` and no longer carries `model` (`packages/host/src/runs.ts:211`, `:465`).

## 5. Where a model name leaks today, and the fix

| Place | Today | After |
|---|---|---|
| Chat picker, `apps/web/components/model-picker.tsx` | Friendly label, hint, context length; search matches raw id | Three rows inside the `+` menu: label, one-line promise. No search. |
| 14 studio selects, `model-select.tsx:32-38` | the friendly label and the hint | The same three rows. The studios are parked but must still compile and pass. |
| Usage page, `usage-page.tsx:217-220`, `usage-range-chart.tsx:145-183` | Raw `row.model` as text, tooltip, legend and testid | Grouped by tier. Testid `usage-tier-row-<tier>`. |
| Finance notice, `finance-result-notices.tsx:23` | "{from} is unavailable; used {to}" with raw ids | "The first choice was unavailable; another model of the same tier answered." |
| Error, `packages/core/src/runtime/retry.ts:122` | "Could not reach {model} after {tries} tries" | "Could not reach the model after {tries} tries." |
| `video-examples.tsx:125` | Raw `item.model` | Removed. |
| Run stream | `model` on `run.started` | `tier` |
| `GET /api/v1/models` | Full curated catalog | Section 4 |

A single test, `packages/host/src/model-mask.test.ts`, drives the real router with a seeded catalog and fails if any catalog model id appears in a response body or stream frame while real names are off. That test is the definition of "masked".

## 6. Real names, for the owner

Masking is the default on every product and brand. One switch turns real names on:

- **Personal:** Settings, under More, "Show model names". Off by default. It restores today's picker next to the tiers and lets a run be pinned to a model.
- **Enterprise:** the same switch, owner and admin only, per company.
- **White-label brands:** `brand.json` can lock it off (`models.namesLocked: true`). A locked brand has no switch and the host refuses `model` in a request body. Locked brands also get the masked catalog regardless of the stored setting.

The switch is stored host-side beside the locale. The renderer reads it from `GET /api/v1/settings`; it never decides.

## 7. Usage and records

- Usage rows keep `model` (`packages/db/src/schema.ts:63`): billing and support need the truth. They gain a nullable `tier` column, written at the time of the run. Migration by `drizzle-kit generate`.
- Usage routes return `tier` in place of `model` unless real names are on.
- Logs and the audit trail keep the model id. The mask is about what the product shows, not about what the operator can know.

## 8. Workers and tiers

- `ModeHarnessSpec` gains `tier: ModelTierId`. It replaces the head of `JOB_MODE_PREFERENCES` as the statement of what a mode needs; the per-mode lists remain as an override where a mode needs a specific model (strict JSON for legal and meeting, long input for minutes).
- Starting points: research `reasoning`; legal `reasoning`; meeting `reasoning`; documents, finance, market, data, presentations `daily`.
- A worker called from chat uses its spec's tier. The person's choice sets the chat agent only. (Decision D3 in the plan; the alternative is "the higher of the two".)
- Media has no tiers. Image, video and music models are chosen by `resolveModeDefaults` (`mode-defaults.ts:89`) and shown as nothing at all. `suno_music` stays the relay-only music model.

## 9. Enterprise BYOK (M4, server mode only)

- `candidates` is keyed by provider (`PROVIDER_IDS`, `packages/core/src/providers/registry.ts:28`). A company that has connected only an Anthropic key resolves every tier inside Anthropic's list.
- Provider order: the company's own keys in the order they set, then Toko Token. Moving to a second provider on failure happens only when the company has cross-provider fallback on, as today.
- `resolveModelProvider` (`packages/core/src/models/catalog.ts:147`) has no `openrouter` in its type yet. That gap is closed in M4, not before.
- Personal resolves against `toko` only. A Personal-parity test proves the Personal path is byte-for-byte what M3 shipped.

## 10. Locale

New keys in `apps/web/locales/{en,id}/chat.json`:

```
chat.tiers.daily.label      chat.tiers.daily.hint
chat.tiers.fast.label       chat.tiers.fast.hint
chat.tiers.reasoning.label  chat.tiers.reasoning.hint
chat.tiers.aria             chat.tiers.unavailable
chat.errors.tierUnavailable
```

`chat.models.*` stays for the real-names view. The parity test covers both.

## 11. Open questions

1. **How deep the mask goes** (D2). This spec assumes the renderer receives no ids. A display-only mask is a third of the work and leaks through the network tab.
2. **A fourth choice, Auto.** GitHub Copilot offers one. Not in scope; `daily` is the default and plays that part. Add it only if people ask which to pick.
3. **Tier and price.** If plans ever meter by tier, the meter lives in the gateway and the licence service, never in the client (`AGENTS.md`, "The gate is advisory").
4. **Vision.** A thread with an image needs a model that reads images (`packages/core/src/models/capabilities.ts:12-36`). Resolution must skip candidates that cannot, and say `tier_unavailable` if none can. Built: an image run lists only candidates with image input. A model that takes the picture and reads it wrongly is a different case, and since 2026-11-13 it is demoted for a picture turn, not skipped (section 3).
