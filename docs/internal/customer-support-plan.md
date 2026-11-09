# Customer support plan

**Status.** Draft for Rizky's review, revised 2026-11-02 after his comments on the design canvas. Nothing here is built. Written against `main` at `b79a5275`, which is also where `tester/chat-first` is. Every `file:line` below was read at that commit. The design canvas (private to Rizky) is the visual version of this page: https://claude.ai/artifact/5XvrxPiGb6swTbxe6DHMKd

## The recommendation

Customer support in Nultron means the desk owner's own customers get answers while the owner works. Customers write on WhatsApp, the main channel, or Telegram, the backup. Nultron answers on its own from the owner's Knowledge Base, in three tiers:

1. **Retrieval.** A repeated question reuses an earlier answer at no cost. A new one reads the 4 best passages from the sources the owner marked for customers, and one call to the cheapest model answers from those passages only.
2. **The Support agent.** When retrieval falls short, an agent searches the same sources again in other words.
3. **The owner.** Whatever the agent is unsure of goes to the owner. The customer gets a holding reply once, and Chat lists the conversation under Needs you.

Every answer must cite a passage, and every number in it must appear in that passage, before it is sent. The owner sees what went out in Chat and can correct any answer.

Four phases deliver it. Phases 1 and 2 add no product mode, no rail entry and no new route into the server. Phase 3 (WhatsApp) needs a public webhook route, and Phase 4 (the agent tier) needs a support mode. Each waits for Rizky's word under `AGENTS.md:165` and the hosted-security rules.

## Decisions

### Made by Rizky on 2026-11-02, in canvas comments

| # | Decision |
|---|---|
| D1 | Support is for the desk owner's own customers, not help with Nultron itself. |
| D2 | Answers go out automatically. The owner does not press Send on each reply. |
| D3 | Answers come from the Nultron Knowledge Base, from files uploaded there. |
| D4 | What retrieval cannot answer falls back to the agents before it reaches the owner. |
| D5 | WhatsApp is the main channel and Telegram the backup. |

### Still open

Each row has the default this plan assumes until he answers.

| # | Question | Default | Blocks |
|---|---|---|---|
| O1 | Which Knowledge Base sources may an automatic answer use? | Only the sources the owner marks for customers. The rest of the Knowledge Base is never searched for a stranger. | Phase 2 |
| O2 | The limits: answers per customer each hour, and per desk each day. | Placeholders in one config file, set from the first staging week. | Phase 2 |
| O3 | Free or paid? | Free on every plan. Support uses no computer, and routines are free for the same reason (`AGENTS.md:119`). | Phase 2 |
| O4 | Which language does a reply use? | The customer's, when it is clear. Otherwise the desk's locale. | Phase 2 |
| O5 | May the host take a public webhook route for WhatsApp? | Not until Rizky says yes. It is the first unauthenticated inbound write besides the billing webhook, which Caddy answers with 404 today (`webapp-deploy/Caddyfile:179-180`). | Phase 3 |
| O6 | Who owns the Meta business account and the WhatsApp number? | Rizky's company, with a number used only for the API. Business verification can take a while, so it should start now. | Phase 3 |
| O7 | May the agent tier add a `support` product mode? | No until he says yes. Until then a weak match goes straight to the owner. | Phase 4 |
| O8 | How much history is kept? | The last 200 messages per conversation, as Channels keeps today (`packages/core/src/channels/index.ts:27`). | Phase 1 |

## Architecture

Five layers, top to bottom. "New" is new code, "changes" extends code that exists, and "exists" is reused as it is.

| Layer | Part | State | What it does |
|---|---|---|---|
| Where customers write | WhatsApp Business | New (Phase 3) | Meta pushes each message to a webhook route on the desk. |
| | Telegram bot | Changes | The desk asks Telegram for messages. Today `getUpdates` sends `timeout: 0` (`packages/host/src/channels/telegram.ts:245-250`); a long poll holds the request open so a message arrives in about a second. The client timeout (`TELEGRAM_TIMEOUT_MS`, `telegram.ts:30`, 15 s) must exceed the poll's. |
| Inbox | Customer conversations | Changes | One per person per channel, stored as channel records in the Channels file store. |
| Answer pipeline | Answer cache | New | A question close enough to an answered one, whose cited sources have not changed, reuses that answer. No model call. |
| | Retriever | Changes | `retrieveChunks` (`packages/host/src/knowledge.ts:891`) already returns the top 4 passages with scores. It gains `onlySourceIds`, filled by the host from the support settings, and the pipeline applies a minimum score. |
| | Answer writer | New | One call to the cheapest live model, with a fixed prompt, the question and the 4 passages. No tools and no agent loop. |
| | Checker | New | The answer must cite a passage, and every number in it must appear in a cited passage. `guardNumbers` (`packages/core/src/finance/number-guard.ts:173`) already does the number half for Finance. |
| | Sender | New | Checks the limits, pause, the outbound guard and, on WhatsApp, the 24-hour window, then sends on the channel the message came from. |
| | Support agent | New (Phase 4) | Gets the question and the passages, may search the customer sources again, and its answer passes the same checker. |
| | Handoff | New | Sends the holding reply once, marks the conversation for the owner and raises the Chat notice. |
| Services it reuses | Knowledge Base | Exists | Passages of at most 800 characters with 120 of overlap (`packages/host/src/knowledge-text.ts:109`, `:112`), embedded through the gateway with a local fallback (`packages/host/src/knowledge-embed.ts:97`, `:120`), plus a full-text index. |
| | Model gateway | Exists | The pinned gateway and job model fallback. |
| | Guards | Exists | The injection scan on tool-sourced text (`packages/core/src/security/injection-guard.ts:130`), the outbound guard and PII masking. |
| | Usage and spend gate | Exists | `recordTokenUsage` (`packages/host/src/usage-record.ts:182`) meters each answer, and the entitlement check gates gateway spend. |
| | Support store | New | Settings, answer log and cache, one folder per desk. |
| Where the owner sees it | Chat | New | What Support answered today, Needs you, and Correct it on any answer. |
| | Channels page | Changes | Connects both channels, lists customers, and holds the auto-answer switch and Pause. |
| | Knowledge Base page | Changes | A mark on each source: customers may get answers from it. |

The pipeline runs in the host, started by the listener or the webhook after a message is filed. It is not a Chat run and writes into no thread, so customer text never appears as the owner's words. One embedding call per new question serves both the cache lookup and retrieval.

## Data shape

Customer conversations extend the channel records (`packages/core/src/channels/index.ts:34-67`). The support records are new and live in a folder per desk beside the channels.

```ts
// packages/core/src/channels/index.ts
export const CHANNEL_KINDS = ["whatsapp", "telegram"] as const;
export const CHANNEL_ORIGINS = ["owner", "customer"] as const;

export type ChannelRecord = {
	// the fields at index.ts:34-50, unchanged
	kind: (typeof CHANNEL_KINDS)[number];
	origin: (typeof CHANNEL_ORIGINS)[number];
	/** customer only. Answering alone is legal only while this is "auto". */
	handledBy?: "auto" | "owner";
	handoffReason?: HandoffReason;
	/** WhatsApp only: free-form replies are allowed until this time. */
	windowClosesAt?: number;
};

export type ChannelMessage = {
	// the fields at index.ts:54-67, unchanged
	sentBy?: "owner" | "auto";
	tier?: "cache" | "retrieval" | "agent";
	answerId?: string;
};

export type HandoffReason = "not_found" | "asked_for_person" | "check_failed" | "cap_reached" | "paused" | "window_closed";
```

```ts
// packages/core/src/support/types.ts
export type SupportSettings = {
	autoAnswer: boolean; // only the owner's press turns it on
	paused: boolean;
	sourceIds: readonly string[]; // sources marked for customers (O1)
	holdingReply: string | null; // null uses the built-in copy
	minScore: number; // set from an eval of real questions, not guessed
	caps: { perCustomerHour: number; perDeskDay: number }; // O2
	updatedAt: number;
};

export type AnswerRecord = {
	id: string;
	conversationId: string;
	question: string;
	answer: string;
	tier: "cache" | "retrieval" | "agent";
	citations: readonly { sourceId: string; chunkId: string }[];
	tokens: { in: number; out: number };
	checks: { cited: boolean; numbersMatch: boolean };
	sentAt: number;
	correction?: string;
};

export type CacheEntry = {
	questionText: string;
	questionVector: readonly number[];
	vectorModel: string; // a degraded local vector never matches a gateway one
	answer: string;
	citations: AnswerRecord["citations"];
	sourceVersions: Readonly<Record<string, number>>; // dropped when a cited source re-indexes
	hits: number;
	fromAnswerId: string;
};
```

- **Storage.** `localDataDir()/support/<workspaceId>/settings.json`, `answers.jsonl` (the last [N] records) and `cache.json`, read through zod like the channel files. `support` joins `HOST_RESET_ENTRIES` (`packages/host/src/handlers/settings.ts:501`) and the desk-delete purge.
- **Caps on records.** 500 customer conversations per desk, outside the 20 owner channels (`packages/core/src/channels/index.ts:23`). Past that the oldest by `lastReceivedAt` goes.
- **A conversation's three states.** Answered automatically (`handledBy: "auto"`), Needs you (handed off, holding reply sent), and With you (the owner replied). Only the owner's press hands a conversation back to `auto`. Pause is desk-wide: every new message waits under Needs you.
- **Correct it.** The owner's correction is sent to the customer, written to the answer record, and replaces the cache entry, so the next same question gets it.

## Host enforcement

The renderer shows cards, counts and switches. Every rule below is a host check.

- **Turning it on.** `autoAnswer` changes only through the owner's press on the Channels page or a Chat card. A message, file or customer text cannot switch it.
- **Scope of knowledge.** The retriever's `onlySourceIds` comes from the support settings, never from a model's arguments. A support run gets no desk-wide knowledge injection (`packages/host/src/knowledge.ts:972`).
- **Before any model call.** A cache hit sends with no call. A score under `minScore` hands off (Phase 2) or goes to the agent (Phase 4). Limits are checked first; past one, the conversation is handed off.
- **The writer.** One call, no tools, a fixed prompt, the customer's question fenced as quoted text, and the 4 passages. Its output must parse as an answer with citations, or it becomes `check_failed`.
- **The checker.** At least one citation to a passage that was retrieved for this question, and `guardNumbers` over the answer against the cited passages. Any failure is a handoff or, in Phase 4, the agent.
- **The sender.** Sends only to a customer record on the asking desk, only while the desk is not paused and the conversation is `auto`, and only within the limits. It is registered with the outbound guard (`packages/core/src/security/outbound-guard.ts`). On WhatsApp, after `windowClosesAt` it sends only an approved template or hands off with `window_closed`.
- **The listener.** One per desk with a connected Telegram bot, one request at a time, backoff after failures, stopped on disconnect, desk deletion and Start over. It makes no model call. Two desks on one bot token steal each other's updates ([`maps/channels.md`](maps/channels.md), "Gotchas"), so a token is bound to one desk.
- **The webhook (Phase 3).** Meta signs each request with `X-Hub-Signature-256`, an HMAC of the body under the app secret. The route verifies it before parsing, is exempt from the session and CSRF checks on that one path only, is rate-limited, and gets its own Caddy rule. On the preview box it must also pass the knock gate and Basic Auth some other way.
- **Spend.** Every model call goes through the gateway gate and the entitlement check (`packages/host/src/gateway-gate.ts:573-575`) and is metered with `recordTokenUsage`.

## Token use

These are estimates. Nothing has been measured.

- A passage is at most 800 characters, about 200 tokens. Four passages, a short fixed prompt, the question and a short answer come to about 1,300 tokens per retrieval answer.
- A cache hit costs no model tokens. A question below `minScore` costs one embedding call and nothing more.
- The agent tier costs more per answer and runs only when retrieval falls short.
- The figure to watch on staging is the share of questions answered by the cache. The answer log records the tier and tokens of every answer, so the Usage page can show it.

## Locale

- **Screen copy.** Every new string goes in both `apps/web/locales/en/` and `apps/web/locales/id/` in the same change: Chat's answered list and notice in `chat`, the channel and auto-answer copy in `channels`, the source mark in `knowledge`. The parity tests cover each namespace.
- **Replies to customers.** A `support` surface joins `OUTPUT_LANGUAGE_SURFACES` (`packages/core/src/output-language.ts:3-15`), with rule text in both locales, following O4.
- **The holding reply.** Built-in copy in both locales lives host-side beside the pipeline. The owner may replace it.
- **No gateway name** in any new string (`AGENTS.md:36`).

## Security register rows

Numbers are assigned when each phase lands, because the tester takes numbers too. The next free number at this commit is SR-191.

| Row | Severity | Lands in | Guards | Gate |
|---|---|---|---|---|
| Strangers' text reaches a model | Medium | Phase 1 | Quoted and fenced customer text, the injection scan, a writer with no tools | Blocks promoting Phase 1 |
| Customers' personal data is stored | Low | Phase 1 | The caps, removal by the owner, Start over, desk deletion. Phase 1 confirms whether PII masking covers this text before the model call. | Blocks promoting Phase 1 |
| The desk writes to outsiders unattended | High | Phase 2 | Off by default, the checker, limits, Pause, the holding reply, the outbound guard, Correct it | Blocks Phase 2 auto-answer |
| Knowledge leaks to outsiders | High | Phase 2 | Host-filled `onlySourceIds`, no desk-wide injection, the citation check | Blocks Phase 2 auto-answer |
| Strangers spend the owner's tokens | Medium | Phase 2 | The cache, the score gate before any model call, the limits, the spend gate, Pause | Blocks Phase 2 auto-answer |
| A cached answer reused for a different question | Medium | Phase 2 | A strict similarity threshold, source versions, no match across vector models, Correct it | Blocks Phase 2 auto-answer |
| A public webhook route into the server | High | Phase 3 | The signature check before parsing, one exempt path, a rate limit, a Caddy rule | Blocks Phase 3 |
| An agent answering strangers | Medium | Phase 4 | Search in the customer sources is its only tool, the same checker, a handoff when unsure | Blocks Phase 4 |

Two existing rows get worse once a desk talks to customers, and each phase re-reads them: SR-98 (on a hosted desk any member can connect or disconnect the bot token, `docs/internal/security-register.md:2730`) and SR-166 (virtual agents read the Knowledge Base and can send questions to the web).

## Phases

Each phase lands on `tester/chat-first`, because each is a new feature (the "Where a change goes" table in `AGENTS.md`). Each ends in a drive on webdev with a channel sandbox (`scripts/telegram-sandbox.ts` for Telegram; a WhatsApp sandbox is part of Phase 3), then a drive on the staging instance, then a promotion pull request Rizky approves. A bug found in shared Channels code along the way is fixed by a pull request to `main`, then merged into the tester. This plan is a doc and goes to `main`.

Telegram comes first only because it needs no new route into the server and no approval from Meta. It proves the whole pipeline while O5 and O6 are settled.

### Phase 1. Customer inbox

**Needs.** O8.

**Builds.** One channel interface (receive, send, reply window) with Telegram behind it on a long poll; customer records in the channel store; the listener per desk; the customers list on the Channels page; the for-customers mark on Knowledge Base sources; and review mode in Chat, where a drafted reply goes out only when the owner presses Send. Review mode stays as the setting for owners who keep auto-answer off.

**Done when, on webdev.** A message posted to the sandbox from a new chat id shows on the Channels page within about two seconds. Asking Chat "any customers waiting?" lists it. A drafted reply reaches the sandbox only after Send, with exactly the edited text.

**Tests.** A private message becomes a customer record and a group message stays unmatched. The listener stops on disconnect, desk deletion and Start over. Another desk's conversation id reads as missing. The locale parity tests stay green.

### Phase 2. Automatic answers by retrieval

**Needs.** O1, O2, O3, O4.

**Builds.** The support store, the answer cache, `onlySourceIds` on retrieval and the score gate, the writer, the checker, the sender with limits and Pause, the holding reply and handoff, Chat's answered list with Needs you and Correct it, and the auto-answer switch on the Channels page. No new mode.

**Done when, on webdev.** With a price list marked for customers and auto-answer on, a sandbox question about a price is answered with a citation and no press. The same question again is answered from the cache, and the answer log shows 0 tokens. A question the files cannot answer gets the holding reply, shows under Needs you, and the log shows no model call. A source not marked for customers is never quoted. Going past a limit hands the conversation off. Pause stops every send.

**Tests.** Retrieval never returns a source outside `sourceIds`. An answer with no citation, or a number not in a cited passage, is never sent. A cache entry is dropped when its source re-indexes and never matches across vector models. `autoAnswer` cannot change from customer text. Every handoff reason is reachable. The `support` surface has rule text in both locales.

### Phase 3. WhatsApp, the main channel

**Needs.** O5, O6.

**Builds.** The webhook route with the signature check, a WhatsApp Cloud API adapter behind the channel interface, `windowClosesAt` and template messages for replies after the window closes, and a local WhatsApp sandbox that signs requests the way Meta does.

**Done when, on webdev.** A signed sandbox message gets the same answer the Telegram bot gives. An unsigned or wrongly signed request is refused before parsing. A reply after the window closes goes out as a template or hands off with `window_closed`. Then a Meta test number on staging.

**Tests.** The signature check refuses a changed body. The exempt path is exactly one route. The window rule holds at its boundary.

### Phase 4. Support agent fallback

**Needs.** O7.

**Builds.** A `support` entry in `PRODUCT_MODES` (`packages/core/src/agents/product-modes.ts:4-19`) and its harness spec in `packages/core/src/harness/modes/support.ts`, whose only tool is a scoped `knowledge_search` over the customer sources. The same checker runs after it. The first-desk literal stays `["chat"]`.

**Done when, on webdev.** A question worded unlike the files is answered by the agent with a citation, and an agent answer that fails the checks is handed off.

**Tests.** A support run cannot bind any tool beyond scoped search. Its search never leaves `sourceIds`. The registry is a `Record<ProductMode, …>` (`packages/core/src/harness/specs.ts:19-34`), so the compiler forces the new spec.

## Not in this plan

- **Help with Nultron itself.** A "report a problem" path for desk owners is a separate small task if the beta needs one.
- **Reading the owner's personal chats.** Neither channel allows it: a Telegram bot sees only messages sent to it, and WhatsApp's API sees only the business number.
- **Unofficial WhatsApp clients.** Tools that drive WhatsApp Web break WhatsApp's terms and get numbers banned.
- **Matching one person across channels.** A phone number and a Telegram account cannot be matched automatically, so they stay two conversations.
- **Customers in groups.** Only direct messages are answered.
- **Assignees, queues, timers and shared inboxes.** Those are team features, and a desk has one owner.
- **Orders or payments taken in a reply.**

## Appendix A. Alternatives rejected

- **The owner presses Send on every reply.** It was this plan's first default. Rizky asked for automatic answers. It stays as review mode, for owners who keep auto-answer off.
- **An agent run for every question.** An agent with tools costs far more per answer than one call over 4 passages. The agent is the second tier, not the first.
- **Sending whole files to the model.** Retrieval sends 4 passages of at most 800 characters each.
- **Customer messages as messages in a chat thread.** In a thread, `user` messages are the owner's words. Customer text there would read as the owner's instructions. The pipeline runs outside threads.
- **Telegram by webhook.** It would need the same public route WhatsApp needs, for no gain over a long poll.
- **A new database table now.** The channel store is a file store on purpose ([`maps/channels.md`](maps/channels.md), "Gotchas"). Customer conversations reuse its records.
- **Wait for routines.** The listener is one loop per desk, not a scheduler.

## Appendix B. Risks

- **The score threshold.** A threshold too low sends wrong answers, and too high hands off answerable questions. Set it from an eval of real customer questions on staging before auto-answer is on for anyone.
- **Degraded embeddings.** When the gateway's embeddings are down, the Knowledge Base falls back to local vectors (`packages/host/src/knowledge-embed.ts:120`). Scores from those are not comparable, so the pipeline hands off rather than answer from them.
- **Meta's rules and prices change.** The 24-hour window and template pricing are Meta's to change. The adapter keeps them in one place.
- **Hosted single process.** The host is one process on one SQLite file (`AGENTS.md`, "Hosting and scaling"). A held-open Telegram request per desk and a webhook route both run on it.
- **A tester's bot or number reaching real customers.** Staging uses the sandboxes until Rizky says otherwise.
- **The 200-message limit.** A long history loses its oldest messages.

## Appendix C. Reading list

- [`maps/channels.md`](maps/channels.md) and [`telegram-channels-plan.md`](telegram-channels-plan.md) for the Telegram client, store and egress rules.
- [`maps/knowledge-flows.md`](maps/knowledge-flows.md) for ingestion and retrieval.
- [`maps/agent-tools-and-files.md`](maps/agent-tools-and-files.md) for tool trust, the injection guard and the egress guard.
- [`maps/virtual-agents.md`](maps/virtual-agents.md) and [`chat-first-plan.md`](chat-first-plan.md) for agents, the side panel and free and paid.
- [`maps/hosted-security-controls.md`](maps/hosted-security-controls.md) before Phase 3's route.
- [`security-register.md`](security-register.md), SR-98, SR-112, SR-166 and SR-167.
- Several line numbers in `maps/virtual-agents.md`, `maps/knowledge-flows.md` and `maps/agent-tools-and-files.md` have drifted from the code at `b79a5275`. Cite by symbol when in doubt, and refresh those pages in the phase that touches them.
