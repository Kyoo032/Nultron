# Mode harness and agent tools plan

Last written: 2026-10-03. Owner decisions recorded in Appendix A.

Every model-driven mode gets a stronger agent loop and the tools its job needs. The new tools are desk files, a real folder on Personal, and sandboxed JavaScript and Python. No mode, rail entry or pack is added. The work follows the harness rules from the course at <https://walkinglabs.github.io/learn-harness-engineering/en/>. Each mode has one declared harness with its tools, budget and checks. Done is a check that passes, never the model's word. A failed check comes back to the model as a repair note. A run leaves no half-written output behind.

Units, in order: H0, H1, then H2, H3 and H4 in parallel, then H5, H6, H7 and H8.

## How to read this

One box is one unit of work. Check a box only when its evidence exists, a test run, a drive record under `evidence/`, or a file path. The body is a how-to. The appendices explain and record.

Tests alone are not sufficient verification. A unit is verified only when its unit and live boxes are both checked. Live means driven on the isolated webdev at `http://127.0.0.1:3000` after `node .cursor/skills/verify-agentforge/scripts/doctor.mjs`, per `AGENTS.md` (Webdev check before any drive). The packaged-app drive is owed at the next pack and is recorded as owed, not as passed.

The decision trail for this run is a TSV kept beside the run (`show-me-your-work`). Nothing is committed by an agent. Rizky branches and commits by path at the end (`AGENTS.md`, Where things stand).

## The data shapes

These are fixed before any worker writes logic. A worker that needs a different shape stops and reports.

**Mode harness spec.** One typed entry per mode in `packages/core/src/harness/`, one file per mode plus an index, so parallel workers never edit the same file.

```ts
type ToolTrust = "internal" | "network" | "user_content";

type RunBudget = {
  maxSteps: number;          // model steps in one execute; today 6 for every mode
  maxToolCalls: number;      // across the whole run
  perTool?: Readonly<Record<string, number>>; // e.g. { run_code: 8, run_sql: 8 }
};

type ModeHarnessSpec = {
  mode: ProductMode;
  loop: "agent" | "pipeline" | "media" | "none";
  tools: readonly string[];  // the least-privilege set this mode may bind
  budget: RunBudget;
  repairRounds: number;      // bounded check-and-repair rounds before the run fails
  skills: readonly HarnessSkill[]; // the existing descriptive catalog, merged in
};
```

**Tool trust.** `ToolDefinition` gains `trust?: ToolTrust`, default `internal`. The output of a `network` or `user_content` tool is scanned for injection before the model sees it. This replaces the hand-kept `NETWORK_SOURCED_TOOLS` set in `packages/core/src/runtime/invoke-guarded.ts:18`.

**Check result.** A check is a pure function from the mode's output to a verdict. A failure carries the three-part repair note.

```ts
type CheckVerdict =
  | { ok: true }
  | { ok: false; check: string; error: string; why: string; fix: string };
```

**File roots.** Both roots sit behind one interface, and the tools never branch on the root kind.

```ts
type DeskPath = string & { readonly __brand: "DeskPath" }; // parsed once at the tool boundary

type FileRoot = {
  kind: "desk" | "folder";
  list(dir: DeskPath | null, glob?: string): Promise<FileEntry[]>;
  read(path: DeskPath): Promise<{ text: string; sha256: string; bytes: number }>;
  write(path: DeskPath, content: string, by: FileAuthor): Promise<WriteOutcome>;
  remove(path: DeskPath, by: FileAuthor): Promise<WriteOutcome>;
  search(pattern: string, glob?: string): Promise<SearchHit[]>;
};

type WriteOutcome =
  | { status: "saved"; path: DeskPath; version: number }            // desk
  | { status: "pending_approval"; path: DeskPath; proposalId: string }; // folder
```

`edit_file` is `read`, then the pure `applyExactEdit(text, oldString, newString, replaceAll)`, then `write`. The old string must match exactly once unless `replaceAll` is set.

**Desk files.** Two tables, scoped by desk (`workspace_id`), with bodies sealed and written through `putTenantObject` so the tenant quota counts them.

```
desk_files          id, workspace_id, path, head_version, bytes, mime, sha256,
                    created_at, updated_at, deleted_at
desk_file_versions  file_id, version, object_key, bytes, sha256,
                    author ('user' | 'agent'), run_id, mode, created_at
```

A live path is unique per desk. A delete is a soft delete. A revert writes a new version equal to an old one, so history only grows.

**Folder proposals (Personal only).** A write to the real folder is a proposal the owner approves.

```
file_proposals  id, workspace_id, run_id, path, kind ('write' | 'delete'),
                before_sha256, after_object_key, status, created_at, decided_at
status: pending -> approved -> applied | stale | failed;  pending -> rejected
```

Apply re-reads the file and refuses with `stale` when its hash no longer equals `before_sha256`.

**Code run.** One tool, two engines, the same contract.

```ts
type CodeRunInput = {
  language: "python" | "javascript";
  code: string;
  files?: string[];  // desk paths copied into /workspace; default none
};
type CodeRunResult = {
  ok: boolean;
  stdout: string;    // capped
  stderr: string;    // capped, paths and stack frames reduced to a reason class
  filesWritten: Array<{ path: string; version: number }>; // /workspace/out/** saved as agent versions
  reason?: "timeout" | "memory" | "syntax" | "runtime" | "too_large" | "busy";
};
```

## Program checklist

- [ ] Prototype the sandbox before H4 is designed. Evidence is the prototype report with its scripts and logs (Appendix A2).
- [ ] Hold the file boundaries named in each unit. Two workers never edit one file at the same time.
- [ ] Workers never run `git stash`, `git checkout`, `git restore`, `git add` or `git commit`, and never pipe a heredoc into `python` or `node`.
- [ ] Every security flag lands in `docs/internal/security-register.md` in the same change, from SR-110 up after reading the register's last row.
- [ ] Every user-facing string lands in both `apps/web/locales/en` and `apps/web/locales/id`.

## Build the harness smoke lever (H0)

**Depends on.** None.

**Files.**

- [ ] Create `packages/host/eval/harness/` with a runner, its cases and a README. It is dev only and loopback only, like `packages/host/eval/finance/`.

**Build.**

- [ ] A runner that drives Chat, Data, Documents, Presentation and Research on `:3000` through the public API and records, per case, whether the run completed, the step count, the tool calls, check failures and the wall time, to `results/<run-id>.json` (gitignored).

**You see.**

- [ ] `results/baseline.json` from the tree before H1, with every case's row filled.

**Verify, unit.**

- [ ] The runner's own parser test. Run `npx pnpm@9.15.9 --filter @agentforge/host exec vitest run eval/harness`.

**Verify, live.**

- [ ] The baseline run completes on `:3000` and its JSON is under `evidence/harness/<run-id>/`.

## Declare one harness per mode (H1)

**Depends on.** H0 baseline captured.

**Files.**

- [ ] Edit `packages/core/src/harness/` (spec types, one file per mode, the index; fold `mode-skills.ts` in).
- [ ] Edit `packages/core/src/runtime/types.ts`, `packages/core/src/runtime/ai-sdk-runtime.ts`, `packages/core/src/runtime/stub-runtime.ts` (budget in, `maxSteps` from it).
- [ ] Edit `packages/core/src/tools/define-tool.ts` and `packages/core/src/runtime/invoke-guarded.ts` (trust replaces the network set, per-tool call caps).
- [ ] Edit `packages/host/src/job-regen.ts`, `packages/host/src/runs.ts`, `packages/host/src/edit/agent-run.ts` and each job call site that does not pass `signal` today (SR-75).

**Build.**

- [ ] `ModeHarnessSpec` and one spec per mode, with today's values (6 steps, today's tools). Behavior does not change in this unit.
- [ ] `AgentRuntime.execute` takes `budget`. `maxSteps` and the per-tool cap come from it. A tool past its cap returns `{ ok: false, reason: "budget" }` to the model instead of running.
- [ ] Every `runtime.execute` call passes the caller's `AbortSignal`, so a cancel stops the model call.
- [ ] `runChecked` in `packages/host/src/harness/` runs a mode's checks and feeds the first failure back as an `ERROR / WHY / FIX` note for at most `repairRounds` rounds. Finance and Legal keep their own repair loops.

**You see.**

- [ ] The H0 smoke at the H1 tree matches the baseline on every case.
- [ ] A cancelled Data run stops streaming and records no usage after the cancel.

**Verify, unit.**

- [ ] `packages/core/src/harness/*.test.ts`. One spec per `PRODUCT_MODES` entry, budgets positive, tools all registered.
- [ ] `packages/core/src/runtime/*budget*.test.ts`. A stub tool past its cap returns the budget refusal.
- [ ] `packages/host/src/harness/run-checked.test.ts`. A failing check produces one repair round, then a pass, with a literal expected note.

**Verify, live.**

- [ ] H0 smoke on `:3000`, compared to baseline.
- [ ] `features/chat.md` and `features/data.md` drives, with a cancel mid-run.

## Store desk files (H2)

**Depends on.** H1.

**Files.**

- [ ] Edit `packages/db/src/schema.ts` and add a migration for `desk_files` and `desk_file_versions`.
- [ ] Create `packages/host/src/desk-files/` (store, desk root, routes) and `packages/core/src/tools/files/` (path parser, `applyExactEdit`, the six tools, the `FileRoot` type).
- [ ] Edit `packages/host/src/router.ts`, `packages/host/src/register-tools.ts`, the tenancy harness and the storage-writer sweep tests.

**Build.**

- [ ] `parseDeskPath` refuses absolute paths, `..`, NUL, backslash, drive letters, more than 8 segments and more than 240 characters.
- [ ] Tools `list_files`, `read_file`, `write_file`, `edit_file`, `search_files`, `delete_file`, each with a `root` argument that defaults to `desk`. Output trust is `user_content`.
- [ ] Routes under `/api/v1/files` for list, read, upload, version history, revert and delete. Another tenant's id answers 404.
- [ ] Caps. 2 MB per text file, 2000 live files per desk, reads return at most 2000 lines.

**You see.**

- [ ] In Chat, "make notes/plan.md with three steps, then change step two" leaves version 1 and version 2 of that file, both readable over the API.

**Verify, unit.**

- [ ] `packages/core/src/tools/files/*.test.ts`. Path refusals, and `applyExactEdit` with zero, one and two matches.
- [ ] `packages/host/src/desk-files/*.test.ts`. Version history, revert, quota refusal, soft delete, tenant 404.

**Verify, live.**

- [ ] The Chat scenario above on `:3000`, with the API reads saved under `evidence/files/<run-id>/`.

## Open a real folder on Personal (H3)

**Depends on.** H1. Runs beside H2 against the `FileRoot` contract.

**Files.**

- [ ] Read `apps/desktop/platform/README.md`, `windows/AGENTS.md` and `macos/AGENTS.md` first.
- [ ] Edit `apps/desktop/main.cjs` and `apps/desktop/preload.cjs` (an `agentforge:pick-folder` handler behind `isTrustedSender`), and `apps/web/lib/desktop-bridge.ts`.
- [ ] Create `packages/host/src/folder-root/` (mount record per desk, the folder root, proposals, apply).

**Build.**

- [ ] The folder root exists only when `capabilities.localPaths` is true and `isServerMode()` is false. Server mode refuses it with a fixed code.
- [ ] Reads are contained by realpath (`assertInsidePath` in `packages/host/src/edit/ffmpeg/paths.ts` is the model). Secrets and noise are refused or skipped (`.env*`, `*.pem`, `*.key`, `id_*`, `.git/`, `node_modules/`).
- [ ] Writes and deletes create proposals. Approve applies atomically after the hash check. Reject records the decision.

**You see.**

- [ ] On the desktop dev window, picking a folder and asking Chat to fix a typo in a file shows a proposal with a diff, and Approve changes the file on disk.

**Verify, unit.**

- [ ] `packages/host/src/folder-root/*.test.ts`. Symlink escape refused, denied names refused, stale apply refused, approve writes once.

**Verify, live.**

- [ ] Webdev proves the server-mode refusal and the browser path. The folder drive itself is owed on `pnpm desktop:dev` and on the next pack.

## Run code in a sandbox (H4)

**Depends on.** H1 and the prototype verdict.

**Files.**

- [ ] Create `packages/host/src/code-runner/` (engines, worker or child entry, limits, the `run_code` tool glue).
- [ ] Edit the packaging. `apps/desktop/package.json` (`asarUnpack` or `extraResources` for the wasm and wheel files), `apps/desktop/scripts/build-mac.sh`, `webapp-deploy/Dockerfile`, and a pinned fetch script with sha256 for the Python wheels.

**Build.**

- [ ] The isolation the prototype proved necessary and sufficient. No network, no host filesystem, no host env, a wall-clock kill and a memory cap.
- [ ] Desk files named in `files` are copied in. Files under `/workspace/out` come back as agent versions.
- [ ] A limiter on concurrent runs, per tenant on hosted. Errors map to the `reason` classes, never raw paths (SR-48 pattern).

**You see.**

- [ ] In Chat, "load data.csv and give me the mean of column b" runs Python with pandas and writes `out/summary.csv` to the desk.

**Verify, unit.**

- [ ] `packages/host/src/code-runner/*.test.ts`. Infinite loop killed, memory bomb killed, every escape attempt from the prototype refused, files round-trip.

**Verify, live.**

- [ ] The Chat scenario above on `:3000`, plus one JavaScript run, saved under `evidence/code/<run-id>/`.

## Give each mode its tools and checks (H5)

**Depends on.** H2, H3 and H4.

**Files.**

- [ ] One worker per mode. Each edits only that mode's spec file, its generate or run file, its prompt and its locale keys.

**Build.**

- [ ] The per-mode tool sets in Appendix A3, with budgets sized to them.
- [ ] Mode checks through `runChecked` where the mode has none today (Documents, Presentation, Meeting, Research synthesis).
- [ ] Mode prompts rewritten as short routers. Each says which tools exist and when to stop.

**You see.**

- [ ] The H0 smoke at the H5 tree. No case regresses against the baseline. Tool calls appear where the mode now has tools.

**Verify, unit.**

- [ ] Each mode's existing suite stays green, plus one test per new check with a literal expected verdict.

**Verify, live.**

- [ ] Each affected `features/<mode>.md` recipe driven once on `:3000`.

## Show files, proposals and code runs in the app (H6)

**Depends on.** H2, H3 and H4 routes.

**Files.**

- [ ] A Files section inside the existing Knowledge Base page, a file viewer with versions and revert, tool-row chips in the Thinking disclosure, the proposal card, the composer folder control (Personal only), and the code output block.

**Build.**

- [ ] No new rail entry. Every label in `en` and `id`, with the parity tests green.

**You see.**

- [ ] Each piece at 1280 px and 360 px, light and dark, with no overlap and no clipped label.

**Verify, unit.**

- [ ] Locale parity tests and component tests for the proposal card states.

**Verify, live.**

- [ ] Screenshots at both widths and both themes under `evidence/files-ui/<run-id>/`.

## Hold the hosted perimeter (H7)

**Depends on.** H2 and H4.

**Build.**

- [ ] Per-tenant caps for `run_code` and file writes (spec row T9 for these two).
- [ ] Register rows for the sandbox, desk files and the folder root, each with evidence, severity, status and gate.
- [ ] The image carries the engines, and its size change is recorded.

**Verify, live.**

- [ ] The Kubernetes rehearsal or the compose stack runs `run_code` once, in server mode, with the caps visible in a refused second burst.

## Refresh the maps and recipes (H8)

- [ ] A new map page `docs/internal/maps/agent-tools-and-files.md`, and refreshed pages for every mode H5 touched.
- [ ] Recipes in `.cursor/skills/verify-agentforge/features/` for files, folder proposals and code runs.
- [ ] `docs/internal/unreleased.md` entries, labelled Personal, Enterprise or both.
- [ ] `node scripts/map-rot.mjs` clean, and `npx pnpm@9.15.9 ci:local` with its `summary.md` table.

## Appendix A. Decisions

**A1. Owner calls, 2026-10-03.** Code runs JavaScript and Python in WASM. Agents edit sandboxed desk files, and on Personal a real folder with an approval per write. Every model-driven mode gets tools, least privilege per mode. Both products get the tools now, so the hosted perimeter in H7 gates the Enterprise pilot.

**A2. Prototype (2026-10-03).** Both engines run offline from shipped, sha256-checked files. A worker thread is not enough. Node's permission flag and the V8 code-generation flag apply to a whole process, and without them a guest reached `child_process`, `node:net` and host directories in a worker. The layer that closed every escape in the test matrix is one hardened child process per sandbox. It is forked with `env={}`, `--permission --allow-fs-read=<ship dir>` and no write or child-process rights, and `--disallow-code-generation-from-strings`. The host globals are deleted after boot. The parent keeps a wall-clock kill. The wasm memory cap comes from a wrapped `WebAssembly.Memory.grow`, because Node's `resourceLimits` do not cover wasm. On the desktop the child is the app's own executable with `ELECTRON_RUN_AS_NODE=1`, and no Electron fuse turns that off today. Pyodide's cold start was 11 to 25 s on a loaded machine, so one warm child per desk is kept, and a child is never shared across tenants. The shipped files total 21 MiB, or 28 MiB with the `.pyc` cache. Node's permission model does not restrict the network. Network containment rests on the deleted JS primitives plus no-codegen, so hosted still owes an OS-level egress deny (SR-97). Not proven on Linux, macOS, Docker or a packed installer. Evidence, scripts and logs are in the session scratchpad `sandbox-proto/` (`13-sandbox-e2e.mjs`, `run-matrix.sh`, `logs/19-matrix-summary.log`).

**A3. Tools and checks per mode, as built (2026-10-03).** The draft gave read tools to Documents, Presentation, Research, Legal, Meeting, Finance and Market. Two decisions in the trail replaced that. Documents and Presentation take desk files the owner picks, read by the host, so "stay inside the source" stays checkable. Finance, Market and Legal keep their guarded pipelines, because their figures and verdicts come from host code (`AGENTS.md`, Finance is task-based; SR-76). Finance and Market never get `run_code`. On hosted, `run_code` is off unless `AGENTFORGE_CODE_RUNS=on`.

| Mode | Loop | Model tools | Check gate (repair rounds) |
|---|---|---|---|
| Chat | agent, 12 steps | the old six, `web_fetch`, `knowledge_search`, the six file tools, `run_code` | none; egress guard after a private read |
| Data | agent | `run_sql`, `calculator`, `run_code` (a lead, never evidence) | host re-runs every finding's SQL |
| Documents | pipeline | none; desk files as host-read sources | structure + grounding (1) |
| Presentation | pipeline | none; desk files as host-read sources | count, empty, repeated, fit (1) |
| Research | pipeline | none (host runs search and fetch) | citations resolve, findings cited, sections filled (1) |
| Meeting | pipeline | none | shape, action owners, quoted dates, summary (1) |
| Finance | pipeline | none | existing number guard and section repair (1) |
| Legal | pipeline | none | existing verify and edit rounds (3) |
| Market | pipeline | existing market tools | existing number and advice guards |
| Edit | agent | existing edit tools | budget and cancel only |
| Images, Videos, Music | media | none, no model loop | none |
| Education | none | none, no gateway call | none |

## Appendix B. Alternatives rejected

- A subprocess running the machine's own Python or Node. It runs with the owner's rights on Personal and cannot run under hosted's `noexec` mounts.
- A third-party sandbox service. It sends tenant content to a new outbound host, against the outbound rule in `AGENTS.md`.
- Blocking a tool until the owner approves a folder write. The stream watchdog and the host stall guard would end the run first.
- Keeping three tool-binding paths. Each new tool would need three edits, which is the drift the mode spec removes.

## Appendix C. Risks

- Pyodide escapes through the `js` module. H4 does not start until the prototype shows the escape closed by structure.
- Install and image size grow with the wheels. H4 records the bytes and H7 records the image change.
- Desk file bodies count toward the tenant quota. A heavy desk hits the 20 GiB default sooner.
- Arguments of file and code tools pass the injection scan. Code that quotes an injection phrase is refused. H1 decides whether trusted-content tools skip the argument scan, and records it.

## Appendix D. Reading list

- `docs/internal/maps/model-policy.md`, `chat-send.md`, `data-analysis.md`, `edit-timeline.md`, `hosted-security-controls.md`, `tenant-storage.md`, `tenant-object-storage.md`, `pii-and-key-security.md`.
- `apps/desktop/platform/README.md` before H3.
- pstack skills in `~/.cursor/plugins/cache/cursor-public/pstack/`. `poteto-mode`, `figure-it-out`, `how`, `show-me-your-work`, `technical-writing`, `unslop`.
