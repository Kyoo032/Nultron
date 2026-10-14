# Workspaces

A workspace is a desk: its own `productModes`, gateway key, Settings and Knowledge Base. In the chat-first shell on `:3000` there is no desk switcher and no Workspaces page: `workspaces-link` in the account group opens `/workspaces`, which is the **Virtual agents** page, where a person hires or lets go of agents (that edits the current desk's `productModes`); see [virtual-agents.md](./virtual-agents.md). The desk-management screen (`WorkspacesPage`: `workspaces-switcher`, `create-new-workspace`, `workspace-list`, `edit-workspace-modes`, `delete-workspace*`, the template picker) is routed only in the `"modes"` fallback layout (`SHELL_LAYOUT` `modes`) and is not driven by this recipe; the host routes behind it (`/api/v1/workspaces`) are unchanged. The first desk of a fresh Personal install is written with Chat, Research, Images, Videos and Presentation only (2026-09-29, `FIRST_RUN_MODES`); the hosted first desk has every mode. Map: [`docs/internal/maps/shell-rail-and-workspaces.md`](../../../../docs/internal/maps/shell-rail-and-workspaces.md).

Product: both · Instance: main :3000 + HYP AI :3301 (the Private/Workspace project switch is tester :3200 only, no recipe yet)

## Sub-features

- `workspaces-open` is `workspaces-link` (label "Virtual agents", `aria-label` and tooltip) in `rail-account-group`; it opens `/workspaces`, the Virtual agents page. `workspaces-page` and `create-new-workspace` are count 0 on `:3000` (driven 2026-10-12).
- `workspaces-modes-of-desk` is the effect of hire and let go: the desk's `productModes` change and the rail follows. A mode the desk lacks redirects to `/chat` (`redirectIfHiddenMode`, `packages/core/src/agents/product-modes.ts:180-199`).
- `workspaces-onboarding-desks` is the way off the key screen on a multi-desk install: when the selected desk has no key and the gate closes, the key step shows `onboarding-desks` with an `onboarding-open-desk` button per other desk (`data-workspace-id`). It is absent on a one-desk install (driven 2026-10-12: `onboarding-desks` count 0).
- `workspaces-delete-restricted` (hosted only, 2026-10-07): a member cannot delete a desk and the host refuses with `403 workspace_delete_forbidden` (`handleDeleteWorkspace`, `packages/host/src/handlers/workspaces.ts:183`; test `handlers/workspaces-delete-roles.test.ts`). Not reachable from the chat-first UI.
- The desk-management steps (switch, create from a template, edit modes, delete with a typed name) are `"modes"`-fallback only; they are in git history of this file before 2026-10-12.

## How to get to it (user POV)

- Webdev: open `http://127.0.0.1:3000/workspaces`. Packaged: the same path in the window.
- Click the third account tile under the divider ("Virtual agents").
- There is no UI to create or switch desks on `:3000`; use the API only on a throwaway data dir.

## Driving it with the Nultron harness

Preconditions:

- Doctor exits 0.
- Do not create or delete desks on the operator's SQLite without asking. `POST /api/v1/workspaces` makes the new desk current (`writeSelectedWorkspaceId`, `packages/host/src/handlers/workspaces.ts:105`), and the selection is a process-global file, so a drive that creates one switches the operator's open window too.

- **Open.** Click `workspaces-link`. URL is `/workspaces`, `virtual-agents-page` is visible, `workspaces-page` and `create-new-workspace` are count 0, and the title reads "Virtual agents". Driven 2026-10-12.
- **Hire and let go.** Covered in [virtual-agents.md](./virtual-agents.md): let go Music, the tile disappears and `/music` redirects; hire it back. Driven 2026-10-12.
- **Isolation (API, throwaway data dir only).** Settings keys and extras are per desk; Knowledge soul, memory and sources are per `workspaceId`. A new desk starts with a copy of the creating desk's gateway key (`inheritGatewayKey`, `handlers/workspaces.ts:38`, called at `:104`) and nothing else. Not driven on `:3000`.
- **Locale (id).** With the desk on `id` (see [locale.md](./locale.md)) the page title and tiles read in Bahasa. Testids are locale-invariant. Not driven.
- **IDE proof.** Screenshot under `evidence/workspaces/<run-id>/` with `/workspaces` in the URL.

## Gotchas

- The current desk is a **process-global file**, `data/workspace-id.txt` (`packages/host/src/workspace.ts:35-41`), not a per-browser session. `readSelectedWorkspaceId` and `writeSelectedWorkspaceId` are no-ops in server mode (`:24-26`, `:36-38`), so the file exists only on the desktop and on webdev.
- Deleting a desk cascades its threads, messages and runs (`packages/db/src/schema.ts:430-452`), wipes seven `knowledge_*` tables (`wipeKnowledgeForWorkspace`, `packages/db/src/ensure-local-owner.ts:219-232`) and drops the desk's `settings.enc` entry. It is not recoverable locally. The API refuses a bare `DELETE /api/v1/workspaces/:id` with `400 confirm_required`, and Default is protected (403).
- **Hosted: deleting a desk takes every person's chats with it, which is why only an owner or an admin may.** An owner or admin can delete other people's chats this way without being able to read them; no decision about desk deletion itself has been recorded.
- Workspaces is not a product mode. The control is `workspaces-link`, not `mode-workspaces`.
- Kernel forbids `student` / `course` nouns in core schema. The Students chip is a pack id (`students`), not a kernel table.
- Default with null `productModes` after migrate is all work modes, not Chat-only (a read rule for an old row).
- **A keyless desk shows the key screen only where the gate closes without a key, which is runtime `ai`.** Under `AGENTFORGE_RUNTIME=stub` the gate is `stub` with `allowed: true` (`packages/host/src/gateway-gate.ts:292-294`), so a new desk with no key lands on `/chat`.
- The 2026-09-23 finding that a keyless new desk used to block the whole app (selected desk is process-global) was fixed the same day; creating a desk now falls back to the onboarding key step with the other desks listed.
