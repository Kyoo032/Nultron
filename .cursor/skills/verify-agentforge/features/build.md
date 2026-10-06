# Build

**Parked / verified-unreachable (GTM).** Custom-agent Build is not a product surface. `/studio/new` and `/agents` redirect to Chat. `mode-agents` count is 0. `settings-build-link` count is 0. The renderer half is **gone**, not parked: there is no Studio page component left in `apps/web` (grep `save-soul|agent-prompt|create-agent` → 0 hits) and `apps/web/app/` holds only `fonts/` and `globals.css`. The host still exposes agent create, read and revise routes (`packages/host/src/router.ts:329-330` and `:449-457`, the soul route at `:453`, the tools route at `:452`; there is no DELETE or PATCH agent route), so un-parking means rebuilding UI against surviving routes — not un-hiding a page. Do not treat the redirect as a product regression.

## Sub-features

- `build-parked` — navigating `/studio/new` or `/agents` lands on Chat.

## How to get to it (user POV)

- You cannot. There is no Agents tab and no Build link in Settings.

## Driving it with the Nultron harness

Preconditions:

- Doctor exits 0 **and the gate is open** (`allowed: true`; a stub runtime or a saved key). The routes mount only after the boot gate resolves, so on a closed gate `/studio/new` shows the onboarding screen with the URL unchanged, and a signed-out hosted visitor sees the sign-in screen in place; neither is a failed redirect.

- **Redirect.** Go to `/studio/new`. URL becomes `/chat` (15s; `#/chat` in the packaged shell, which uses a `HashRouter`, so assert the router location, not the whole URL). `mode-chat` is visible. `create-agent` count is 0.
- **Agents URL.** Go to `/agents`. URL becomes `/chat`. `mode-agents` count is 0.
- **Query and hash are dropped.** `/agents/<id>?thread=x` lands on bare `/chat` with no `?thread`; `/studio/<any-uuid>` and `/workspace` (`App.tsx:445`) land there too.
- **Settings.** `settings-link` then `settings-form` visible and `settings-build-link` count 0 (also pinned by `foundation.spec.ts:73`).
- Do not click Create. Do not unlock modes via a hidden agent.
- Driven 2026-10-05 on `:3000` (evidence `build/2026-10-05-maintain3/`): `/studio/new`, `/agents`, `/studio/abc-123`, `/agents/abc?thread=x` and `/workspace` each ended on `/chat` with an empty search string; `create-agent`, `save-soul`, `agent-prompt` and `mode-agents` count 0; `settings-form` visible with `settings-build-link` count 0.

## Gotchas

- The `/studio/*` and `/agents/*` redirects are React Router client-side (`apps/web/src/App.tsx:443-444`) and sit next to a catch-all `*` → `/chat` at `:446`. Landing on Chat therefore proves the route is unhandled, not that a dedicated park rule fired — pair the URL assert with `create-agent` count 0.
- Playwright `/studio/**` matching `/studio/new` is irrelevant while the client route redirects (`apps/web/src/App.tsx:443`).
- A fresh Personal install's first desk starts with Research, Images, Videos and Presentation (plus Chat); a hosted tenant's first desk gets every work mode (`FIRST_RUN_MODES` at `packages/core/src/agents/product-modes.ts:55-61`, `HOSTED_FIRST_DESK_MODES` at `:69`). Missing Images on that first desk is a fail, not a reason to open Studio.
- `create-agent`, `save-soul`, `agent-prompt` and `settings-build-link` have no definition anywhere in `apps/web`; only absence assertions in `apps/web/tests/e2e/foundation.spec.ts` (`:41`, `:73`, `:152`) name them. A count of 0 therefore holds on every page and proves nothing about the redirect: the proof is the final location. No unit or e2e test pins the `/studio` or `/agents` redirect, so only a drive does.
- One surviving path can send a person to `/agents/*`: `chat-session.tsx:325-329` calls `router.replace('/agents/<agentId>?thread=<id>')` when an opened thread belongs to a non-default agent. `agentId` is never passed (`src/pages/chat-page.tsx:11`), so the guard is always true and the redirect bounces to bare `/chat`, dropping the thread. Do not open a custom agent's thread as part of this recipe.
- A later “show Build again” pass should un-park this file instead of inventing a new feature id.
