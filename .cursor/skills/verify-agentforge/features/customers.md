# Customers (WhatsApp)

Account-rail page at `/customers`: connect the desk's WhatsApp Business number, read what customers send, answer by hand, and see what still needs you. Not a product mode and not on the mode catalog — `mode-customers` must have count 0. Phase 1 has **no AI**: nothing is sent that the owner did not type. How it works: [`maps/customer-inbox.md`](../../../../docs/internal/maps/customer-inbox.md). Design and the phases after this one: [`whatsapp-omnichannel-plan.md`](../../../../docs/internal/whatsapp-omnichannel-plan.md).

Product: both · Instance: main :3000

## Sub-features

- **customers-connect** — paste a phone number id and an access token; the host asks Graph to read that number with that token before it keeps either. The token is never shown again; the card shows the number, the verified name and a `sha256:` fingerprint. Owner or admin only.
- **customers-receive** — a customer's message arrives on the signed webhook and appears in the list with an unread badge. The page polls every 5 s while the tab is visible.
- **customers-reply** — a free-form reply, allowed only inside the 24-hour window after the customer's last message. The thread shows Sending… → Sent → Delivered → Read, or Not delivered with Meta's reason.
- **customers-state** — Mark done / Reopen; the filters (All, Need you, With you, Done) and the search box.
- **customers-today** — the strip: need you, with you, received today, sent today, typical first reply. "Today" is the owner's local day.
- **customers-erase** — messages are kept with no time limit and go only when a customer asks: **Erase this customer** (`customers-erase-button`) at the foot of the thread asks first (`customers-erase-confirm`, `customers-erase-yes` / `customers-erase-no`), then deletes the conversation and every message in it. Owner or admin only; a member gets a 403 in the thread's error line.
- **customers-scope** — a second desk sees none of it: its own number, its own customers.

## How to get to it (user POV)

Rail → Account group → **Customers** (`customers-link`, between Channels and Virtual agents), or `http://127.0.0.1:3000/customers`. Visible on every desk.

With no number connected the card is the connect form (`customers-phone-number-id`, `customers-access-token`, `customers-connect`); the list says "No conversations yet…" (`customers-empty`) and the thread says "Pick a conversation to read it." (`customers-none-selected`). `customers-callback` is a closed disclosure holding the URL to paste into Meta (`customers-callback-url`, origin + `/api/v1/channels/whatsapp/webhook`). `customers-not-ready` shows when the server has no Meta app secret and verify token; `customers-sandbox-note` shows only while the host is pointed at anything but `graph.facebook.com` (`packages/core/src/inbox/pinned.ts`).

## Driving it with the Nultron harness

**Never use a real number or a real token on a shared desk.** Phase 1 is driven against the sandbox only.

```bash
npx tsx scripts/whatsapp-sandbox.ts            # prints the sandbox number id and token
AGENTFORGE_RUNTIME=stub \
AGENTFORGE_WHATSAPP_API_URL=http://127.0.0.1:3398 \
AGENTFORGE_WHATSAPP_APP_SECRET=sandbox-app-secret-not-a-real-secret \
AGENTFORGE_WHATSAPP_VERIFY_TOKEN=sandbox-verify-token \
  pnpm dev
node .cursor/skills/verify-agentforge/scripts/doctor.mjs
```

If `customers-sandbox-note` is **absent**, the env var did not reach the host — restart `:3000`, it has no watcher. `AGENTFORGE_RUNTIME=stub` is what lets a keyless dev desk past the gateway gate.

1. `goto /customers`, settle; `customers-page` and `customers-link` count 1.
2. Fill `customers-phone-number-id` with `105550000000001` and `customers-access-token` with the token the sandbox printed; click `customers-connect`. `customers-connect-status` reads "Connected: +62 812-0000-0001 · Sandbox Coffee"; `customers-connect-fingerprint` starts `sha256:`; `customers-disconnect` is visible.
3. `GET http://127.0.0.1:3398/_sandbox/handshake` — `ok: true` (the verify handshake). Make a customer write: `POST http://127.0.0.1:3398/_sandbox/arrive` with `{"from":"6281200000001","name":"Dewi","text":"Ada kopi?"}`. Within 5 s `customers-item` appears with "Dewi", `customers-unread` reads "1 new", and `customers-stat-needs-you` reads 1.
4. Click the item. `customers-message[data-direction="in"]` shows the text; `customers-window-note` (`data-window="open"`) reads "You can reply freely for 24 h 0 min more."; the unread badge clears within a few seconds.
5. Fill `customers-composer-text`, click `customers-send`. A `customers-message[data-direction="out"]` appears with `customers-delivery` "Sent"; the sandbox reports it Delivered at about 1 s and Read at about 3 s, so the label walks through those. Cross-check `GET http://127.0.0.1:3398/_sandbox/state` — the text is in `sent`.
6. `customers-toggle-done` → the conversation leaves "Need you"; filter `customers-filter-closed` shows it; Reopen puts it back under "With you".
7. Failure: `POST http://127.0.0.1:3398/_sandbox/fail-next` (`{}`), then send again. `customers-error` reads "The 24-hour window has closed, so a free-form reply cannot be sent." (the sandbox default is Meta's window-closed code 131047), the thread shows "Not delivered" with `customers-delivery-error`, and the draft stays in the box.
8. Hostile text: arrive with `name: "<img src=x onerror=alert(1)>"` and `text: "<script>alert(1)</script>"`. The row and thread show it as literal text; no `<script>` or `<img src="x">` element exists in the page.
9. Other types: arrive with `{"type":"image"}` — the preview and message read `[image]`; a caption is never shown.
10. Forged and unsigned: `curl -X POST http://127.0.0.1:3000/api/v1/channels/whatsapp/webhook -d '{}'` → 401, nothing stored. A wrong `hub.verify_token` on the GET → 403.
11. Disconnect (`customers-disconnect`): the token form returns, `customers-connect-fingerprint` has count 0, the conversations **stay**, and `customers-needs-number` shows under the composer with `customers-send` disabled.
12. Erase: open a customer with a reply in the thread, click `customers-erase-button`. `customers-erase-confirm` names the customer and asks "Erase … and every message in this thread? This cannot be undone." Click `customers-erase-no` (**Keep**): the button returns and nothing is deleted. Press it again, then open another customer: the question is closed (it never carries over). Back on the first, click it and `customers-erase-yes`: the item leaves the list, the thread says "Pick a conversation to read it.", `GET /api/v1/customers/conversations/<old id>` is 404, the other customer is untouched, and no `customers-error` shows. Have the same number write again: a new conversation with only the new message. Signed in as a member of the desk (not the owner): the same press shows the host's 403 in `customers-error` and deletes nothing.
13. At 390 px wide: no horizontal scroll (`document.documentElement.scrollWidth - clientWidth` is 0); the Today strip is two columns with the last card spanning both.

Also true and not obvious: a customer who writes again after a conversation is marked done reopens it as "Need you"; a conversation id from another desk is a 404 on every route; the sandbox's auto receipts can be turned off with `AUTO_RECEIPTS=0`; `scripts/whatsapp-sandbox.ts` expects the app at `http://127.0.0.1:3000` (`APP_URL` to change it).

**With a real number.** Not part of Phase 1. The live drive (Meta's test number, a tunnel or the preview box, the two env vars and the proxy rule) is Phase 3 and waits for the owner's go.

Proof to keep under `evidence/customers/<run-id>/`: the drive log, screenshots (empty, connected, list with unread, thread with ticks, failed send, phone width) and the doctor JSON.
