# PII

Chat (and other model runs) keep the prompt the owner typed. Before that text becomes the model/tool prompt, the host replaces local PII matches with `[email]`, `[phone]`, `[id]`, `[card]` and — since 2026-09-17 — `[nik]`, `[npwp]`, `[account]`. There is no warn banner and no Send anyway — the system handles it. Finance has a **second, earlier** guard with its own three notices and one upload warning; it is the only mode that shows the owner a count of what was hidden. The map is [`docs/internal/maps/pii-and-key-security.md`](../../../../docs/internal/maps/pii-and-key-security.md).

Product: both · Instance: main :3000

## Sub-features

- `pii-keep-original` the composer and `message-list` show the exact text the owner sent.
- `pii-mask-outbound` `createRuntime()` masks `systemPrompt` and history text parts before stub or live execute. Image/video studio tools use the same `maskPii`; every web search query is masked inside the search backends by the outbound guard (`sendableSearchQuery`, 2026-10-13), which also refuses a query carrying a credential, an encoded blob or, in a Chat turn, the turn's private text.
- `pii-local-scan` is regex only (`scanPii` / `maskPii` in `@agentforge/core/pii`). No remote classifier.
- `pii-id-indonesia` the same `scanPii` also masks a NIK (`[nik]`), a dotted NPWP (`[npwp]`), a labelled bank account — `No. Rekening 1234567890` → `[account]` — and an `08xx` local phone (`[phone]`). Not Finance-only: this fires in Chat too. An account number with a word between the cue and the digits ("Rekening Bank: 1250000000") is **not** masked, by design.
- `pii-finance-notice` Finance redacts before the prompt is built and reports a count. Three testids, all read-only: `finance-upload-pii` on the upload step, `finance-auto-pii` on the prompt-first read ("before reading", `finance-auto-parts.tsx:194`) and `finance-result-pii` on the result (`finance-steps/finance-result-notices.tsx:21`). There is no confirm, dismiss or send-anyway control on either — a notice is all there is.
- `pii-no-banner` `pii-warning` and `pii-send-anyway` are gone. A lone `@` is not PII.

## How to get to it (user POV)

- Open Chat (`/chat` or `mode-chat`).
- Type a prompt that includes an email (or phone). Send as usual.
- Your bubble still has the email. The model only sees `[email]`. The stub assistant line does not show that token: with no calculator or clock in the prompt it is the need-key sentence ("I need a Toko Token gateway key in Settings to answer that."), which never quotes the prompt.

## Driving it with the Nultron harness

Preconditions:

- Doctor exits 0.
- `runtime: "stub"` for a stub-proof send.

- **Open Chat.** Go to `/chat`. `composer-text` and `composer-send` are visible. `pii-warning` count is 0.
- **Send original.** Fill `composer-text` with `VERIFY pii <run-id> contact me at verify@example.com`, where the id has no digit-operator-digit (a date such as `2026-10-05` becomes the calculator expression `2026-10`, `stub-runtime.ts:60`) and none of the words `date`, `time`, `today`, `now`, `clock`, `jam` (`chat-locale.ts:30`), or the reply is the calculator or clock answer and not the need-key sentence. Click `composer-send`. `message-list` contains that exact email (20s). `composer-send` returns to `Send`.
- **Outbound mask.** The user bubble in `message-list` still contains `verify@example.com`. The newest `message-output` is the stub need-key sentence and contains neither `[email]` nor `verify@example.com`. Do not treat a missing `[email]` in that line as a failed mask — `createRuntime()` runs `maskOutboundRunInput` before execute (`packages/core/src/runtime/create-runtime.ts`), and `StubRuntime` answers with `stubChatCopy().needKey` instead of echoing history (`packages/core/src/runtime/stub-runtime.ts`). The mask itself is the unit proof in `packages/core/src/security/pii.test.ts`.
- **Non-trigger.** `hello @ world` sends with no mask token and no banner.
- **IDE proof.** Screenshot under `evidence/pii/<run-id>/` with the original email in the user bubble and the need-key sentence in the stub reply.
- **Cloud.** Foundation sends have no email — they must still pass. Do not add a banner assert.

## Gotchas

- Masking is host-side, on the way into the model. Do not look for a Chat banner.
- Bare digit runs (market cap, volume) are not phones or IDs. Formatted phones (`+1 (415) 555-2671`) and SSN-style IDs still mask. The user bubble still has the original text.
- **Money is never masked, and that is the assertion that matters on a Finance desk.** A rupiah total written the Indonesian way (`1.250.000.000.000`) and a bare total that happens to pass Luhn both used to come back as `[phone]` / `[card]`; three guards now stop that, and the host re-checks afterwards and puts a figure back if redaction ate one. A number that changed between the typed text and the model's copy is a fail, not a mask working.
- **A Finance PII count is not proof a mask fired.** A figure that was hidden and then restored is filtered out of the count, so the number the notice shows is identifiers only.
- `[name]` is a token that exists and is essentially never seen. A name column in a Finance sheet becomes a stable pseudonym — `Karyawan 1`, `Karyawan 2` — so the rows stay distinguishable and the totals still add up. Do not assert `[name]`; assert `Karyawan 1`.
- A name in free text with no column header above it is **not** detected, deliberately. Do not file it.
- Do not paste real personal data into Cloud evidence. Use `example.com` addresses.
- `scanPii("hello @ world")` is empty — no mask.
- **`:3000` is the main checkout's webdev and may carry a real saved key.** Read `GET /api/v1/settings` first: `hasOpenai` and `gateway.status` tell you (doctor's `runtime` follows the same key). With a key saved, `composer-send` is a live, billed call, and the "stub need-key sentence" in the walk above never appears. The PII walk needs a keyless desk, so use a throwaway `AGENTFORGE_DATA_DIR` with `AGENTFORGE_RUNTIME=stub` (SKILL.md **Launch**) rather than sending on a live desk. The unit proof in `packages/core/src/security/pii.test.ts` does not need a send at all.
- **Scope of "masked".** The mask is on the outbound run input (`createRuntime` wraps the stub and live runtimes in `withToolSecrets`, which calls `runtime.execute(maskOutboundRunInput(input))`, `create-runtime.ts:26`; the only production `createRuntime` sites are `runs.ts:407`, `job-regen.ts:155` and `edit/agent-run.ts:265`). It does **not** cover Chat's knowledge retrieval: `knowledgeInjection(tenant, userText)` (`packages/host/src/runs.ts:195`) runs on the raw typed text and `embedQuery` (`knowledge-embed.ts:341`) sends it, unmasked, to the gateway's `/embeddings` on a keyed desk with indexed vectors. That is an embedding request and not a prompt, so "the model never sees the address" stays true, but "never leaves in the clear" overstates it; it is not drivable on a stub desk. `maskPii` also covers music prompts (`studio-generate.ts:527`, `:530`, `:541`, `:632`, `:659`), Images (`:312`), Videos (`core/src/videos/harness.ts:190`), Edit (`edit/generate.ts:44`), Market (`market/tools.ts:88`, `global-news.ts:67`, `fundamentals.ts:96`, `sentiment-sample.ts:53`), Knowledge cards (`knowledge-ingest.ts:35-37`) and keyless search (`keyless-search.ts:87`).
- Finance notice copy: `finance-upload-pii` reads "{n} personal identifiers were hidden before sending" (`en/finance.json:38`), `finance-result-pii` "...before anything was sent" (`notice.pii`, `en/finance.json:598`), and `finance-upload-warnings` (`finance-file-upload.tsx:91`) "{n} cells held a figure the privacy check had hidden; they were put back" (`:36`). `SKILL.md` has no pii row; `finance-result-pii` is listed nowhere else. `pii-warning` and `pii-send-anyway` exist nowhere in `apps/` (count 0 is true everywhere).
- **Driven 2026-10-05 (maintain3): not driven.** `:3000` is a live, billed desk (`hasOpenai: true`), where the need-key sentence never appears and a send is a paid exchange; the stub half of this recipe needs a stub desk, and the isolated stub instance died with the session before this recipe was reached. The mask itself is proven only by `packages/core/src/security/pii.test.ts:55-96` (the Indonesian identifiers at `:88`).
- **Driven 2026-10-09 on a throwaway stub webdev desk.** A Chat send of "Email me at rina.verify@example.com about the budget" kept the address in the user bubble, and the stub reply was the need-key sentence with neither `[email]` nor the address. The Finance notices and the knowledge-embed path were not driven. Evidence: `drive5.json` (`pii_stub_send`). Driven 2026-10-16 on a throwaway stub webdev desk: PASS live. Evidence: `evidence/pii/2026-10-16-maint/`.
