# Team board (hosted, tester lane)

Account page at `/board` on the hosted app only: a company's shared columns and cards, with comments, that every person on the desk sees change live. Phase K0, people only. On Personal and on the tester webdev (`:3200`, not in server mode) it does not exist: the routes answer 404, the rail has no entry and `/board` lands on Chat. How it works: [`maps/board.md`](../../../../docs/internal/maps/board.md). Spec: [`team-board-spec.md`](../../../../docs/internal/team-board-spec.md).

## Sub-features

- **board-columns**: five built-in columns (To do, Doing, Review, Blocked, Done; Indonesian names on an `id` desk), plus custom ones an owner or admin adds, renames or archives. Built-in columns cannot be archived; a column with cards cannot be archived.
- **board-cards**: add a card at the foot of any column (`board-add-card-input`, `board-add-card`); open it (`board-card`) to edit the title, the description (Markdown preview), the assignee (people of the company only) and the column; archive it. `board-card-archive` shows only for the card's creator, its assignee, or an owner or admin; anyone else gets 403 `not_allowed` from the host if they call the route.
- **board-comments**: comments on a card, rendered as Markdown, with the author's name.
- **board-move**: drag a card onto another card to put it above that card, or onto a column's empty space to put it at the end. The card dialog's column select moves it to the end of another column.
- **board-live**: the badge `board-live` reads Live, Reconnecting, Paused (too many tabs) or the access-ended sentence. Another person's change shows without a reload.
- **board-conflict**: two people edit one card; the second save gets the conflict sentence, the first person's version, and keeps the second person's own edits in the boxes.
- **board-restore**: no button in K0. `POST /api/v1/board/cards/<id>/restore` with the archived card's version, owner or admin only (403 `admin_only` for a member); the card returns to the end of its column, or to To do.
- **board-scope**: a person in another company of the same partner sees an empty board and gets 404 on every card id of the first company.

## How to get to it (user POV)

Sign in to the hosted app, then rail, account group, **Board** (`board-link`, first in the group), or open `/board`. Each person needs their own portal account in the same company for the live part; a second company of the same partner is needed for the scope check.

On Personal and on webdev without `AGENTFORGE_SERVER=1` there is nothing to reach: assert `board-link` has count 0 and that `/board` redirects to `/chat`.

## Driving it with the Nultron harness

**The floor any desk can prove, with no sign-in (Personal parity).** On `:3200` (tester webdev): `board-link` count 0; `goto /board` settles on `/chat`; `GET http://127.0.0.1:3200/api/v1/board` answers 404 with `{ "error": { "code": "not_found", ... } }`.

**Hosted, two browsers.** Needs a server-mode host behind a portal: the local Docker sign-in rehearsal (`webapp-deploy/pilot-local.mjs`, Docker Desktop running, ports 80 and 443 free) or the preview, each only on Rizky's word. Two accounts in company A (owner and member), one in company B.

1. Browser 1 (owner, A): click `board-link`, settle. `board-page` visible, five `board-column-*` sections, `board-live` reads Live.
2. Browser 2 (member, A): same page. Browser 1 adds a card through `board-add-card-input` and `board-add-card`. Browser 2 shows the new `board-card` within about a second, with no reload.
3. Browser 2 drags that card into the Doing column. Browser 1 shows it there.
4. Both open the card (`board-card-dialog`). Browser 1 changes the title and clicks `board-card-save`. Browser 2 changes the description and saves: `board-card-message` reads the conflict sentence, the title box shows browser 1's title, the description box keeps browser 2's text. Save again: both fields stick.
5. Browser 2 writes a comment (`board-comment-input`, `board-comment-send`). Browser 1's open dialog shows it.
6. Browser 2 (member): no `board-add-column-input`, and no `board-card-archive` on a card browser 1 created and did not assign to browser 2. Browser 1 (owner): add a column, rename it, archive it.
7. Browser 3 (owner, B): the board is empty; open `/api/v1/board/cards/<A's card id>` in that browser's session: 404 `card_not_found`.
8. Sign browser 2 out in another tab: within 15 s `board-live` reads the access-ended sentence.

**Driven on 2026-10-13** on the local rehearsal (steps 1 to 4 and 7, plus phone width and Indonesian), before the K0 security review's fixes; evidence and numbers in the map page. **Without a browser:** `npx vitest run src/board` in `packages/host`: two companies through the real router, the stream with two viewers, resume, reset, close on removal and sign-out, caps, a real socket for the headers and CSRF, and `board-review.test.ts` for the review fixes (key rebalance, volume caps, archive and restore rules, stream lifetime, reset and access cadence).

## Gotchas

- The stream is `fetch`-based, not `EventSource`: in devtools it is a pending `fetch` to `/api/v1/board/events`, not an EventStream tab.
- An event reloads the whole board (coalesced over 150 ms). A burst of edits shows as one redraw.
- More than five open board tabs for one person: the oldest tab shows Paused and does not reconnect by itself (its Reconnect button does). This is deliberate.
- A stream ends every 15 minutes and reconnects from its last id; a gap in devtools at that moment is normal.
- Through Caddy the stream was not compressed on 2026-10-13 (no `Content-Encoding`, changes in 0.3 to 0.8 s), most likely because the board sends `Cache-Control: no-store, no-transform`. If cards ever arrive only in bursts behind the proxy and live on a direct port, check `encode` in `webapp-deploy/Caddyfile:108` first.
- The local rehearsal's portal sends at most 3 codes per address per 15 minutes; reuse a live signed-in browser state rather than signing in again.
- Never drive Start over on a hosted desk to reset a board: it erases the company.
