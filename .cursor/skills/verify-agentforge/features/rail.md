# Rail

The rail is the left column every screen shares. In the chat-first shell that `:3000` draws (`SHELL_LAYOUT` `"chat-first"`, `apps/web/components/app-shell.tsx:35-39`) it is `AgentRail` (`apps/web/components/agent-rail.tsx`): a fixed icon-only column, 64 px wide and 56 px on a phone (`agent-rail.css:11`, `:190`), always `data-rail="min"`. From the top it holds `mode-chat` (the default agent), one `agent-<mode>` tile per agent on the desk, a divider, `rail-account-group` (`mode-knowledge`, `channels-link`, `workspaces-link`, `usage-link`, `settings-link`) and `rail-footer` (`desk-buddy-dock` at zero size, `desk-buddy-chip`, `theme-toggle`, the updates button where it exists). Every tile has an `aria-label`, a `title` and a tooltip; there are no visible labels, group headings, collapse button or resize handle. What the rail shows is the current desk's `productModes` run through `resolveWorkspaceModes`, so a desk that hides a mode also makes its URL unreachable. The bullet names below (`rail-agents`, `rail-account`, …) are sub-feature names for this file, not testids; the testids are the ones quoted inside each bullet. Map: [`docs/internal/maps/shell-rail-and-workspaces.md`](../../../../docs/internal/maps/shell-rail-and-workspaces.md).

Product: both · Instance: main :3000

**Fallback layout.** When `SHELL_LAYOUT` is `modes`, `app-shell.tsx` draws `AppRail` (`app-rail.tsx`) instead: product mark and desk switcher, Converse, Make and Account group labels, `mode-<id>` rows, the Finance, Market and Education sub-lists, `rail-collapse` / `rail-expand` and `rail-resize`. None of that exists on `:3000` any more (all count 0: `rail-collapse`, `rail-expand`, `rail-resize`, `product-brand`, `product-logo`, `workspaces-switcher`, `rail-thread-list` outside the history popover, `rail-finance-tasks`, `rail-market-specialists`, `rail-education-tasks`, `rail-modes-skeleton`). The fallback is not driven by this recipe; its old steps are in git history before 2026-10-12.

## Sub-features

- `rail-agents` is `mode-chat` first, then one `agent-<id>` tile per visible agent in catalog order: `agent-documents`, `-research`, `-finance`, `-data`, `-market`, `-legal`, `-meeting`, `-images`, `-videos`, `-music`, `-presentations`, `-edit`, `-education`. The operator's Default shows all fourteen; a fresh Personal desk shows Chat, Research, Images, Videos and Presentation. `mode-agents` and `mode-channels` are always count 0. Each tile carries `data-conversation` (`harness` for Chat and Research, `studio` for the rest). The open tile has `aria-current="page"`. `mode-chat`'s `aria-label` is the brand name (`Nultron`).
- `rail-account` is the five fixed links no desk can hide: `mode-knowledge` (`/knowledge`), `channels-link` (`/channels`), `workspaces-link` (`/workspaces`, label "Virtual agents"), `usage-link` (`/usage`), `settings-link` (`/settings`), inside `rail-account-group`.
- `rail-footer` holds `theme-toggle`, `desk-buddy-chip` (only once the desk buddy has no room for a body, see [mascot.md](./mascot.md)), and the updates icon where it exists. The updates icon is packaged public Nultron only (`isElectron()`); webdev and the hosted web render none, so `app-updates` is count 0. It is always the icon form, so assert `data-update-cta` rather than label text (`agent-rail.tsx:122`).
- `rail-theme` is `theme-toggle`. With nothing stored the theme is light (`resolveTheme(null)` → `"light"`, `apps/web/lib/theme.ts`): `<html>` has class `light`. A stored `dark` adds class `dark` and removes `light`. `aria-label` and `title` read the target mode (`Dark` on a light desk, `Light` on a dark one).
- `rail-first-paint` is what the rail draws before `GET /api/v1/workspaces` answers: `agent-rail-skeleton` placeholders (not agents, no `agent-` testid). A browser that has drawn a desk before draws that desk's agents from `localStorage` `agentforge-shell-modes` (`:<tenantId>` on the hosted app); a brand-new install draws Chat plus placeholders, never every mode. The host's answer replaces either, and only it may redirect (`rail-redirect`).
- `rail-redirect` is the other half of `productModes`: entering a hidden mode's URL (`/music` after Music was let go) lands on `/chat` (`redirectIfHiddenMode`, `packages/core/src/agents/product-modes.ts:180-199`). `/chat`, `/settings`, `/workspaces`, `/usage` and `/knowledge` are never redirected. `/agents`, `/studio`, `/sign-in` and `/auth/callback` also land on `/chat`.
- `rail-open` is a tile click: `mode-chat` and a `harness` agent open that agent's conversation (`/chat?agent=<id>`); a `studio` agent opens its empty conversation, whose `agent-home` has `agent-open-studio` to go to the mode screen. The agent conversation, its header and the studio hand-off are driven in [chat.md](./chat.md) and [virtual-agents.md](./virtual-agents.md).

## How to get to it (user POV)

- The rail is on every screen after onboarding. There is no route for it.
- Webdev: `http://127.0.0.1:3000/chat`. Packaged: the Electron window on Chat.
- Hover or focus a tile for its name. To add or remove tiles open Virtual agents (`workspaces-link`) and hire or let go.

## Driving it with the Nultron harness

Preconditions:

- Doctor exits 0.
- Read `localStorage["agentforge-shell-modes"]` before touching the desk and leave it as you found it. A throwaway Playwright profile starts empty and needs no restore.

- **Order and count.** Collect `[data-testid^="agent-"]` tiles (exclude `agent-rail-skeleton`, `agent-name`, `agent-home*`, `agent-history*`, `agent-harness*`, `agent-card`, `agent-hire`, `agent-let-go`, `agent-open*`, `agent-always`, `agent-kind`): on the operator's Default the order is `mode-chat`, then thirteen `agent-*` tiles as listed above, then `mode-knowledge`, `channels-link`, `workspaces-link`, `usage-link`, `settings-link`, `theme-toggle` (driven 2026-10-12 on `:3000`). On a fresh Personal desk it is Chat, Research, Images, Videos and Presentation, and `agent-documents`, `-finance`, `-data`, `-market`, `-legal`, `-meeting`, `-music`, `-edit`, `-education` are count 0 until the owner hires them.
- **Removed handles.** Count 0: `rail-collapse`, `rail-expand`, `rail-resize`, `product-brand`, `product-logo`, `workspaces-switcher`, `rail-finance-tasks`, `rail-market-specialists`, `rail-education-tasks`, `finance-tasks-toggle`, `education-tasks-toggle`, `mode-documents`, `mode-finance` and every other `mode-<x>` except `mode-chat` and `mode-knowledge`. Driven 2026-10-12.
- **Width.** `[data-rail]` is `min` at every viewport. The aside is 64 px at 1280, 960 and 600 and 56 px at 375 and 320, and the page has no horizontal overflow at any of them (driven 2026-10-12).
- **Labels.** `mode-chat` has `aria-label` `Nultron` and `aria-current="page"` on `/chat`. Every tile has a non-empty `aria-label` and `title`.
- **Account links.** Each of `mode-knowledge`, `channels-link`, `workspaces-link`, `usage-link`, `settings-link` navigates to its path.
- **Theme.** Read `document.documentElement.className` first and `localStorage["agentforge-theme"]`. With nothing stored, class is `light`. Click `theme-toggle`: class becomes `dark`, key reads `dark`, `aria-label` flips to `Light`. Click again: class `light`. There is no `data-theme` attribute. Leave the theme as you found it. Driven 2026-10-12.
- **Footer.** `rail-footer` holds `theme-toggle` and, once a thread has a reply, `desk-buddy-chip`. `desk-buddy-dock` is count 1 at zero size. `app-updates` is count 0 on webdev.
- **Hidden agent.** Let go one agent from `/workspaces`: its tile disappears, `/<mode>` and `/chat?agent=<mode>` redirect to `/chat`, and hiring it restores the tile. Assert the **rail** testid, never `<mode>-studio` — the keep-alive leaves a hidden studio pane mounted (see Gotchas). Driven 2026-10-12 on Music, then restored.
- **First frames** (`rail-first-paint`). Route `GET /api/v1/workspaces` in the browser only (Playwright `context.route`, answer a five-mode desk after 800 ms, answer every non-GET yourself) and sample from the first frame with `<aside data-rail>`: with empty `localStorage` the frames before the answer show `mode-chat` and `agent-rail-skeleton`, never a full set of tiles. Not re-driven on 2026-10-12 against the new rail.
- **Locale (id).** Tile `aria-label`s and tooltips follow the locale; testids do not.
- **IDE proof.** A screenshot at 1280 and 375 under `evidence/rail/<run-id>/`.

## Gotchas

- There is no collapsed state to test. Anything that waits for `rail-collapse` or `rail-expand` waits forever.
- `agent-<mode>` is also the prefix of `agent-name`, `agent-history-toggle`, `agent-card` and others, so match the exact ids above, not the prefix.
- A hidden mode's studio is still in the DOM — SKILL.md **Harness-wide gotchas** G3. On a desk without Images, `/images` redirects to `/chat` and `images-studio` can still have count 1 with `isVisible()` false.
- Rail tiles come from the workspace's `productModes`, not from custom agents.
- Fresh desk: wait for the fifth tile, not for `mode-chat`, before asserting the desk, and do not count `agent-rail-skeleton` as an agent.
- Tooltips are drawn by the tile, not the browser `title`; read `aria-label` for a name.
- `mode-usage` and `mode-workspaces` do not exist. Usage and Virtual agents are account links, not product modes.

Subsystem map: [`docs/internal/maps/shell-rail-and-workspaces.md`](../../../../docs/internal/maps/shell-rail-and-workspaces.md).
