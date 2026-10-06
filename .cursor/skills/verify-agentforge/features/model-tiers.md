# Model tiers

In the tester code (`tester/chat-first`) the Chat composer offers three choices instead of a model list: **Daily** (the default), **Fastest** and **Reasoning**. The trigger `tier-picker` shows the current choice's label and nothing else, and its panel `tier-picker-panel` lists the three as `tier-option-daily`, `tier-option-fast` and `tier-option-reasoning`, each with a line on what it is for. A send carries `{ content, tier }` and never a model, a Thinking flag or a reasoning level; the host turns the tier into a model and the renderer is never told which. The reasoning-effort select is gone, because the tier sets Thinking (Fastest is Off, Reasoning is Deep, Daily is the model's default). **The steps in [models.md](./models.md) that drive `model-picker`, `model-group-recommended`, `model-best-for` and `reasoning-effort` do not apply in the tester code**; they apply to the published code, where those controls still exist. Spec: [`docs/internal/model-tiers-spec.md`](../../../../docs/internal/model-tiers-spec.md). The host half (the catalog, the walk, the mask test) is its own track; this file covers what the person sees and what the browser posts.

## Sub-features

- `tiers-picker` is `tier-picker`, the trigger in `composer-toolbar` (inside `composer-controls`). Its visible text is exactly `Daily`, `Fastest` or `Reasoning` (`Harian`, `Tercepat`, `Penalaran` in `id`), with a decorative chevron; its `aria-label` is `Answer style: <label>` (`Gaya jawaban: <label>`). It carries `aria-haspopup="listbox"` and `aria-expanded`. It wears the old picker's `model-picker` and `model-picker-trigger` classes so the composer's grid places it at every width; those classes are layout hooks here, not a model picker. It is disabled while a send is running, and while the host has listed no tiers.
- `tiers-panel` is `tier-picker-panel`, portalled to `document.body` and placed by `placePickerPanel` (`apps/web/lib/picker-panel.ts`), holding one `[role="option"]` per tier with its `tier-option-<id>` testid, `aria-selected` on the current one, and `aria-disabled="true"` on one the host reports unavailable, which also shows `Unavailable` (`Tidak tersedia`). There is no search box, no group and no check for a model name.
- `tiers-keyboard` Enter or Space on the trigger opens it (an arrow key does too); focus moves to the list. ArrowUp and ArrowDown move the highlight and wrap, Home and End jump, Enter or Space chooses the highlighted tier unless it is unavailable, Escape closes and returns focus to the trigger, Tab closes and returns focus to the trigger, and a click outside closes without moving focus. Choosing a tier closes the panel and puts focus in `composer-text`.
- `tiers-default` a person who never opens the picker is on Daily. A new thread starts on the last tier the person chose (`localStorage["agentforge-chat-tier"]`); an existing thread restores the tier it last sent with (`localStorage["agentforge-chat-thread-tiers"]`, a map of thread id to tier, at most 80 threads). A stored value that is not a tier id, or a tier the host now reports unavailable, is skipped.
- `tiers-body` the run request. `POST /api/v1/threads/:id/runs/text` (and `runs/image`, `runs/video` for an attachment) has the body `{ "content": ..., "tier": "daily" | "fast" | "reasoning" }` and no other key. The enhance-prompt request carries no `model`. Code: `apps/web/lib/chat-tier-body.ts`.
- `tiers-thinking-row` the reply's Thinking row follows the tier: it shows for Daily and Reasoning and not for Fastest (`tierThinkingEnabled`, `apps/web/lib/chat-tier-pref.ts`).
- `tiers-context` the context chip's window and the attachment types the composer accepts come from the chosen tier's `contextLength` and `inputModalities` in the catalog the host sent, not from a model.
- `tiers-unavailable-error` a refused send with `503 { error: { code: "tier_unavailable" } }` shows `composer-error` with the catalog's sentence (`That choice is not available right now. Pick another one and send again.`; `Pilihan itu sedang tidak tersedia. Pilih yang lain lalu kirim lagi.`), never the host's own message, which can name a model.

## How to get to it (user POV)

- Open `http://127.0.0.1:3200/chat` (the tester's webdev port; `:3000` is the published code and has the model picker).
- The composer toolbar shows a pill reading `Daily`. Click it to see the three choices; pick one and type.
- Nothing about it is in Settings. There is no model name anywhere in Chat.

## Driving it with the Nultron harness

Preconditions:

- Doctor exits 0 against the **tester** instance (`--base http://127.0.0.1:3200`), never `:3000`. A tester webdev uses its own data folder.
- `GET /api/v1/chat` answers `tiers` (three entries, each `{ id, available, inputModalities, contextLength }`) and `defaultTier: "daily"`. Until the host's tier catalog is in, `tier-picker` renders disabled and a send still names `daily`; that is a host gap, not a renderer fail.
- Read `localStorage["agentforge-chat-tier"]` and `["agentforge-chat-thread-tiers"]` before touching the picker and restore both at the end. A throwaway Playwright profile starts empty.

- **Present, and the old controls absent.** On `/chat`, `tier-picker` is visible and its visible text is `Daily`. `model-picker`, `model-picker-prefix` and `reasoning-effort` have count 0. `composer-enhance` is still there.
- **Open with the mouse.** Click `tier-picker`. `tier-picker-panel` appears, `tier-picker` has `aria-expanded="true"`, `document.activeElement` is the list (`[role="listbox"]`), and three `[role="option"]` rows exist with `tier-option-daily` selected. Press Escape: the panel is gone, `aria-expanded` is `false`, and focus is on `tier-picker`.
- **Open with the keyboard.** Focus `tier-picker` with Tab and press Enter (then, in a second pass, Space, then ArrowDown). The panel opens with focus in the list. ArrowDown twice lands on `tier-option-reasoning`; Enter chooses it. The panel closes, the trigger reads `Reasoning`, and focus is on `composer-text`. Open again and press Tab: the panel closes and focus is on `tier-picker`.
- **Outside click.** Open the panel, click empty page space. The panel closes and focus is wherever the click put it.
- **What a send posts.** Capture requests (Playwright `page.on("request")` filtered to `/runs/text`, or the network log). With nothing picked, the body parses to exactly `{ content: "<the text>", tier: "daily" }`. Pick Fastest and send: `tier` is `fast`. Pick Reasoning and send: `tier` is `reasoning`. In every case `Object.keys(body)` is `["content","tier"]`: no `model`, no `thinking`, no `reasoningEffort`. Attach an image (when the tier's `inputModalities` includes it) and send: the `/runs/image` body has the same two keys.
- **Memory.** After sending a thread on Fastest, open `New chat`: the trigger reads `Fastest` (the last choice seeds the next thread). Open the first thread again from the rail: it reads `Fastest`; pick Reasoning there, go to another thread and back: it reads `Reasoning`.
- **Thinking row.** Send a prompt on Fastest: the live reply shows no Thinking row. Send one on Reasoning: it shows one.
- **Unavailable tier.** Route `GET /api/v1/chat` in the browser (Playwright `page.route`) to answer `reasoning` with `available: false`. Open the panel: `tier-option-reasoning` has `aria-disabled="true"` and reads `Unavailable`; clicking it, or highlighting it and pressing Enter, chooses nothing and the panel stays open. Route the run to `503 { error: { code: "tier_unavailable", message: "x" } }` and send on Daily: `composer-error` shows the catalog sentence, not `x`.
- **Languages.** In Settings choose Bahasa Indonesia, restart as the banner says, and read the trigger (`Harian`), the three options (`Harian`, `Tercepat`, `Penalaran`) and the hints. Restore English.
- **Widths.** At 1280, 600, 470 and 375 px the pill sits in the toolbar without clipping and without overlapping Attach or Send. At 375 the panel stays inside the window (its left edge is at least 8 px, its right edge at most `innerWidth - 8`), every row is at least 44 px tall, and the hint wraps instead of clipping. Check light and dark.
- **Evidence.** Screenshots of the closed trigger, the open panel (light and dark), the 375 px panel and the network capture of one body per tier, under `evidence/model-tiers/<run-id>/`.

Not driven yet: this recipe was written with the tier picker and its unit tests, and has not been run against a live tester instance.

## Gotchas

- The tier picker is not `model-picker`. The published code's model recipes ([models.md](./models.md), `chat-model-switch` in [chat.md](./chat.md)) are not valid on the tester instance, and a drive that clicks `model-picker` there will time out.
- Keep two instances apart: `:3000` is the published code with the model picker and the Thinking select, `:3200` is the tester. Doctor the one you drive.
- The wrapper's class is `tier-picker model-picker` on purpose. `.model-picker` in `globals.css` is the composer grid's slot for the choice control, so a selector for `.model-picker` matches the tier picker here. Use the testids.
- Do not look for a model name. The host never sends one, so a drive that wants to prove "which model answered" has no renderer-side evidence; the mask test the spec names is `packages/host/src/model-mask.test.ts` (the host track's), and the host's logs are where an operator reads the id.
- The stream watchdog names the tier ("No first token from Reasoning after 240s"), and Daily and Reasoning get the long budget (240 s first token, 180 s idle) because the renderer cannot tell whether the model behind them thinks quietly. Fastest keeps the short one.
- `chat.tiers.*` keys are built at run time (`chat.tiers.${id}.label`), so the literal-key scan cannot see them; `apps/web/lib/chat-tier-locale.test.ts` holds both catalogs to the registry instead.
- The Thinking CSS (`.composer-thinking*`) is still in `globals.css` and unused by the composer. A selector for it matches nothing.
- Playwright is not run locally in this repo. `apps/web/tests/e2e/foundation.spec.ts` was edited for the tier picker and has not been run.
