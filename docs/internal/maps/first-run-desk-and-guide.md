# Map — The first-run desk and the first-run guide

Product: both · Instance: main :3000 + HYP AI :3301

Last verified: 2026-10-15 at `5c50b561` plus the uncommitted `product-modes.ts` comment deletion for § 1's enterprise first desk and the four constants and functions it names (`:63`, `:71`, `:73`, `:80`, after a stale comment above `HOSTED_FIRST_DESK_MODES` was deleted), `resolveWorkspaceModes` (`:160`), and § 2's Settings citations. Before that: 2026-10-15 at `ea8ac258` plus the uncommitted working tree on `tester/chat-first`, for the enterprise look's guide (§ 2, "The enterprise look has no tour"), the rail that draws its placeholders (§ 6, "Which rail draws this"), the `file:line` citations those edits moved (§ 2 steps 1 to 3, the § 3 `modes` anchor, the § 5 `dispatchGuide` and `persistOutcome` lines); the other citations in §§ 3 to 6 were not re-read; not driven. Before that: 2026-10-15 at `77638399` (uncommitted on `tester/chat-first`) for the enterprise first desk (§ 1, "The enterprise shell's first desk"), the two-products note under the title, and the line numbers of the constants § 1 cites; the rest of § 1 was not re-read. Before that: 2026-10-02 for one bullet in § 6 only (the recent-session placeholders under Chat); the rest of the page is as verified before. Before that: 2026-10-01 for § 2 "Offering the guide", which gained a second way onto the desk (the hosted "Add it later", Enterprise only; the rest of the page was not re-read for it), then 2026-10-01 for the citations only, on the working tree over 0b61a29, not committed: every `file:line` on this page was re-read against source, and five had drifted and were moved (`resetEverything`, `hydrateGuide`, `onDone`, the `GuideTour` mount, the rail's `data-tour`); a sixth, `startedPending` in `app-rail.tsx` (§ 6), was moved later the same day; nothing else on the page was re-read or re-driven. Before that: 2026-09-29 at aaf249d + working tree, not committed. Driven on `:3000` with the host's first-run answers faked in the browser (`drive-guide.mjs`, 1280 / 683 / 375 wide, light and dark, English and Indonesian, keyboard only); the host half is proven by tests against a real empty data dir and two real host processes across Start over. **Not driven:** the packaged Windows app, and a real fresh `:3000` (it needs a restart to serve `POST /api/v1/settings/guide`). Later the same day the rail's first frames (§ 6) were driven with the workspaces answer faked and delayed 800 ms, 1280 and 375 wide, a frame sampler counting the modes drawn.

> **Two products, one repo.** The first-desk rule below is **Personal**'s (Rizky, 2026-09-29). **Enterprise**'s first desk keeps every mode on the default shell. Under `AGENTFORGE_SHELL=enterprise` (team board K-D34, item 2) a new company's first desk is the default agent only, Chat; an existing desk is never rewritten, and the guide has no tour (§ 2). The guide is shared: `apps/web` is the renderer of both.

## Overview

Two things that a person meets in their first minute. **The first desk** is what a fresh Personal install opens with: Chat plus Research, Images, Videos and Presentation, and no other mode, written into the desk row once and never touched again. **The guide** is a five-stop tour of the real shell, offered once when first-run setup ends, that ends by pointing at the page where the rest of the modes are switched on. Neither is a gate: nothing about setup waits for either, and the host keeps deciding what a key may do.

## How it works

### 1. The first desk

`resolveWorkspaceModes` is the **read** rule and did not change: a desk row with nothing stored reads as every mode (`packages/core/src/agents/product-modes.ts:160`, fallback `:48`), so a desk from before the column existed never loses its rail. The **write** rule is new:

- `FIRST_RUN_MODES` (`packages/core/src/agents/product-modes.ts:63`) is the list, spelled out and frozen: `chat, research, images, videos, presentations`. Chat is in it because `resolveWorkspaceModes` forces Chat into any list, and the stored row should equal what the rail shows. It is not derived from the catalog on purpose.
- `HOSTED_FIRST_DESK_MODES` (`:71`) is the hosted first desk on every shell except the enterprise shell: every mode, unchanged.
- `ENTERPRISE_FIRST_DESK_MODES` (`:73`) is `chat` alone. Only the enterprise shell's sign-in provision reads it (§ 1, "The enterprise shell's first desk").
- `firstDeskModes(hosted)` (`:80`) picks one and returns a copy. It takes the flag as an argument so this file stays free of `process` (the renderer imports it).

There are exactly two writers of a first desk, and a test holds the number at two:

| Writer | When | Reads |
|---|---|---|
| `ensureLocalOwner` (`packages/db/src/ensure-local-owner.ts:22`; the first-desk branch is `ownedWorkspaces.length === 0` at `:66`, with `productModes: firstDeskModes(isServerMode())` at `:78`) | the org has no desk: a fresh data dir, `pnpm db:seed`, and **Start over "all"** | `FIRST_RUN_MODES` off server mode |
| `ensurePortalOwner` (`packages/db/src/portal-owner.ts:185`; the first-desk insert is inside `ownedWorkspaces.length === 0` at `:246`, with `productModes` at `:253`) | a hosted company's sign-in, through `provisionPortalDesk` (`packages/host/src/portal-first-desk.ts:6`), which the sign-in route's `provision` calls (`packages/host/src/auth/index.ts:280-282`); and the next sign-in after a hosted erase, since `purgeTenantRows` deletes the company's organization, and with it its desk (`packages/db/src/tenant-purge.ts:307`) | `HOSTED_FIRST_DESK_MODES`, or `ENTERPRISE_FIRST_DESK_MODES` when the shell is `enterprise` (`resolvedShell`, `packages/host/src/shell-setting.ts:7`) |

How the two products stay apart: they are **different functions**, and the local one also asks `isServerMode()` (`packages/core/src/server-mode.ts:12`), so a hosted process that ever reached it would still get every mode. `getTenant` routes a hosted request to `resolvePortalTenant` and never to `ensureLocalOwner` (`packages/host/src/tenant.ts:96-102`), so this is a belt to that brace.

**The enterprise shell's first desk (team board K-D34, item 2; 2026-10-15).** `AGENTFORGE_SHELL` is read in one place, `resolvedShell()` (`packages/host/src/shell-setting.ts:7`). `provisionPortalDesk` (`packages/host/src/portal-first-desk.ts:6`) asks it and passes `ENTERPRISE_FIRST_DESK_MODES` to `ensurePortalOwner` when the shell is `enterprise`, and `HOSTED_FIRST_DESK_MODES` otherwise. So a company's first desk stores `["chat"]` under the enterprise shell, and every mode on the default and `opc` shells. The sign-in route's `provision` (`packages/host/src/auth/index.ts:280-282`) is the only production caller of `ensurePortalOwner`; `packages/host/src/deck/deck-test-fixtures.ts` and `packages/host/src/doc-tools/doc-tools-fixtures.ts` call it from tests only. The insert runs only when the company has no desk (`ownedWorkspaces.length === 0`), so a desk that exists is never rewritten, including after the shell changes. Personal never reaches this path: it writes through `ensureLocalOwner` and `FIRST_RUN_MODES`, which are unchanged. Proof: `packages/host/src/first-run-modes.test.ts`, the describe "a company's first desk, through the real sign-in provisioning and the router" (four cases, through `dispatch`), and `packages/db/src/first-desk-modes.test.ts` (the enterprise describe, and two structure tests that name the only callers, scanning `packages/` only, since the renderer may read the constant). **Not driven:** a hosted build with `AGENTFORGE_SHELL=enterprise`. The renderer's side of the enterprise look (no tour, no job-mode rows on the rail) is pinned by tests only (§ 2 and § 6).

**Start over "all"** queues `reset-pending.json` (`resetEverything`, `packages/host/src/handlers/settings.ts:433`), and the next boot removes the database before SQLite opens (`packages/db/src/client.ts`, see [`settings-and-gateway-gate.md`](settings-and-gateway-gate.md)). The first request after that walks `getTenant` (`packages/host/src/tenant.ts:88`), then `resolveLocalOwner`, then `ensureLocalOwner` on an empty organization, which is the branch above. `packages/host/src/first-run-modes.test.ts` runs that with two real processes.

`createLocalWorkspace` (`packages/db/src/ensure-local-owner.ts:149`) is **not** a first-desk writer: it is Workspaces' Create, whose modes the owner chose, and its "no modes given" default (`:170`) stays every mode. Nothing rewrites an existing desk: `ensureLocalOwner` writes only inside `ownedWorkspaces.length === 0`.

**Adding the rest.** Workspaces' Edit on the current desk PATCHes `productModes` (`handlePatchWorkspace`, `packages/host/src/handlers/workspaces.ts:130`; [`shell-rail-and-workspaces.md`](shell-rail-and-workspaces.md) § 6). The desk `Default` is `protected` from deletion, not from editing.

### 2. Offering the guide

`AppRoutes` (`apps/web/src/App.tsx`) is the only place that opens it unprompted:

1. Every settings read hydrates the store with `payload.guide` (`hydrateGuide`, `App.tsx:288`; `apps/web/lib/guide-store.ts:54`). The host's answer is `{ seen, outcome, at }`.
2. When the onboarding screen finishes (`onDone`, `apps/web/src/App.tsx:351`), `offerGuideAfterOnboarding()` (`apps/web/lib/guide-store.ts:99`) offers the tour unless the host said `seen: true` or the desk runs the enterprise look (below).
3. `<GuideTour visibleModes ready>` is mounted in `AppRoutes` (`App.tsx:141`) and draws nothing until `ready` (the workspaces answer has named a desk, so the rail it points at is the real one).

**The hosted "Add it later" ends first-run setup too (Nultron Enterprise, 2026-10-01).** On the key step a signed-in tenant is offered `onboarding-later`; `AppRoutes` hands the screen an `onLater` only for a signed-in person on the hosted build, the callback records the choice (`recordKeyLater`, `POST /api/v1/settings/key-later`) and the screen then calls the same `onDone`, so the tour is offered by the one `offerGuideAfterOnboarding()` call this page describes (`apps/web/src/App.tsx`, pinned by `lib/guide-wiring.test.ts` and `lib/key-later-wiring.test.ts`). The Personal app is never handed `onLater`. How the desk opens on a closed gate and what every pane says is in [`settings-and-gateway-gate.md`](settings-and-gateway-gate.md), "Add the key later (Enterprise only)".

Consequences, all on purpose: an install that upgraded into this build never sees it unprompted; a desk on the stub runtime never sees it; Playwright never sees it. Only a person who goes through first-run setup, or presses Replay, does. Onboarding's last step promises it only while it is coming (`onboarding-tour-hint`, hidden once `seen`).

**The enterprise look has no tour (team board K-D34; 2026-10-15).** `AppRoutes` hands the brand's shell to the store in an effect, `setGuideShell(shellLook)` (`apps/web/src/App.tsx:229-231`). The shell comes from the ping's `shell` (`packages/host/src/handlers/misc.ts:110`, route `packages/host/src/router.ts:302`), read through `useShellLook()` under `ProductBrandProvider`, which wraps `App` (`apps/web/src/main.tsx:32-37`). `offerGuideAfterOnboarding()` returns early under `"enterprise"` (`apps/web/lib/guide-store.ts:99-101`), so the tour is never offered on that look. The default step list is unchanged (`GUIDE_STEPS` keeps its five ids, pinned by `lib/guide-steps.test.ts`). If the ping fails the shell is null and the tour is offered as on the default look.

**Settings' Replay is hidden too:** `SettingsPage` (`apps/web/components/settings-page.tsx:146`) reads `useShellLook()` (`:148`) and draws no `SettingsGuideCard` under the enterprise look (`:496`), so nothing on an enterprise desk opens the five-step tour. Pinned by `lib/settings-guide-shell.test.tsx` (card drawn on the default shell, absent under enterprise), `lib/guide-store.test.ts` (the enterprise, `opc` and `null` cases) and `lib/guide-wiring.test.ts` (the effect).

### 3. The state machine

`apps/web/lib/guide-machine.ts`, pure, tested exhaustively to depth 5:

```
idle --offer--> offered --start/next--> step(0) --next--> ... step(n-1) --next--> done(finished)
offered|step --skip--> done(skipped)      offered|step --close--> done(closed)
step(n>0) --back--> step(n-1)             any --replay--> step(0)
```

`guideReducer` (`:56`) returns the same object for an event that means nothing, which is how the store tells "nothing happened". `offer` is refused from `done`, so nobody is re-offered a tour in the session they finished it. `outcomeOwed` (`:86`) is the one rule for when the host is told: exactly when an open tour ends. The steps are data (`GUIDE_STEPS`, `apps/web/lib/guide-steps.ts:75`): `modes` (the rail's nav, `data-tour="rail-modes"`, `apps/web/components/agent-rail.tsx:231`, the Virtual agents group of the chat-first rail; the unmounted `AppRail` carries the same hook at `app-rail.tsx:287`), `workspaces` (`workspaces-link`), `chat` (`composer`), `knowledge` (`mode-knowledge`), `settings` (`settings-link`). Two bodies read the desk, so the words are true on both products: step one lists the desk's own tools (`modesBody`): one, up to five by name in the reader's language, or a sentence that does not list; step two (`workspacesBody`) names up to three tools the desk does not have yet, or says the desk already has every tool (the hosted first desk, or an owner who switched them all on).

### 4. On screen

`GuideOverlay` (`apps/web/components/guide-tour.tsx:124`) is mounted only while the tour is open, so its side effects are exactly as long as the tour:

- **Inert.** `#root` gets `inert` (`:162`), so nothing behind the card can be clicked, tabbed to or read by a screen reader. The dimmed desk swallows clicks and does nothing with them (no advance, no close). Focus moves onto the card (`role="dialog"`, `aria-label`, `aria-describedby` = progress + title + body) and goes back to where it was on close (`restoreFocus`, `:101`; falls to `app-main-panel` when the old element is gone, as it is after onboarding).
- **Keys.** One capture-phase `keydown` listener asks `guideKeyAction` (`apps/web/lib/guide-keys.ts`, `guideKeyAction`): Esc closes; Tab and Shift+Tab wrap inside the card; ArrowRight / ArrowLeft step; Enter with focus on the card itself is Next, so five Enters walk the tour. A held key does not: `swallowsRepeat` drops the repeats of Enter, Space and the arrows, or holding Enter would record the tour finished before anything was read.
- **Placement.** `placeGuideCard` (`apps/web/lib/guide-placement.ts:71`) puts the card on the preferred side of the measured anchor, then the opposite, then the others; with no room it becomes a bottom **sheet** (an anchor is on screen but no side fits: a 375px window's icon rail), and with no anchor it is centred. The ring follows the anchor, not the placement. The anchor is the first *visible* match (`findGuideAnchor`, `:70`), because kept-alive panes have zero-size copies. It is re-measured on resize, scroll and a 400 ms timer that exists only while the tour is open.
- **Motion.** Nothing loops. The ring and card move with finite transitions; the mascot is the 36px head, decorative, `wave` on the offer and `presenting` on the steps, never busy.

### 5. Recording how it ended

`dispatchGuide` (`apps/web/lib/guide-store.ts:81`) publishes the new state, sets `seen: true` locally at once, then `persistOutcome` (`:69`) posts `{ outcome }` to `POST /api/v1/settings/guide` (`handlePostGuide`, `packages/host/src/handlers/guide.ts:18`; route `packages/host/src/router.ts:290`). A failed write never brings the tour back. The host stores `users[userId].guide = { outcome, at }` in the **sealed settings payload** beside the language (`saveUserGuide`, `packages/host/src/settings-store.ts:641`; `UserPrefs` `:188`), reads it back as `guide` on every settings answer (`packages/host/src/handlers/settings.ts:101`), and never inherits it from another user (`loadUserGuide`, `:627`).

Because it lives in `settings.enc` it is machine-wide on a desk (one user), per person on the hosted app, and **erased by Start over**: `settings.enc` is the first entry of `HOST_RESET_ENTRIES`. "Sign out of the gateway" (`scope: "key"`) does not clear it, and Replay does not either. The hosted "Start over" (`scope: "tenant"`) removes the tenant's `tenant_state` rows and takes the record with them.

### 6. The rail's first frames

**Which rail draws this.** The layout is the constant `"chat-first"` (`packages/core/src/agents/product-modes.ts:29`), so `AppShell` mounts `AgentRail` (`apps/web/components/agent-rail.tsx`), which takes no modes and draws no job-mode rows. Everything below describes `AppRail` (`apps/web/components/app-rail.tsx`), which `AppShell` mounts only when the layout is not `chat-first` (`apps/web/components/app-shell.tsx:33`), so it is not on screen today, and the 2026-09-29 and 2026-10-02 drive records below are for `AppRail`. The chat-first rail's only loading placeholder is three agent tiles (`agent-rail-skeleton`, `agent-rail.tsx:248-250`), drawn only while the agents load and only on the default look (`waiting && !enterprise`), so under the enterprise look nothing is drawn while they load. Pinned by `lib/rail-skeleton-shell.test.tsx` and `lib/agent-rail.test.tsx`.

`Shell` mounts one round trip before `GET /api/v1/workspaces` answers, and until 2026-09-29 it started from every mode, so a fresh install drew fourteen tabs and then narrowed to five. It no longer guesses. The rules are pure and live in `apps/web/lib/shell-modes.ts` (pinned by `lib/shell-modes.test.ts`); the state is `Shell`'s (`apps/web/src/App.tsx:83-97`). The first frame comes from one of two places, and the host's answer replaces either:

| Source | When | The rail draws | May redirect away from a mode |
|---|---|---|---|
| `cache` | this browser has drawn a desk before: `agentforge-shell-modes` (`:<tenantId>` on the hosted app) holds the list the host last named, rewritten on every answer (`App.tsx:110`) | that list | no |
| `unknown` | nothing stored: a brand-new install, or cleared storage | Chat, then four still skeleton rows under the Make label (`RailModesSkeleton`, `apps/web/components/rail-modes-skeleton.tsx`; `SKELETON_MODE_ROWS` is the job-mode count of `FIRST_RUN_MODES`, so on a fresh desk the account links do not move when the answer lands) | no |
| `host` | `GET /api/v1/workspaces` named a desk | the desk's modes | yes |

- **Only the host's answer may redirect.** `AppShell` passes `settled={modeRedirectAllowed(modesSource)}` (`components/app-shell.tsx:31`) and `ModeRedirect` returns no target until it is true (`components/mode-redirect.tsx:14`). A remembered list narrower than the desk would otherwise bounce a deep link to a mode the desk has (mutation-checked: without the guard `/documents` went to `/chat`).
- **The cache is a hint, never truth.** `parseCachedShellModes` (`lib/shell-modes.ts:62`) discards an empty or Chat-less value instead of reading it as every mode, which is `resolveWorkspaceModes`'s rule for an old desk and exactly the guess this replaced. Storage is read and written inside try/catch (`readShellModesCache`, `writeShellModesCache`); a blocked store means an `unknown` first frame. A desk changed behind this browser's back (another machine, a data dir replaced on `:3000`) draws its old list for one round trip; the packaged app's Start over clears Chromium storage, so it starts `unknown`.
- **Rows that take a skeleton's place do not slide in** (`startedPending`, `apps/web/components/app-rail.tsx:206`, `enter: !startedPending` at `:323`). Their `enter-slide` entrance leaves the group blank while each row waits out its stagger: 19 of 39 frames around the swap in the drive. A rail that mounted with a cache keeps the entrance it always had.
- **The session rows under Chat have placeholders too** (2026-10-02): `RailRecentThreads` holds the room the last load took until `GET /api/v1/threads` answers (`rail-recent-skeleton.tsx`, `lib/rail-recent-shape.ts`), so the account links do not move as the rows arrive. A fresh install has no sessions and nothing remembered, so it draws none.
- **A locale change remounts `Shell`** (`key={localeEpoch}`), and it now starts from the cache as well, where it used to redraw every mode.

Driven 2026-09-29 on `:3000` (the answer faked in the browser and delayed 800 ms; frames in the first second after the rail appeared, from a `requestAnimationFrame` sampler): a fresh desk drew a mode the desk lacks in 40 of 44 frames at 1280 and 51 of 54 at 375 before, 0 after; a returning five-mode desk 39 of 45 and 50 of 57 before, 0 after; a returning fourteen-mode desk is unchanged (0 before and after, the same 14 links and nav heights). On a fresh desk the nav's scroll height (694) and the Settings link's top are the same before and after the swap, at 1280 and 375. Not touched, and older: the recent-sessions block adds 56px to the rail about 100 ms in (identical before and after), and at 375 the first two frames still draw the 232px rail before its mount effect collapses it ([`shell-rail-and-workspaces.md`](shell-rail-and-workspaces.md) Gotchas).

### Failure modes

| Case | What happens |
|---|---|
| `GET /api/v1/settings` has no `guide` (a host that has not been restarted) | `hydrateGuide` ignores it; `seen` stays `null`, which counts as not seen. Replay still works; the outcome POST answers 404 and is dropped |
| The outcome POST fails | the tour stays closed, `seen` is true in this session, the next first-run setup may offer it once more |
| An anchor is not on screen (no composer on Settings, a collapsed rail with no room) | ring omitted for a missing anchor; centred card, or a bottom sheet when the anchor is there but has no room; the tour goes on |
| The workspaces answer has not arrived | `ready` is false; nothing draws, and the offer waits. The rail draws the remembered desk, or Chat and the skeleton when nothing is remembered (§ 6); nothing redirects |
| The workspaces read fails and nothing is remembered | the skeleton stays until a later read (every navigation, and the `agentforge-shell-refresh` event) names a desk; it never turns into every mode |
| The desk runs the enterprise look (`AGENTFORGE_SHELL=enterprise`) | the tour is never offered on sign-in or onboarding, nothing opens it on its own, and Settings draws no Replay card (see the enterprise paragraph in § 2) |
| The window is resized mid-tour | re-measured within a frame (resize) or 400 ms; the card and ring follow |
| A second tab or a reload mid-tour | the store is per page; a reload closes the tour without recording anything, and nothing reopens it |

## Where things live

| File | Role |
|---|---|
| `packages/core/src/agents/product-modes.ts` | `FIRST_RUN_MODES`, `HOSTED_FIRST_DESK_MODES`, `ENTERPRISE_FIRST_DESK_MODES`, `firstDeskModes`; the read rule `resolveWorkspaceModes` |
| `packages/host/src/portal-first-desk.ts`, `packages/host/src/shell-setting.ts` | the enterprise shell's first desk (`provisionPortalDesk`), and `resolvedShell()`, the one place that reads `AGENTFORGE_SHELL` |
| `packages/db/src/ensure-local-owner.ts`, `packages/db/src/portal-owner.ts` | the two first-desk writers |
| `apps/web/lib/shell-modes.ts`, `apps/web/components/rail-modes-skeleton.tsx` | the first-frame rules (`initialShellModes`, `shellModesFromHost`, the cache), the skeleton rows (§ 6) |
| `packages/core/src/guide.ts` | `GUIDE_OUTCOMES`, `GuideRecord`, `guidePayload`, `parseGuideRecord` |
| `packages/host/src/settings-store.ts`, `packages/host/src/handlers/guide.ts`, `packages/host/src/handlers/settings.ts` | the stored record, the route, the payload field |
| `apps/web/lib/guide-machine.ts`, `guide-steps.ts`, `guide-placement.ts`, `guide-keys.ts`, `guide-store.ts` | machine, registry, geometry, keyboard contract, store |
| `apps/web/components/guide-tour.tsx`, `guide-card.tsx`, `settings-guide-card.tsx` | the overlay, the card, Settings' Replay |
| `apps/web/locales/{en,id}/guide.json` | all the copy (namespace `guide`); onboarding's `tourNext` and its four example tiles are in `onboarding.json` |
| `packages/host/test/first-run-child.ts` | the child process `first-run-modes.test.ts` runs twice across Start over |

## Gotchas

- **The rail's first frames are the remembered desk, or Chat and a skeleton, never every mode** (fixed 2026-09-29; it used to flash all fourteen tabs on a fresh desk, "known and left" until then). See § 6. A probe that counts `mode-*` testids on the very first frames of a fresh desk sees one mode link (`mode-chat`, plus the always-present `mode-knowledge`, which is an account link) and four `rail-modes-skeleton-row` elements (on `AppRail` only, not mounted under the chat-first layout, § 6), not five modes; wait for the fifth mode link, and never count the skeleton as modes (it has no `mode-` testid). A screenshot taken while the skeleton shows is not a bug.
- **Vite serves modules under a hot-update query,** so a probe that `import()`s `/lib/guide-store.ts` gets a second instance of the store. Find the exact URL from `performance.getEntriesByType("resource")`.
- **The tour never navigates,** including from Settings' Replay. The composer stop is a centred card there and points at the real composer from Chat.
- **The Playwright suite needs Documents, Finance, Data, Market and Edit,** which a fresh desk no longer has, so `apps/web/tests/e2e/every-mode.ts` gives the Default desk every mode before each spec. That spec change is not run here (Playwright is not run on this desk).
- **`FALLBACK_PRODUCT_MODES` is not the first-run list.** Editing it changes what an old row reads as, not what a new desk starts with.

## Verify

[`features/guide.md`](../../../.cursor/skills/verify-agentforge/features/guide.md) drives the tour; [`features/workspaces.md`](../../../.cursor/skills/verify-agentforge/features/workspaces.md) and [`features/onboarding.md`](../../../.cursor/skills/verify-agentforge/features/onboarding.md) carry the first-desk notes. Testids: `guide-overlay`, `guide-backdrop`, `guide-spotlight`, `guide-card` (`data-guide-mode`, `data-guide-step`, `data-guide-index`, `data-guide-placement`), `guide-progress`, `guide-title`, `guide-body`, `guide-dots`, `guide-next`, `guide-back`, `guide-skip`, `guide-close`, `guide-live`, `settings-guide`, `settings-guide-replay`, `onboarding-tour-hint`.

Tests that pin it: `packages/host/src/first-run-modes.test.ts`, `packages/db/src/first-desk-modes.test.ts`, `packages/core/src/agents/product-modes.test.ts`, `packages/host/src/handlers/guide.test.ts`, `packages/core/src/guide.test.ts`, and in `apps/web/lib`: `guide-machine`, `guide-steps`, `guide-placement`, `guide-keys`, `guide-store`, `guide-locale`, `guide-card-render`, `guide-wiring`, `onboarding-first-run-copy`, `shell-modes`, `shell-first-paint` and `rail-skeleton-shell`.
