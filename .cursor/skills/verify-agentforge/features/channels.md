# Channels (Telegram)

Account-rail page at `/channels`: connect a Telegram bot to the desk, add a group or channel the bot is in, post to it, and read what comes back. Not a product mode and not on the mode catalog — `mode-channels` must have count 0. How it works: [`maps/channels.md`](../../../../docs/internal/maps/channels.md). Design and the phases after this one: [`telegram-channels-plan.md`](../../../../docs/internal/telegram-channels-plan.md).

Product: both · Instance: main :3000

## Sub-features

- **channels-bot** — paste a BotFather token, see the bot's `@username` and a `sha256:` fingerprint, disconnect. The token is never shown again and never appears in any payload. `channels-bot-status` renders in both states: the BotFather intro text while disconnected ("Create a bot with @BotFather in Telegram, then paste the token it gives you. …", `channels-page.tsx:91`) and "Connected as @…" once connected (`:62`).
- **channels-add** — add a chat by `@username` or by numeric chat id; the host resolves it with `getChat`, which is also the proof the bot can see it. The field `channels-add-target` (`apps/web/components/channels-page.tsx:298-305`) reads `@username or chat id` as its placeholder (`channels.list.placeholder`; `@username atau ID chat` on `id`), shortened on 2026-10-01 from `@channelname or -1001234567890`. It is still cut off at a 390px viewport (165px of text in a 140px field, the Add button takes the rest of the row, measured 2026-10-01) and fits from 768px up, so a placeholder assertion should read the attribute, not the pixels.
- **channels-send** — post a message; it appears in the conversation as `direction="out"`.
- **channels-receive** — **Check for new messages** pulls `getUpdates` and files inbound text onto the matching channel; messages from a chat the desk has not added are counted as `unmatched`, not stored.
- **channels-scope** — a second desk sees none of it: its own bot, its own channels, its own conversation.
- The header art column (`buddy-stage-header`, `buddy-stage-header-tap`) is in the DOM at every width but only visible when the header is 60rem or wider.

## How to get to it (user POV)

Rail → Account group → **Channels** (`channels-link`), or `http://127.0.0.1:3000/channels` directly. Visible on every desk, like Knowledge Base and Usage; it does not depend on `productModes`.

With no bot connected the page shows the connect form (`channels-bot-token`, `channels-bot-connect`). The composer — `channels-send`, and `channels-needs-bot` beside it while no bot is connected — renders only once a channel is selected (the `selected ?` branch at `apps/web/components/channels-page.tsx:359`, the composer form at `:399`, its testid `channels-composer` at `:401`), so a fresh desk has count 0 for both, and for `channels-poll` beside them; `channels-none-selected` stands in their place. The standing privacy warning is the closed `channels-privacy` disclosure (`<details>`, summary "Privacy", `channels-page.tsx:237-245`) since 0.15.0; open it to read "Everything sent or received here travels through Telegram in the clear…". Driven 2026-09-23 on `:3000` with no token (surface only).

## Driving it with the Nultron harness

**Surface check, no sandbox and no bot (the floor any desk can prove).** Click `channels-link` in the rail, or `goto /channels`, and settle. URL is `/channels`; `channels-page`, `channels-bot-token` and `channels-bot-connect` are visible; `channels-bot-status` reads the BotFather intro; `channels-empty` and `channels-none-selected` are visible. `channels-send`, `channels-poll`, `channels-sandbox-note`, `channels-needs-bot` and `mode-channels` all have count 0 (the sandbox note shows only in a dev or test build, and only while the host is pointed at anything but `api.telegram.org`; `packages/core/src/channels/pinned.ts:30-33`).

**Without a real bot (the normal case).** Start the local Bot API sandbox, point the host at it, and drive the page:

```bash
npx tsx scripts/telegram-sandbox.ts            # prints a token and two chat ids
AGENTFORGE_TELEGRAM_API_URL=http://127.0.0.1:3399 pnpm dev
node .cursor/skills/verify-agentforge/scripts/doctor.mjs
```

In a dev or test build the page shows `channels-sandbox-note` whenever the host is pointed at anything but `api.telegram.org`; elsewhere the override is ignored and the note never shows (`packages/core/src/channels/pinned.ts:30-33`). If that note is **absent** during a sandbox drive, the env var did not reach the host — restart `:3000`, it has no watcher.

1. `goto /channels`, settle, assert `channels-page` and `channels-link` (count 1).
2. Fill `channels-bot-token` with the token the sandbox printed, click `channels-bot-connect`. Wait for `channels-bot-disconnect`; `channels-bot-status` reads "Connected as @…" and `channels-bot-fingerprint` starts `sha256:`.
3. Fill `channels-add-target` with `@trading_floor`, click `channels-add-submit`. Wait for `channels-item`; `channels-selected` reads "Trading floor".
4. Fill `channels-composer-text`, click `channels-send`. Wait for `[data-testid="channels-message"][data-direction="out"]`. Cross-check `GET http://127.0.0.1:3399/_sandbox/state` — the text is in `sent`.
5. Make a message arrive: `POST http://127.0.0.1:3399/_sandbox/arrive` with `{"chatId":"-1001234567890","author":"kyo","text":"…"}`.
6. Click `channels-poll`. Wait for `[data-direction="in"]`; `channels-notice` reads "1 new messages."
7. Click `channels-poll` again and assert the message count did **not** change (a duplicate means the cursor is not being written). The notice then reads "0 new messages." because the cursor is not rewritten when there is no next offset.
8. Unmatched chat: arrive to `-1009876543210` ("Market blast", a chat the desk has not added) and poll. The notice reads "0 new messages. 1 arrived from a chat this desk has not added." and no row appears.
9. Disconnect (`channels-bot-disconnect`): the channels and messages **stay** (`handlers/channels.ts:94-104`); the token form and the BotFather intro come back, `channels-bot-fingerprint` has count 0, `channels-item` is still there, and with a channel still selected `channels-needs-bot` ("Connect a Telegram bot for this desk first.") shows with `channels-send` and `channels-poll` both disabled. That is the only way to see `channels-needs-bot`, because Add needs a bot. Reconnecting restores them.

Also true and not obvious: an inbound row reads "From @kyo" and an outbound one "Sent by @nultron_sandbox_bot"; the type label under a title is "Group · @trading_floor"; `channels-item` carries `data-on` and `aria-pressed`; empty token, target and draft submits are silent no-ops (trimmed and returned early, `channels-page.tsx:84`, `:287`, `:405`); the composer textarea is capped at 4096 characters and the list hint says "Up to 20 channels on a desk."; a malformed token is refused by the host before any network call with 400 "That does not look like a Telegram bot token (123456789:ABC…, from BotFather)"; an unknown chat gives "Telegram refused the call: Bad Request: chat not found"; adding the same chat twice gives 409 "This desk already has that channel"; `channels-remove` has **no confirm** and also deletes the stored messages. The photo case in the gotcha below cannot be driven through `scripts/telegram-sandbox.ts` (it never passes `kind`, `:72-78`; only the unit tests do). Other testids a driver may meet: `channels-error`, `channels-intro`, `channels-bot-card`, `channels-bot-form`, `channels-add-form`, `channels-list`, `channels-conversation`, `channels-conversation-empty`, `channels-composer`.

**With a real bot.** Same walk with no `AGENTFORGE_TELEGRAM_API_URL` — create a bot with @BotFather, add it to a test group, and use that group's id. `channels-sandbox-note` must be absent. Do not use the owner's production bot, and do not paste a real token on a shared desk.

Proof to keep under `evidence/channels/<run-id>/`: the drive log, the four screenshots (empty, connected, sent, received), and the doctor JSON.

**Driven 2026-10-05 (maintain3), surface only.** On `:3000`, which was started without `AGENTFORGE_TELEGRAM_API_URL` (a second instance is not allowed while `:3000` answers, and the sandbox walk needs the host restarted with that variable), `channels-link` count 1, `mode-channels` count 0, `/channels` showed `channels-page`, `channels-empty`, `channels-none-selected`, `channels-bot-token` and `channels-bot-connect`, with `channels-send`, `channels-poll`, `channels-needs-bot` and `channels-sandbox-note` all count 0. An empty connect did nothing (no request). `not-a-token` was refused locally with the "does not look like a Telegram bot token" text in `channels-error` and no fingerprint. The sandbox walk (steps 1 to 9) was **not driven** in either pass on 2026-10-05: the morning `maintain` pass was surface only too, and the isolated stub instance that was started for it on `:3200` with the sandbox variable died with the session before this walk. Driven 2026-10-16 (d18) on a throwaway stub instance: the surface checks PASS live. Connect, send and poll stay verified-unreachable: they need a bot token or the Telegram sandbox, and a host started with `AGENTFORGE_TELEGRAM_API_URL`.

## Gotchas

- **The bot token is per desk, not per machine.** Switching desks shows a disconnected bot even though `settings.enc` still holds the other desk's token. That is the design, not a lost token.
- **Two desks sharing one bot token fight over the cursor.** `getUpdates` is per bot: whichever desk polls first consumes the update and the other never sees it. Use a different bot per desk when driving desk isolation.
- **A group bot sees nothing by default.** Telegram's privacy mode means a bot in a group only receives messages addressed to it (or commands) until privacy is turned off in @BotFather. In a *channel* the bot must be an administrator. "Send worked, receive is empty" is almost always this, not our code.
- **`getChat` is the permission check.** Adding a chat the bot is not in fails with Telegram's own "chat not found" — that is the expected 400, not a harness fault.
- **Non-text updates are skipped but still clear the cursor.** A photo posted in the group raises no message in the app and no `unmatched` count; that is deliberate.
- G1 applies: the connect, add and send buttons are real `<form>` submits. Settle after `goto` before pressing, or the browser does a native submit and the page reloads with nothing sent.
