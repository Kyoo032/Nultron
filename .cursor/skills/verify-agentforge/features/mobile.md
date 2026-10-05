# Mobile

There is no built Nultron iOS or Android app. No App Store / Play listing, no Capacitor or Cordova project, no mobile electron-builder target, nothing to install or drive. A phone browser pointed at a LAN `:3000` is **not** a product surface — a local run binds `127.0.0.1` (`apps/web/server.ts:146-147`; a non-loopback `BIND_HOST` is honoured only when `AGENTFORGE_SERVER` is set, `apps/web/lib/bind-host.ts:15-26`). An Android-first Expo client **is** planned in-repo under `apps/mobile` — rules only today (`apps/mobile/AGENTS.md:3` "Status: **rules only** (2026-09-07). No app code yet."), scoped as a direct gateway client, never part of the desktop installer (`docs/mobile.md:11`, plan `docs/internal/mobile-android-plan.md`). Until app code lands, mobile is `verified-unreachable (no mobile app)` on every run.

## Sub-features

- `mobile-none` — no mobile build, no store package, no `--mobile` doctor flag.
- `mobile-lan-not-product` — opening Chat from a phone on the LAN is out of scope and must fail (loopback bind). Do not “fix” that by binding `0.0.0.0`. The hosted web app is reachable from a phone browser in principle (`docs/mobile.md:9`), but that is untested and unsupported, and it is a different surface from a LAN `:3000`; neither is a mobile build.
- `mobile-narrow-web` — not a mobile build. The Chat composer and the empty-state intent cards size to their own container (CSS container queries), which is the base a phone layout would stand on. It is driven on webdev at a phone-sized viewport (Browser pane `resize_window` preset `mobile`, 375 x 812, then `desktop`), never from a phone on the LAN. The recipe is [chat.md](./chat.md), "Composer layouts", plus "Thinking chevron" and "Gutters": at a phone viewport the Chat header, message list and composer share a 12px side gutter (`--chat-gutter`). A pass there is a Chat layout pass, not mobile coverage. At that width the rail is collapsed, so `desk-buddy-dock`, `desk-buddy-chip` and `product-brand` are absent (see Gotchas).

## How to get to it (user POV)

- You cannot. There is no mobile install path. Use webdev (`http://127.0.0.1:3000`) or packaged desktop (ephemeral loopback ≠ 3000). Product copy and catalogs stay Toko Token; do not invent a TokenKu mobile app.

## Driving it with the Nultron harness

Preconditions:

- **No mobile app ships**, so there is nothing to launch: no store build, no mobile electron-builder target, no `--mobile` doctor flag.
- The product binds `127.0.0.1` unless this is a hosted server (`apps/web/server.ts:146-147` — `server.listen(port, host, …)` with `host = resolveBindHost(process.env)`, imported at `:14`; `apps/web/lib/bind-host.ts:15-26` returns loopback when `BIND_HOST` is unset and throws rather than let a local run go LAN-wide without `AGENTFORGE_SERVER`), so a phone on the LAN cannot reach a local webdev by design.
- `apps/mobile/` holds **rules only** for a paused Android-first Expo client and nothing drivable (`git ls-files apps/mobile` → `AGENTS.md`, `CLAUDE.md`; `apps/mobile/AGENTS.md:3` "Status: **rules only** (2026-09-07). No app code yet."). Read those rules before touching anything mobile; do not start a mobile toolchain to satisfy this file.
- A driver marks mobile `verified-unreachable (no mobile app)` and moves on.
- Doctor with no args is webdev. Doctor `--desktop` is packaged desktop. There is no `--mobile`.

- **Confirm docs only.** This file, [`docs/mobile.md`](../../../../docs/mobile.md) and `apps/mobile/AGENTS.md` exist; `apps/mobile` holds no app code (`git ls-files apps/mobile` → `AGENTS.md`, `CLAUDE.md`). `apps/desktop/package.json:108-156` has `build.win` / `build.mac` / `build.linux` and no ios/android/capacitor target.
- **Do not** point a phone at `http://<lan-ip>:3000`. Drive `127.0.0.1` only.
- **Record.** Mark `mobile-none` and `mobile-lan-not-product` `verified-unreachable (no mobile app)`, not a Cloud or Windows fail.

## Gotchas

- Binding `0.0.0.0` or advertising a LAN URL to “support phones” would violate the local-run rule (`127.0.0.1`; `resolveBindHost` refuses a non-loopback `BIND_HOST` unless `AGENTFORGE_SERVER` is set).
- Do not invent a mobile Electron target to make this file green, and do not add Capacitor or Cordova at all.
- React Native / Expo work is not forbidden outright any more — it is fenced to `apps/mobile` and governed by that folder's `AGENTS.md`. Nothing mobile belongs in `apps/web`, `apps/desktop`, `packages/*` or the installer.
- This Windows checkout cannot run Apple's Simulator; iOS is after Android either way (`docs/mobile.md:11`).
- `pnpm desktop:dev` on :3000 is still webdev, not a phone preview.
- A narrow viewport on `127.0.0.1:3000` still shows the desktop shell: the rail collapses to a 68px strip (`RAIL_WIDTH.collapsed`, `data-rail="min"` on the rail `aside`, set at 480px and below by the `matchMedia` effect at `apps/web/components/app-rail.tsx:216-224`, written on the `aside` at `:243`) and the desk is what is left, so a 375px viewport gives the composer about 267px (375 minus the 68px rail, minus 2 x 8px of `.desk-canvas` margin at `apps/web/app/globals.css:1217`, minus 2 x 12px of `--chat-gutter` at `:901`). That is the layout `mobile-narrow-web` drives; it does not make `mobile-none` reachable, and the record above does not change.
- At that width the buddy and the brand name are not on screen. `DeskBuddyDock` returns null in a collapsed rail (`apps/web/components/desk-buddy.tsx:188-190`), and with no dock mounted `buddyView` is `none`, so `desk-buddy-chip` is absent too (`apps/web/lib/desk-buddy-state.ts:106-108`). The collapsed rail header draws only the compact workspace switcher, so `product-brand` is not rendered (`apps/web/components/app-rail.tsx:250-256`; it sits in the expanded branch, `:261-268`). A count of 0 for those three at 375px is the design, not a regression; assert them at desktop width.
