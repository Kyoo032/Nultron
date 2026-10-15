# Two products on one engine: Nultron (OPC) and HYP AI (SME)

Status: proposal, 2026-10-14. Nothing here is built. Code moves wait for Rizky's approval of this page and for the tester's commits to reach `main` (section 6).

## 1. Decisions (Rizky, 2026-10-14)

- **Nultron is the OPC.** A one-person company: all the agents work together, 24/7, for one owner.
- **HYP AI is the SME.** A small or medium company: people and agents work together through projects (Workspaces) and a kanban board.
- **Nultron Personal, the Electron desktop app, is retired.** It merges into the web app. Its release repo is now `Kyoo032/Nultron-Desktop`, archived. `Kyoo032/NultronEnt` was renamed to `Kyoo032/Nultron`, then to `Kyoo032/Nultron-Releases` on 2026-10-15, and that repo carries the web app's releases.
- **Nultron runs inside a VPS**, so its agents keep working while the owner's computer is off.
- **The names are settled: Nultron OPC, HYP AI SME.** In code the folders are `opc` and `sme`. Nultron and HYP AI stay brand profiles on top of them, because shared code carries no brand (AGENTS.md, "Sync lanes"; PR #159) and the HYP AI link stays private (NDA).

## 2. Why one repo and not two

Both products need the same hard parts: agents and their harnesses, tools, the document model, images and videos, knowledge, file privacy, sign-in and companies, routines and a background runner. Two codebases would mean fixing each of those twice, which is the four-lane sync problem made permanent. What differs is **who directs the agents and what screen they work in**: the owner's inbox on the OPC, the team's board on the SME. That is the split.

## 3. Layout

```
packages/
  engine/   today's core + host + db, shared by both products
            agents, harnesses, tools, doc model, media, knowledge, file visibility,
            sign-in, routines, the 24/7 background runner
  ui/       shared React pieces cut out of apps/web
            chat, composer, file cards, document/sheet/PDF viewers, media players
  opc/      OPC only: agents working as one team for one owner
            planner, agent-to-agent handoffs, owner inbox and approvals, briefings
  sme/      SME only: people and agents working together
            Workspaces, kanban, assigning to a person or an agent, comments,
            mentions, notifications, roles, the three-level admin (section 5)
apps/
  opc/      Nultron's web app: the owner's control room (agents, inbox, routines, chat)
  sme/      the simple enterprise UI (Workspaces, board, files, chat); brand-free
  portal/   sign-in and accounts, unchanged
```

HYP AI stays a downstream brand repo (`C:\Users\rizky\hypey`) that builds `apps/sme` with its brand.

## 4. Rules

- **A server profile decides what exists.** The server starts as `opc` or `sme`, and the profile mounts that product's routes and screens. It replaces the `isServerMode()` checks spread through the code.
- **The background runner is in the engine**, not in `opc`. An agent working on an SME board card runs in the background too.
- **`opc` and `sme` never import each other**, and neither do the two apps. Anything both need moves down into `engine` or `ui`.
- **Shared code carries no brand.** The brand comes from the profile's settings (`productName`, `gatewayName`), as today.

## 5. How each product runs

**Nultron (OPC), default: one container per owner on a VPS.** This is the shape of the per-desk containers on `app.nultron-ai.xyz` today. Each owner's agents, files and routines live in their own container and keep running 24/7. With one owner per container, the OPC may not need company tenancy at all; tenancy becomes the SME's concern. Default, say if wrong.

**HYP AI (SME): one hosted app, many companies,** as on the Hypernet server today. Three levels of admin, proposed by Rizky on 2026-10-14, in the portal as the one dashboard:

1. **HYP AI admin (Hypernet):** creates companies and sets each company's gateway key.
2. **Company admin:** creates the company's people, picks which models they may use, and manages the company's keys.
3. **End user:** signs in and works; holds no key.

Open: whether the gateway (TokenKu) has an API to create keys for a company, so the HYP AI admin does not paste them by hand.

## 6. Order of work

Each step is its own pull request. Nultron keeps working after every step.

1. **This page**, approved by Rizky.
2. **Promote the tester to `main`** through the pull request Rizky approves. The tester holds about 20 commits on shared files (`runs.ts`, `ensure-schema.ts`, knowledge, artifacts, media, the composer); moving packages first would conflict with every one of them.
3. **Cut `packages/ui` out of `apps/web`.** Moves only, no behaviour change.
4. **Add the server profiles** and move the board and Workspaces into `sme`.
5. **Build `apps/sme`** from the enterprise mock.
6. **Build out `opc`:** the 24/7 runner on the VPS, handoffs between agents, the owner inbox.
7. **Retire the desktop app** (section 7).

**The tester stays (Rizky, 2026-10-14).** It is the staging code at every stage, including after the apps split: new work lands in the tester first and runs on a staging instance, and only a promotion pull request Rizky approves brings it to `main`. A misconfigured update then breaks the staging instance, never the live app. Where each change goes is in AGENTS.md, "Where a change goes".

## 7. What retiring the desktop app removes (later, step 7)

- The Electron shell (`apps/desktop`), the IPC adapter, and keytar.
- The pack skill (`.cursor/skills/pack-nultron`) and the Docker route that builds the mac app.
- The Personal rule in `FIRST_RUN_MODES` and its tests, and every Personal-parity test, replaced by OPC and SME profile tests.
- SR-85 (the packaged gateway pin).
- The AGENTS.md sections that become false: the Personal / Enterprise table and the release flow to the old desktop repo. "Two codes" stays: the tester remains the staging code.

Installed desktop apps (0.15.x) now get a not-found answer when they check for updates, because `Kyoo032/Nultron` is private and no longer holds desktop releases. They keep working offline as before.
