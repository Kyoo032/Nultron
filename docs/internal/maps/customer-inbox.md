# Customer inbox (WhatsApp)

Product: both · Instance: main :3000

Last verified: 2026-11-02, working tree on top of bb502f8 (Phase 1, before its first commit). Driven in Chromium against the local sandbox (`scripts/whatsapp-sandbox.ts`) on a stub-runtime desk; never driven against Meta or on a hosted server.

## Overview

A desk connects one WhatsApp Business number. What customers send to it lands in the desk's own inbox, the owner reads it on **Customers** and answers by hand, and the page shows what is waiting and how today is going. Design, decisions and the later phases: [`../whatsapp-omnichannel-plan.md`](../whatsapp-omnichannel-plan.md).

**Phase 1 is a plain inbox.** No model reads a customer's message, nothing is sent that the owner did not write, and the sandbox stands in for Meta. Phase 2 (an agent drafts replies) and Phase 3 (the live number, templates, the production Caddy rule) are not built. It is not a product mode and has no pack seed.

## How it works

### Connect a number

Rail → Account → **Customers** (`apps/web/components/app-rail.tsx`, `testId="customers-link"`; also `ACCOUNT_LINKS` in `agent-rail.tsx`) → `/customers` (`apps/web/src/App.tsx`) → `CustomersPage` (`apps/web/components/customers-page.tsx`).

`POST /api/v1/customers/whatsapp` → `handlePostWhatsApp` (`packages/host/src/handlers/customers.ts:124`), owner or admin only:

1. `assertPhoneNumberId` and `assertAccessToken` shape-check both values before anything leaves the host.
2. `WhatsAppClient.getPhoneNumber` (`packages/host/src/inbox/whatsapp.ts:361`) asks Graph to read that number with that token. **This is the ownership proof**: a token that cannot read the number never gets it registered, so a desk cannot claim another company's number id and be sent its customers.
3. `connectEndpoint` (`packages/host/src/inbox/store.ts:189`) writes `channel_endpoints`. A number belongs to one desk across the whole install (unique `(kind, external_id)`); another desk's claim is a 409 `channel_conflict`. Connecting a second number disables the first.
4. `saveSettings({ whatsappAccessToken })` puts the token in the desk's slice of `settings.enc` (`packages/core/src/secrets.ts:112`, `KEY_FIELDS`), the same envelope as the gateway key. The renderer sees `connected`, the number, a `sha256:` fingerprint and `pinnedOrigin`; never the token.

`DELETE` forgets the token and disables the endpoint; conversations stay.

### Receive (the public route)

`GET|POST /api/v1/channels/whatsapp/webhook` (`WHATSAPP_WEBHOOK_PATH`, `packages/core/src/inbox/index.ts`) is **the one inbound route that is open to the internet**. It is exempt from the session gate (`UNGATED_GETS` / `UNGATED_POSTS`, `packages/host/src/auth/routes.ts:81,98`) and from CSRF (`CSRF_EXEMPT_PATHS`, `packages/host/src/http-adapter.ts:793`), exactly as the billing webhook is, and it is a literal path, never a prefix. It authenticates by signature and by nothing else.

1. `readBody` (`http-adapter.ts:247`) reads it under a 1 MB cap and hands it over **raw and unparsed**.
2. `handleWhatsAppWebhookPost` (`packages/host/src/inbox/webhook.ts:67`) runs `verifySignature` (`whatsapp.ts:59`) first: HMAC-SHA256 of the exact bytes under `AGENTFORGE_WHATSAPP_APP_SECRET`, compared in constant time. No secret set is a 503 (fail closed, not open); a bad or missing `X-Hub-Signature-256` is a 401. Only after that is the body parsed.
3. `parseWebhook` (`whatsapp.ts:216`) turns it into events. Text keeps its text; any other type becomes a fixed label such as `[image]` (a caption or media id is never copied); reactions and the like are skipped.
4. **The desk comes from the row, never from the payload.** Each event's `phone_number_id` is looked up in `channel_endpoints` (`findActiveEndpoint`); that row's `organization_id` and `workspace_id` are the `DeskScope` the write runs under. A payload cannot name a desk. An unknown or disconnected number is counted and dropped, and still answered 200 so Meta does not retry it.
5. `recordInbound` (`store.ts:267`) is one transaction: upsert the conversation, insert the message with `INSERT OR IGNORE` against the partial unique index `(conversation_id, direction, external_id)` (Meta delivers at least once), set the state to `needs_you`, bump `unread_count`, trim to 500 conversations per desk and 200 messages per conversation. `applyStatus` (`store.ts:376`) moves a delivery word forward only (`nextDeliveryStatus`), so a late `sent` never undoes a `read`.

The `GET` is Meta's subscription handshake: it echoes `hub.challenge` as `text/plain` only when `hub.verify_token` matches `AGENTFORGE_WHATSAPP_VERIFY_TOKEN` (`verifyHandshake`, `whatsapp.ts:104`).

Logs carry counts only (`received`, `duplicates`, `reports`, …). No number, name or message text is logged; the host logger would drop a field called `messages` or `text` anyway.

### Read and reply

`GET /api/v1/customers/{summary,conversations,conversations/:id}` and `POST …/:id/{read,reply,state}` (`handlers/customers.ts`, `router.ts`). Every one goes through `getTenant`, and the `DeskScope` handed to the store is the signed-in desk's. Every store statement filters on `workspace_id`; another desk's conversation id is a 404.

`handlePostConversationReply` (`customers.ts:220`): `assertReplyText` (4096 chars) → `sendTarget` → **window check** (`whatsappReplyWindow`, `packages/core/src/inbox/index.ts:85`: free-form replies are allowed strictly before `lastInboundAt + 24 h`; after that it is a 409 `window_closed` and nothing is sent) → `beginOutbound` writes the reply as `queued` → `WhatsAppClient.sendText` → `finishOutbound` (`store.ts:491`) settles it `sent` or `failed` and moves the conversation to `with_you`. A failed send stays in the thread as "Not delivered" with Meta's reason; Meta's error 131047 (window closed at their end) maps to the same `window_closed` code.

### Egress

`graph.facebook.com` is pinned in `packages/core/src/inbox/pinned.ts`; `resolvedWhatsAppApiOrigin` (`:37`) honours `AGENTFORGE_WHATSAPP_API_URL` only when `gatewayUrlOverrideAllowed()` (never packaged, never `NODE_ENV=production`). The Graph version is the one constant `WHATSAPP_GRAPH_VERSION`. Calls are `redirect: "manual"`, 15 s timeout, 1 MB response cap, the token in an `Authorization` header (never a URL), and every error string goes through `redactToken` first.

### The page

`CustomersPage` polls summary, list and the open thread every 5 s while the tab is visible, and refetches at once after any action. It is plain text only: a customer's name or message is untrusted and is never rendered as markup. Parts: `customers-parts.tsx` (Today strip, connect card, list, thread and composer); pure rules (window countdown, naming, delivery words) in `apps/web/lib/customers-format.ts`; fetch layer and error codes in `customers-client.ts`.

## Where things live

| File | Role |
|---|---|
| `packages/core/src/inbox/index.ts`, `pinned.ts` | Shapes, caps, the reply-window rule, input checks, delivery ordering, the pinned Graph origin |
| `packages/db/drizzle/0023_customer_inbox.sql` | `channel_endpoints`, `customer_conversations`, `customer_messages` |
| `packages/db/src/ensure-schema.ts`, `tenant-purge.ts` | The healer for the three tables, and their place in the tenant purge |
| `packages/host/src/inbox/whatsapp.ts` | Signature, handshake, payload parser, Graph client |
| `packages/host/src/inbox/store.ts`, `db.ts` | The desk-scoped store over SQLite |
| `packages/host/src/inbox/webhook.ts`, `webhook-path.ts` | The public route's two handlers and its constants |
| `packages/host/src/handlers/customers.ts` | The owner's routes |
| `packages/host/src/inbox/__fixtures__/meta-api.ts` | In-memory Meta (Graph API and signed webhooks), shared by the tests and the sandbox |
| `scripts/whatsapp-sandbox.ts` | The sandbox over real HTTP: drives the whole app with no Meta account |
| `apps/web/components/customers-page.tsx`, `customers-parts.tsx` | The page |
| `apps/web/lib/customers-client.ts`, `customers-format.ts` | Its fetch layer and pure rules |
| `apps/web/locales/{en,id}/customers.json` | Copy, both locales |

Schema: the tables carry `organization_id` and `workspace_id`, **not `tenant_id`** (only `organizations` does, `migrate-0015.test.ts`). The desk's delete (`handleDeleteWorkspace`, `handlers/workspaces.ts:220`) calls `purgeDesk`, and the tenant purge covers all three tables.

## Gotchas

- **The webhook needs two server env vars to work at all:** `AGENTFORGE_WHATSAPP_APP_SECRET` and `AGENTFORGE_WHATSAPP_VERIFY_TOKEN`. Without the first it answers 503; the page says so (`webhookReady`).
- **Nothing is deployed.** The production reverse proxy does not forward this path yet, the preview boxes' access gate would sit in front of it, and the two env vars are not set anywhere. All of that is Phase 3 and waits for Rizky's go.
- **Delivery is at least once and unordered.** Dedupe is the unique index, not a check-then-insert. A message that arrives after its conversation was trimmed re-creates the conversation.
- **The 24-hour window is Meta's rule, not ours.** The host refuses early (cheaper than Meta refusing); after it only a template may go out, which is Phase 3.
- **Inbound text is untrusted.** Phase 1 never gives it to a model. Anything in Phase 2 that does must run the same injection guard a knowledge source does.
- **A customer's number is personal data**, stored in the desk's database in the clear (like every other row) and visible to every member of the company (SR-169). [SR-191](../security-register.md#sr-191) to [SR-193](../security-register.md#sr-193).
