# WhatsApp and the omnichannel customer inbox

**Status.** Draft for Rizky's review, 2026-11-02. Nothing here is built. Written against `main` at `b79a5275`, which is also where `tester/chat-first` is. It builds on [`customer-support-plan.md`](customer-support-plan.md) (PR #197, not merged yet), which already holds Rizky's decisions D1 to D5 and the answer pipeline. This page does not repeat that plan. It covers what the new ask adds: WhatsApp as the first channel, a monitoring dashboard, and one inbox across channels.

**The ask (Rizky, 2026-11-02).** "Create whatsapp integration, and a customer service feature inside here, where the dashboard to monitor, something like an omnichannel."

## The recommendation

Build one customer inbox that any channel can plug into, with WhatsApp as the first channel and Telegram as the second. Customers write on WhatsApp. Nultron answers on its own from the owner's Knowledge Base (the three tiers in the support plan). The owner watches and steps in from a new **Customers** page in the account rail.

Five choices, each with a reason:

1. **WhatsApp Business Cloud API, straight from Meta.** No middleman vendor. A reseller (Twilio, 360dialog and similar) adds a second bill and a second secret, and our adapter would still speak webhooks and REST. Unofficial WhatsApp Web libraries are out: they break WhatsApp's terms and get numbers banned.
2. **WhatsApp before Telegram.** The support plan put Telegram first only because it needs no Meta approval. Nothing in the build needs Meta until the last live test, because a local sandbox can sign requests the way Meta does. So the build can start now while Meta's business verification runs in the background.
3. **A channel adapter interface from day one.** Receive, send, reply window. WhatsApp and Telegram are two adapters behind it. That is what "omnichannel" means in code.
4. **Customer conversations go in SQLite, not in the Channels JSON files.** This changes the support plan, so it is decision A below. Reasons in "Data".
5. **Inbox first, auto-answers second.** Phase 1 is a working WhatsApp inbox with no model in it: customers write, the owner sees and replies from the dashboard. It is useful alone and carries none of the "desk writes to strangers unattended" risk. Auto-answers (Phase 2) then sit on a plumbing layer that is already proven.

## What Meta's platform means for the design

These are facts from Meta's docs and third-party guides, read on 2026-11-02. Re-check the pricing and policy lines before launch, because Meta changes them.

- **Inbound is push only.** Meta calls a webhook we expose. There is no polling. Our host binds loopback behind Caddy and today has one unauthenticated inbound route, the billing webhook, which Caddy answers with 404 (`webapp-deploy/Caddyfile:179-180`). A WhatsApp webhook is the second, which is why the support plan holds it as O5. ([Hookdeck's webhook guide](https://hookdeck.com/webhooks/platforms/guide-to-whatsapp-webhooks-features-and-best-practices))
- **Two webhook rules.** A GET handshake echoes `hub.challenge` when `hub.verify_token` matches. Every POST carries `X-Hub-Signature-256`, an HMAC-SHA256 of the raw body under the Meta app secret, to check before parsing JSON. Delivery is at-least-once, in no guaranteed order, retried for up to 7 days on non-200, so the endpoint answers 200 fast and dedupes on message id. (Same guide.)
- **The 24-hour window.** A customer's message opens a 24-hour window. Inside it, free-form replies cost no Meta fee. After it closes, only an approved template message can be sent, and templates are charged per message by category. Meta moved from conversation pricing to per-message pricing on 2025-07-01. ([Meta pricing page](https://developers.facebook.com/docs/whatsapp/pricing))
- **AI policy.** From 2026-01-15 Meta bars "general-purpose" AI bots from the Business API. Business-specific support bots are allowed when the bot is ancillary to a real business service. That is our case, and the bot must stay narrow: answer from the owner's own files, hand off the rest. This is respond.io's reading of the terms, not Meta's text, so read Meta's terms before launch. ([respond.io](https://respond.io/blog/whatsapp-general-purpose-chatbots-ban))
- **Pricing for Indonesia** I could not confirm from Meta's page, which lists no per-country rates in the text I could read. Model tokens are the main cost for replies inside the window. Templates are the only Meta charge we would trigger, and only after the window closes.

## Architecture

```
 WhatsApp (Meta)           Telegram
   │ signed webhook          │ long poll
   ▼                         ▼
 ┌────────── channel adapters (one interface) ──────────┐
 │ verify + parse inbound · send · reply window         │
 └───────────────────────┬───────────────────────────────┘
                         ▼
 conversations + messages (SQLite)  ◄── dashboard reads / owner replies
                         │
                         ▼
 answer pipeline (support plan): cache → retrieval → agent → handoff
                         │   checker · limits · Pause · outbound guard
                         ▼
 adapter.send() ──► customer
```

### The adapter interface

```ts
interface ChannelAdapter {
  kind: "whatsapp" | "telegram";
  // Webhook channels verify the signature before anything is parsed.
  parseInbound(raw: Buffer, headers: Headers): InboundEvent[];
  send(to: ConversationRef, out: OutboundMessage): Promise<SendResult>;
  // WhatsApp: open for 24 h after the last customer message. Telegram: always open.
  replyWindow(conv: ConversationRef, now: number): { open: boolean; closesAt: number | null };
}
```

The adapter owns everything transport-specific: wire format, message ids, window rules, template sending, rate limits. The pipeline and the dashboard never mention WhatsApp. Meta's rules live in one file, so a rule change touches one file.

### Data

Four tables in one new migration (the next one after `0022`), each carrying `tenant_id` and `workspace_id` like `desk_files`:

| Table | Holds |
|---|---|
| `channel_endpoints` | One row per connected number or bot: kind, external id (WhatsApp `phone_number_id`), desk, status. The webhook finds the desk through this row. |
| `customer_conversations` | One per person per channel: contact display name and handle, `handled_by` (`auto` or `owner`), handoff reason, `last_inbound_at`, `window_closes_at`, unread count, state (`auto`, `needs_you`, `with_you`, `closed`). |
| `customer_messages` | In and out: external id (unique per endpoint, which makes redelivery harmless), text, `sent_by` (`customer`, `auto`, `owner`), tier, citations, check results, tokens, delivery status (`sent`, `delivered`, `read`, `failed`, from Meta's status webhooks). |
| `support_answers` | The answer log the support plan describes, which the dashboard totals read. |

Support settings and the answer cache can stay as small files per desk, as the support plan has them. The owner's own channels (the 20 Telegram groups and their JSON files) are untouched.

**Why this departs from the support plan's "no new table".** That reason was Phase 3 tenancy owning `packages/db` in September. Tenancy has landed, and `0022` is the pattern. Three things now argue for a table:

1. **The webhook has no session.** It must find the desk from `phone_number_id` in the payload. A lookup in a table is one query. With the file store it is a scan of every desk's folder.
2. **Redelivery needs an atomic dedupe.** At-least-once delivery means the same message arrives twice. A unique index settles it. Read-modify-write on a JSON file under concurrent webhooks races.
3. **The dashboard counts things.** Waiting, answered today, by channel, by tier, response time. Those are queries, not file reads.

Customer conversations keep the support plan's caps (500 conversations, 200 messages each) and join "Start over" and desk deletion (`HOST_RESET_ENTRIES`, `tenant-purge`).

### The webhook, and who it acts as

One new route, `GET` and `POST /api/v1/channels/whatsapp/webhook`. It copies the billing webhook's exemption: a literal path (never a prefix) skipped by the session gate and the CSRF check (`CSRF_EXEMPT_PATHS` in `http-adapter.ts`, `UNGATED_POSTS` in `auth/routes.ts`).

Order inside the route:

1. Cap the body, read it raw.
2. Check the HMAC against the **install-wide Meta app secret**, held in server env like the billing secret. Wrong or missing means 401 and nothing is parsed. No secret configured means the route refuses everything, as the billing one does.
3. Parse, then look up `phone_number_id` in `channel_endpoints`. Unknown means 200 and drop, so Meta does not retry forever.
4. Insert each message under the unique index. Answer 200 now. The pipeline runs after the response.

**The new, security-sensitive piece is step 3 to 4.** In server mode `getTenant` refuses when no session exists ("a job that outlives its request has no store", `tenant-scope.ts`). A webhook has no browser session by nature, so it needs a narrow "act as this desk" scope that only exists after the signature has passed and the endpoint row has resolved. Nothing else can open it. This is the part to review hardest, and it gets its own security-register row.

Why one install-wide app secret and one literal path, not a URL per desk: it keeps the "one literal path" rule, lets us verify before parsing, and fits how Meta works for a platform that onboards many numbers under its own app. A per-desk URL would let each desk bring its own Meta app, at the cost of a path prefix on the exempt list.

On Caddy the route needs its own rule, and on the preview box it must pass the knock gate and Basic Auth, because Meta's servers cannot answer those. That is a small, checkable change in `webapp-deploy/`, made only on Rizky's word (O5).

### How the agents handle replies

Exactly the support plan's three tiers, now writing to the inbox. Each message in `customer_messages` records which tier answered, the passages it cited and what the checker said. The only new points are about WhatsApp.

- **Window closed.** If the 24 hours have passed, the sender uses an approved template or hands off with `window_closed`. It never sends free text after the window.
- **Non-text messages.** Voice notes, images and documents are filed as a placeholder and handed to the owner (`unsupported_media`). Reading them is a later phase.
- **The customer asks for a person.** Hand off at once, with the holding reply.
- **Disclosure.** The first auto-reply of a conversation says it is an automatic assistant and how to reach the owner. This is good practice and helps with Meta's policy.
- **The owner's Chat agent** gets read tools over the inbox ("any customers waiting?", "what did Dewi ask yesterday?"), so the owner can ask in Chat without opening the page.

### The Customers page

An account-rail page beside Channels, `/customers`. Its scope is monitoring and stepping in. It is not a team tool.

| Area | What the owner sees and does |
|---|---|
| **Today strip** | Answered automatically, Needs you, median first-reply time, share answered from the cache, tokens spent. |
| **Conversation list** | Newest first. Filters: Needs you, Auto, With you, All. Channel filter. Search. A badge with the channel and, for WhatsApp, the time left in the window. Unread marks. |
| **Conversation view** | The full thread. Each reply from us is tagged auto or owner, with its tier, the cited passages and the check results. Delivery ticks from Meta's status webhooks. |
| **Actions** | Reply (the window rule applies), Correct it (the support plan's correction: sent to the customer, written to the log, replaces the cache entry), Take over (stops auto for this conversation), Hand back to auto (only the owner can). |
| **Controls** | Auto-answer on or off, Pause, limits, the for-customers sources. They live here and on Channels. Only the owner's press turns auto-answer on. |

It refreshes by short polling at first. A push stream is a later change if polling feels slow.

**Left out on purpose.** Assignees, queues, SLA timers, shared inboxes and per-agent seats. A desk has one owner (AGENTS.md, "OPC"). The chat-first rule still holds: the Needs you notice and the "any customers waiting?" question are also in Chat, so the owner is not forced onto a separate screen.

## Phases

Each phase ends with a drive on webdev against a sandbox, then a drive on the staging instance, then a promotion pull request Rizky approves (AGENTS.md, "Where a change goes"). New features are cut from `tester/chat-first`. This plan page is a doc and goes to `main`.

| Phase | Builds | Done when |
|---|---|---|
| **0. Now, no code** | Rizky answers the decisions below. Rizky starts Meta business verification. | Answers recorded here. |
| **1. WhatsApp inbox, no model** | The migration and tables. The adapter interface with WhatsApp behind it. The signed webhook route with the scoped desk lookup. A local WhatsApp sandbox that signs requests the way Meta does. The Customers page with the list, the thread and Reply. Delivery status. | A sandbox customer message appears on the page within seconds. A reply sent from the page reaches the sandbox. A redelivered or badly signed request does nothing. Another desk's conversation reads as missing. |
| **2. Automatic answers** | The support plan's Phase 2 on top: cache, retrieval, writer, checker, limits, Pause, holding reply, handoff. The Today strip, Correct it, Take over. | The support plan's Phase 2 done-when, driven through WhatsApp, plus the window rule at its boundary. |
| **3. Live WhatsApp, and Telegram as the second adapter** | A real Meta test number on staging. Templates for replies after the window. Telegram moved behind the same interface on a long poll. | A real WhatsApp message gets a cited answer on staging. Telegram shows in the same inbox. |
| **4. Support agent** | The support plan's Phase 4, on the `support` mode, if Rizky says yes to O7. | As in that plan. |

Phase 1 can start as soon as Rizky agrees to the plan. It needs no Meta account, no new model spend and no auto-sending.

## Decisions I need from Rizky

The first four block the start. My default applies if he says "go" without answering.

| # | Question | Default |
|---|---|---|
| **A** | Customer conversations in SQLite instead of the Channels JSON files (departs from the support plan). | Yes. |
| **B** | Where the monitoring lives: a **Customers** page in the account rail, plus the Needs you notice and read tools in Chat. | Yes. |
| **C** | Build WhatsApp first and move Telegram to Phase 3. | Yes. |
| **D** | Phase 1 is an inbox with no AI, so the first thing he can drive is the monitor and the plumbing. | Yes. |
| **O5** (support plan) | May the host take a public WhatsApp webhook route, and may I change the Caddy rule when we reach staging? | Not until he says yes. Phase 1 builds and tests it locally only. |
| **O6** (support plan) | Whose Meta business account, and which number? | His company, with a number used only for the API. |
| **E** | One Meta app for the whole install (his), with owners connecting numbers to it later through Meta's Embedded Signup. For now only his own desk. | Yes. The alternative, every owner creating a Meta app, is too much setup for the "no setup" rule. |
| **F** | May the first auto-reply say it is an automatic assistant? | Yes. |

The rest of the open questions (O1 to O4, O7, O8) stay as the support plan has them.

## What Rizky supplies, and when

- **Now:** a Meta Business portfolio owned by the company, and the business verification started. I have not confirmed current review times, so assume it can take days to weeks.
- **Before Phase 3 (live test), not before:** a phone number that is not in use on the normal WhatsApp app (a number on the Cloud API generally cannot also be used in the regular app, and I have not checked Meta's "coexistence" option for numbers already on the Business app), a Meta developer app with the WhatsApp product, the phone number id, the WhatsApp Business account id, a system-user access token, and the app secret. The token goes into the desk's `settings.enc` on the Channels page like the Telegram bot token. The app secret goes into the server env.
- **Never in chat or a commit:** the token or the app secret. Phase 1 to 2 use the sandbox, so no secret is needed to build.

## Security register rows

Numbers are assigned when each phase lands. Added to the support plan's rows:

| Row | Severity | Lands in | Guards |
|---|---|---|---|
| A public webhook acts as a desk | High | Phase 1 (local), staging gate | HMAC before parse, one literal path, scoped desk lookup only after both checks, body cap, rate limit, Caddy rule |
| Redelivery or forged ids cause duplicate or cross-desk writes | Medium | Phase 1 | Unique index on (endpoint, external id), desk taken from the endpoint row and never from the payload |
| A customer's phone number is stored | Low | Phase 1 | Caps, removal by the owner, Start over, desk deletion, number masked in logs |
| Policy: the bot drifts into a general assistant | Medium | Phase 2 | Answers only from the owner's marked sources, handoff otherwise |

## Not in this plan

Everything in the support plan's "Not in this plan", and in addition: marketing broadcasts and any business-initiated message that is not a reply; a shared team inbox; voice and image understanding (a later phase); reading the owner's personal chats; calling features.

## Sources

- Meta, [Pricing on the WhatsApp Business Platform](https://developers.facebook.com/docs/whatsapp/pricing): per-message pricing from 2025-07-01, the 24-hour window, free-entry-point windows.
- Hookdeck, [Guide to WhatsApp webhooks](https://hookdeck.com/webhooks/platforms/guide-to-whatsapp-webhooks-features-and-best-practices): the handshake, the signature, retries.
- respond.io, [WhatsApp general-purpose chatbots ban](https://respond.io/blog/whatsapp-general-purpose-chatbots-ban): the 2026-01-15 policy change and the customer-service carve-out. A third-party reading.
- In the repo: `docs/internal/maps/channels.md`, `packages/host/src/http-adapter.ts` (`CSRF_EXEMPT_PATHS`), `packages/host/src/auth/routes.ts` (`UNGATED_POSTS`), `packages/host/src/billing/authenticate.ts`, `packages/host/src/tenant-scope.ts`, `packages/db/drizzle/0022_desk_files.sql`.
