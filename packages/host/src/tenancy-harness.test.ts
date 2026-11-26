/**
 * Phase 3 lane E — the tenancy harness (spec `docs/internal/web-phase3-tenancy-spec.md` §6, row T3).
 *
 * One table and one loop, not 52 hand-written tests. Tenant A seeds a real row of every kind the
 * router's `:params` name; tenant B then calls **every by-id route** with A's ids and must be told
 * the thing does not exist. A 404 is the only acceptable answer: a 200 is a leak, a 500 says a
 * handler fell over rather than refused, and a 403 would confirm the id exists to someone who may
 * not see it.
 *
 * Three assertions per route, because "it 404'd" is the weakest of the three:
 *   1. status 404;
 *   2. the body is an error envelope and nothing else — no partial record beside it;
 *   3. **no byte of A's record appears in the response.** Every seeded row carries `LEAK_MARKER` in
 *      its text fields, and the whole serialised result is searched for it. That is what catches a
 *      200 leaking A's data through a nested object, which assertion 1 alone never would.
 *
 * And one assertion about the table itself: `routeRegistrations()` (`./router.ts`) is read back and
 * every by-id route in it must appear here. A by-id route added without a tenancy test fails this
 * suite instead of shipping unnoticed — which is the point of the harness outliving the lane.
 *
 * What this proves and what it does not: it proves the **refusal**, on a real database, through
 * `dispatch` with two provisioned tenants. It is not a driven app. The phase's own "done when" —
 * two tenants on a running server — still needs a deploy (`docs/internal/web-phase3-lane-e.md` §6).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-tenancy-harness-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "stub";
// Deliberately high-variety: `getLocalVaultKey` has a variety floor, so a key of one repeated
// character is refused. 32 bytes of distinct-looking hex clears it and clears any later tightening.
process.env.AGENTFORGE_SECRETS_KEY = "3f8a1c05d97e26b4084fa3c1e5d7290b6c48af13e02d95b7ca6318fd4e7092a5";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.AGENTFORGE_SERVER;

import type { TenantContext } from "@agentforge/core";
import type { DeskPath } from "@agentforge/core/tools/files";
import { dispatch, isByIdRoute, routeRegistrations } from "./router";
import { DESK_FILE_ROUTES } from "./desk-files/routes";
import { createDeskRoot } from "./desk-files/store";
import { createSession } from "./auth/session";
import { createMemorySessionStore } from "./auth/session-store";
import type { HostBytesResult, HostFile, HostJsonResult, HostRequest, HostResult, HostStreamResult } from "./types";

const T0 = Date.UTC(2026, 8, 20, 9, 0, 0);

/**
 * Planted in every text field of every row tenant A seeds. Nothing else in the tree contains it, so
 * finding it anywhere in tenant B's response is unambiguous: B was handed A's data.
 */
const LEAK_MARKER = "TENANT-A-SECRET-MARKER-9f2c";

const IDENTITY_A = { tenantId: "harness-tenant-a", orgId: "harness-org-a", userId: "harness-user-a" };
const IDENTITY_B = { tenantId: "harness-tenant-b", orgId: "harness-org-b", userId: "harness-user-b" };

/**
 * The by-id surface, one entry per registration in `./router.ts`.
 *
 * `params` maps each `:param` in the path to the seeded id of tenant A's row. A route whose
 * `params` are all `"unseeded"` is one whose resource kind has no seed yet — it is still called,
 * still expected to 404, and still counted, but it proves only that a *non-existent* id is refused
 * rather than that another tenant's *existing* id is. Those are listed in the lane doc.
 *
 * `body` is sent on the mutating routes that validate a body before they look the resource up: an
 * empty body would 400 before the ownership check ran, which would make the 404 assertion vacuous.
 */
type SeedKey = keyof Seeds | "unseeded";

/**
 * What a correct refusal looks like on this route.
 *
 * `"not_found"` is the default and what the spec asks for: status 404.
 *
 * `"indistinguishable"` is for the handful of routes whose safe answer is *not* a 404, and it is
 * not a weaker assertion — it is a different one. The property that actually matters is that tenant
 * B cannot tell A's id apart from an id that never existed, and that A's row is untouched. Every
 * route is held to that (see `ghost` below); these few are held to that **alone**, because a 404
 * would be the wrong answer for them. Each one states why, in `why`, and each `why` is a claim
 * about the handler that was read, not a shrug.
 */
type Refusal = "not_found" | "indistinguishable";

type ByIdRoute = {
  readonly method: string;
  readonly path: string;
  readonly params: Readonly<Record<string, SeedKey>>;
  readonly body?: unknown;
  /**
   * Multipart routes. Sent on the ones that refuse a request with no file *before* they look the
   * resource up — without it the call 400s on the missing file and the refusal under test never
   * runs. Resolved lazily in `requestFor`, because a `.docx` fixture is read off disk.
   */
  readonly files?: () => HostFile[];
  readonly refusal?: Refusal;
  /** Required when `refusal` is `"indistinguishable"`: what the handler does instead, and why. */
  readonly why?: string;
  /** Set when the route's `:param` names something that is not tenant data. Explained inline. */
  readonly notTenantData?: string;
};

type Seeds = {
  projectId: string;
  cardId: string;
  jobId: string;
  itemId: string;
  exportJobId: string;
  workspaceId: string;
  threadId: string;
  mediaId: string;
  datasetId: string;
  matterId: string;
  docId: string;
  runId: string;
  artifactId: string;
  memoryId: string;
  sourceId: string;
  agentId: string;
  channelId: string;
  conversationId: string;
  meetingId: string;
  proposalId: string;
};

/**
 * Shared by the three `/api/v1/folder/proposals/:proposalId` rows. On the hosted server the folder
 * root does not exist, so the routes never get as far as the id.
 */
const FOLDER_PROPOSAL_WHY =
  "The folder root is a Personal feature. Every folder route except `GET /api/v1/folder` runs " +
  "`requireAvailable()` as the first statement of `guarded` (folder-root/routes.ts:46, defined " +
  ":26-30) and answers 403 `folder_unavailable` when `folderRootAvailable()` is false, which is " +
  "whenever `AGENTFORGE_SERVER` is on (folder-root/availability.ts:11-13). That runs before " +
  "`request.params.proposalId` is read (routes.ts:87, :91, :95), so on a hosted server A's id and " +
  "a ghost id take the same path and neither is looked up — a 404 is not available to these " +
  "routes. This harness deletes `AGENTFORGE_SERVER` at the top of the file and passes server mode only as a " +
  "dispatch option, so here the guard passes and the call reaches the desk-scoped lookup " +
  "`store.get` (folder-root/proposal-store.ts:135-138, `WHERE workspace_id = ? AND id = ?`), " +
  "which finds nothing for tenant B. The survivor check below proves A's proposal is still " +
  "pending after approve and reject were both called with its id.";

const BY_ID_ROUTES: readonly ByIdRoute[] = [
  // --- api keys (F5a) --------------------------------------------------------------------
  // `id` is `unseeded`: a foreign call and a ghost call must answer identically either way, and
  // seeding a real key here would leak nothing extra — the handler scopes `WHERE tenant_id` to B,
  // so both ids are 404 `not_found` to B.
  { method: "POST", path: "/api/v1/api-keys/:id/revoke", params: { id: "unseeded" }, body: {} },
  { method: "POST", path: "/api/v1/api-keys/:id/rotate", params: { id: "unseeded" }, body: {} },
  // --- edit ---------------------------------------------------------------------------------
  { method: "GET", path: "/api/v1/edit/projects/:projectId", params: { projectId: "projectId" } },
  {
    method: "POST",
    path: "/api/v1/edit/projects/:projectId/ops",
    params: { projectId: "projectId" },
    body: { ops: [] },
  },
  { method: "POST", path: "/api/v1/edit/projects/:projectId/undo", params: { projectId: "projectId" }, body: {} },
  {
    method: "POST",
    path: "/api/v1/edit/projects/:projectId/cards/:cardId/keep",
    params: { projectId: "projectId", cardId: "cardId" },
    body: {},
  },
  { method: "POST", path: "/api/v1/edit/projects/:projectId/import", params: { projectId: "projectId" }, body: {} },
  { method: "POST", path: "/api/v1/edit/projects/:projectId/generate", params: { projectId: "projectId" }, body: {} },
  {
    method: "POST",
    path: "/api/v1/edit/projects/:projectId/agent",
    params: { projectId: "projectId" },
    body: {},
    refusal: "indistinguishable",
    why:
      "The handler opens an SSE stream and returns `status: 200` before the work begins " +
      "(handlers/edit.ts handlePostEditAgent). The desk check is `foldProject(projectId, " +
      "tenant.workspaceId)` inside the run (edit/agent-run.ts, first statement of the worker), so " +
      "the refusal arrives as a frame rather than as a status. Nothing of the project is read " +
      "before it, and a project that does not exist takes exactly the same path.",
  },
  { method: "GET", path: "/api/v1/edit/projects/:projectId/events", params: { projectId: "projectId" } },
  { method: "POST", path: "/api/v1/edit/projects/:projectId/jobs", params: { projectId: "projectId" }, body: {} },
  {
    method: "GET",
    path: "/api/v1/edit/projects/:projectId/jobs/:jobId",
    params: { projectId: "projectId", jobId: "jobId" },
  },
  {
    method: "POST",
    path: "/api/v1/edit/projects/:projectId/jobs/:jobId/cancel",
    params: { projectId: "projectId", jobId: "jobId" },
    body: {},
  },
  { method: "POST", path: "/api/v1/edit/projects/:projectId/export", params: { projectId: "projectId" }, body: {} },
  {
    method: "GET",
    path: "/api/v1/edit/projects/:projectId/export/:jobId/file",
    params: { projectId: "projectId", jobId: "exportJobId" },
  },
  {
    method: "POST",
    path: "/api/v1/edit/projects/:projectId/unplaced/:itemId/place",
    params: { projectId: "projectId", itemId: "itemId" },
    body: {},
  },
  {
    method: "POST",
    path: "/api/v1/edit/projects/:projectId/unplaced/:itemId/discard",
    params: { projectId: "projectId", itemId: "itemId" },
    body: {},
  },
  { method: "POST", path: "/api/v1/edit/projects/:projectId/parity", params: { projectId: "projectId" }, body: {} },

  // --- workspaces (desks) -------------------------------------------------------------------
  { method: "POST", path: "/api/v1/workspaces/:workspaceId/select", params: { workspaceId: "workspaceId" }, body: {} },
  { method: "PATCH", path: "/api/v1/workspaces/:workspaceId", params: { workspaceId: "workspaceId" }, body: {} },
  {
    method: "DELETE",
    path: "/api/v1/workspaces/:workspaceId",
    params: { workspaceId: "workspaceId" },
    body: { confirmName: LEAK_MARKER },
  },
  // The one pair whose refusal is a desk-identity check rather than a tenant lookup: both handlers
  // compare the path id against `tenant.workspaceId`, the desk the session is currently on, so they
  // refuse another desk of tenant A's own exactly as they refuse tenant B's. Strictly stronger than
  // a tenant check, but it means the seeded second desk 404s for A too — see the "refuses the
  // workspace-agents pair on the desk check" control below, which is what rules out the row holding
  // for the wrong reason.
  { method: "GET", path: "/api/v1/workspaces/:workspaceId/agents", params: { workspaceId: "workspaceId" } },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/agents",
    params: { workspaceId: "workspaceId" },
    body: { name: "b" },
  },

  // --- threads and runs ---------------------------------------------------------------------
  { method: "GET", path: "/api/v1/threads/:threadId", params: { threadId: "threadId" } },
  { method: "GET", path: "/api/v1/threads/:threadId/subagents", params: { threadId: "threadId" } },
  { method: "DELETE", path: "/api/v1/threads/:threadId", params: { threadId: "threadId" } },
  { method: "POST", path: "/api/v1/voice/sessions/:id/end", params: { id: "unseeded" }, body: {} },
  {
    method: "POST",
    path: "/api/v1/threads/:threadId/runs/text",
    params: { threadId: "threadId" },
    body: { content: "hello" },
  },
  {
    method: "POST",
    path: "/api/v1/threads/:threadId/runs/image",
    params: { threadId: "threadId" },
    // The image route needs at least one `image_url` part before it will look at the thread
    // (core parseImageRunInput); a data URI keeps it off the network.
    body: {
      content: [
        { type: "text", text: "hello" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
      ],
    },
  },
  {
    method: "POST",
    path: "/api/v1/threads/:threadId/runs/video",
    params: { threadId: "threadId" },
    body: {
      content: [
        { type: "text", text: "hello" },
        { type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA" } },
      ],
    },
  },

  // --- media ---------------------------------------------------------------------------------
  { method: "GET", path: "/api/v1/media/:mediaId/file", params: { mediaId: "mediaId" } },
  {
    method: "DELETE",
    path: "/api/v1/media/:mediaId",
    params: { mediaId: "mediaId" },
    refusal: "indistinguishable",
    why:
      "Phase 8. `handleDeleteMedia` (handlers/media.ts) looks the row up with " +
      "`and(eq(media.organizationId, tenant.organizationId), eq(media.id, mediaId))` and answers " +
      "`{ ok: true, deleted: false, id }` when it finds nothing — the same answer an id that " +
      "never existed gets, and the same answer a second delete of the caller's own object gets. " +
      "A 404 would be the wrong answer here: a delete that is safe to retry has to say `ok` for " +
      "the object that is already gone, and the retry after a lost response is the normal case. " +
      "The property that matters is proved instead by the ghost comparison above and by the " +
      "survivor check below, which reads A's row after B has been through the whole table.",
  },
  {
    method: "GET",
    path: "/api/v1/videos/examples/:name/file",
    params: { name: "unseeded" },
    notTenantData:
      "The example reel shipped with the build. `listVideoExamples()` (./video-examples.ts) takes no " +
      "tenant and reads a directory beside the binary, so there is no owner to be foreign to. The " +
      "route is still called with a name no example has, and must still 404.",
  },

  // --- datasets --------------------------------------------------------------------------------
  { method: "GET", path: "/api/v1/datasets/:datasetId", params: { datasetId: "datasetId" } },
  { method: "DELETE", path: "/api/v1/datasets/:datasetId", params: { datasetId: "datasetId" } },

  // --- legal -----------------------------------------------------------------------------------
  { method: "GET", path: "/api/v1/legal/matters/:matterId", params: { matterId: "matterId" } },
  {
    method: "PATCH",
    path: "/api/v1/legal/matters/:matterId",
    params: { matterId: "matterId" },
    // A body the schema accepts, so the call reaches the ownership check rather than 400ing on
    // `nothing to update` — a 400 there would make the refusal assertion vacuous.
    body: { title: "tenant B was here" },
  },
  { method: "DELETE", path: "/api/v1/legal/matters/:matterId", params: { matterId: "matterId" } },
  {
    method: "POST",
    path: "/api/v1/legal/matters/:matterId/files",
    params: { matterId: "matterId" },
    // A real .docx: the route refuses a fileless request with a 400 before it looks the matter up,
    // so without one the refusal under test would never run.
    files: () => [docxFixture()],
  },
  {
    method: "DELETE",
    path: "/api/v1/legal/matters/:matterId/files/:docId",
    params: { matterId: "matterId", docId: "docId" },
  },
  {
    method: "POST",
    path: "/api/v1/legal/matters/:matterId/run/stream",
    params: { matterId: "matterId" },
    body: {},
  },
  {
    method: "GET",
    path: "/api/v1/legal/matters/:matterId/runs/:runId",
    params: { matterId: "matterId", runId: "runId" },
  },
  // Doc flow (docs/internal/doc-flow-plan.md). All six look the matter up with `requireLegalMatter`
  // before anything else, synchronously and ahead of `streamJob`, so a foreign id is a real 404 on
  // the two `/stream` rows too (the run/stream row above is the same shape). Keep it that way when
  // the bodies are filled in: moving the lookup inside the job turns the row into an
  // `indistinguishable` one that has to say why.
  //
  // The bodies below are real ones (lane L1 filled the handlers in): an edit and a comment on an item
  // tenant A's seeded extraction has. The lookup is ahead of the body check, so a foreign id is a 404
  // whatever the body, but a body the schema accepts keeps the row honest if that order ever changes.
  // `PUT .../extract/edits` and `POST .../extract/comments` write, so the survivor check below reads
  // tenant A's `extract-edits.json` back after tenant B has been through the table.
  {
    method: "POST",
    path: "/api/v1/legal/matters/:matterId/extract/stream",
    params: { matterId: "matterId" },
    body: {},
  },
  { method: "GET", path: "/api/v1/legal/matters/:matterId/extract", params: { matterId: "matterId" } },
  {
    method: "PUT",
    path: "/api/v1/legal/matters/:matterId/extract/edits",
    params: { matterId: "matterId" },
    body: { edits: [{ itemId: "payment:S1", value: "tenant B was here" }] },
  },
  {
    method: "POST",
    path: "/api/v1/legal/matters/:matterId/extract/comments",
    params: { matterId: "matterId" },
    body: { itemId: "payment:S1", text: "tenant B was here" },
  },
  {
    method: "POST",
    path: "/api/v1/legal/matters/:matterId/ask/stream",
    params: { matterId: "matterId" },
    body: { question: "tenant B was here" },
  },
  { method: "GET", path: "/api/v1/legal/matters/:matterId/asks", params: { matterId: "matterId" } },

  // --- artifacts -------------------------------------------------------------------------------
  { method: "GET", path: "/api/v1/artifacts/:artifactId", params: { artifactId: "artifactId" } },
  { method: "DELETE", path: "/api/v1/artifacts/:artifactId", params: { artifactId: "artifactId" } },
  { method: "GET", path: "/api/v1/artifacts/:artifactId/file", params: { artifactId: "artifactId" } },

  // --- knowledge -------------------------------------------------------------------------------
  {
    method: "DELETE",
    path: "/api/v1/knowledge/memories/:memoryId",
    params: { memoryId: "memoryId" },
    refusal: "indistinguishable",
    why:
      "`deleteMemory` (knowledge.ts) is `DELETE ... WHERE workspace_id = ? AND id = ?` and returns " +
      "nothing, so the handler answers `{ ok: true }` whether or not a row matched. A delete that " +
      "is a silent no-op discloses less than a 404 does, not more — the 404 would confirm to a " +
      "prober which ids exist. The survivor check below is what proves A's row is still there.",
  },
  {
    method: "POST",
    path: "/api/v1/knowledge/sources/:sourceId/reindex",
    params: { sourceId: "sourceId" },
    body: {},
  },
  {
    method: "DELETE",
    path: "/api/v1/knowledge/sources/:sourceId",
    params: { sourceId: "sourceId" },
    refusal: "indistinguishable",
    why: "Same as the memory delete: `deleteSource` is workspace-scoped and the handler ignores its boolean.",
  },

  // --- agents ----------------------------------------------------------------------------------
  { method: "GET", path: "/api/v1/agents/:agentId", params: { agentId: "agentId" } },
  { method: "GET", path: "/api/v1/agents/:agentId/capabilities", params: { agentId: "agentId" } },
  {
    method: "GET",
    path: "/api/v1/agents/:agentId/threads",
    params: { agentId: "agentId" },
    refusal: "indistinguishable",
    why:
      "`listThreads(tenant, agentId)` filters on organisation, agent and user, so a foreign agent " +
      "id selects nothing and the route answers 200 with an empty list — the same answer an agent " +
      "id nobody owns gets. Its siblings 404 first because they look the agent up; this one does " +
      "not need to, and making it would add a query to tell a prober something.",
  },
  {
    method: "POST",
    path: "/api/v1/agents/:agentId/tools",
    params: { agentId: "agentId" },
    // A registered tool key, so the call gets past the handler's own "Tool not found" and reaches
    // the agent lookup (`listVersions(tenant.organizationId, agentId)`), which is the check under
    // test. With an unknown key both calls 404 on the tool and the ownership check never runs.
    body: { toolKey: "calculator" },
  },
  { method: "POST", path: "/api/v1/agents/:agentId/soul", params: { agentId: "agentId" }, body: {} },
  { method: "POST", path: "/api/v1/agents/:agentId/publish", params: { agentId: "agentId" }, body: {} },
  { method: "POST", path: "/api/v1/agents/:agentId/share", params: { agentId: "agentId" }, body: {} },
  { method: "POST", path: "/api/v1/agents/:agentId/product-modes", params: { agentId: "agentId" }, body: {} },
  { method: "POST", path: "/api/v1/agents/:agentId/generate-defaults", params: { agentId: "agentId" }, body: {} },

  // --- channels (Telegram, PR #67) --------------------------------------------------------------
  { method: "GET", path: "/api/v1/channels/:channelId", params: { channelId: "channelId" } },
  { method: "DELETE", path: "/api/v1/channels/:channelId", params: { channelId: "channelId" } },
  { method: "GET", path: "/api/v1/channels/:channelId/messages", params: { channelId: "channelId" } },
  {
    method: "POST",
    path: "/api/v1/channels/:channelId/send",
    params: { channelId: "channelId" },
    // Sendable text, so the call reaches `requireChannel` rather than 400ing on an empty message.
    // It never reaches Telegram: the channel is refused first.
    body: { text: "tenant B was here" },
  },

  // --- customer inbox (WhatsApp, Phase 1) --------------------------------------------------------
  // A conversation hangs off the desk's connected number; every store statement filters on the desk.
  // (The webhook that writes into the inbox is not a by-id route: it names no id, and it takes the
  // desk from the connected-number row. Its own refusals are in handlers/customers.test.ts.)
  {
    method: "GET",
    path: "/api/v1/customers/conversations/:conversationId",
    params: { conversationId: "conversationId" },
  },
  {
    method: "POST",
    path: "/api/v1/customers/conversations/:conversationId/read",
    params: { conversationId: "conversationId" },
    body: {},
  },
  {
    method: "POST",
    path: "/api/v1/customers/conversations/:conversationId/reply",
    params: { conversationId: "conversationId" },
    // Sendable text, so the call reaches the desk-scoped `sendTarget` rather than 400ing on an
    // empty reply. It never reaches Meta: the conversation is refused first.
    body: { text: "tenant B was here" },
  },
  {
    method: "POST",
    path: "/api/v1/customers/conversations/:conversationId/state",
    params: { conversationId: "conversationId" },
    body: { state: "closed" },
  },
  {
    // Erasing a customer is the one destructive by-id route here, so the survivor check below matters
    // most for it: tenant A's conversation must still read after tenant B has tried to erase it.
    method: "DELETE",
    path: "/api/v1/customers/conversations/:conversationId",
    params: { conversationId: "conversationId" },
  },

  // --- meetings (PR #66) -------------------------------------------------------------------------
  { method: "GET", path: "/api/v1/meetings/:meetingId", params: { meetingId: "meetingId" } },
  { method: "DELETE", path: "/api/v1/meetings/:meetingId", params: { meetingId: "meetingId" } },
  {
    method: "POST",
    path: "/api/v1/meetings/:meetingId/recording",
    params: { meetingId: "meetingId" },
    files: () => [audioFixture()],
  },
  {
    method: "POST",
    path: "/api/v1/meetings/:meetingId/transcript",
    params: { meetingId: "meetingId" },
    body: { text: "tenant B was here" },
  },
  {
    method: "POST",
    path: "/api/v1/meetings/:meetingId/transcribe/stream",
    params: { meetingId: "meetingId" },
    body: {},
    refusal: "indistinguishable",
    why:
      "`streamJob` answers 200 and opens the SSE stream before the work starts, so the refusal " +
      "arrives as a frame rather than as a status. `requireMeeting(tenant, meetingId)` is the " +
      "first statement of the job (meeting/run.ts:152, :287, :362 — before the runtime gate, so " +
      "this check is reached under the stub runtime too, and before anything of the meeting is " +
      "read), and a meeting that does not exist takes exactly the same path. Same shape as " +
      "POST /api/v1/edit/projects/:projectId/agent above.",
  },
  {
    method: "POST",
    path: "/api/v1/meetings/:meetingId/minutes/stream",
    params: { meetingId: "meetingId" },
    body: {},
    refusal: "indistinguishable",
    why:
      "`streamJob` answers 200 and opens the SSE stream before the work starts, so the refusal " +
      "arrives as a frame rather than as a status. `requireMeeting(tenant, meetingId)` is the " +
      "first statement of the job (meeting/run.ts:152, :287, :362 — before the runtime gate, so " +
      "this check is reached under the stub runtime too, and before anything of the meeting is " +
      "read), and a meeting that does not exist takes exactly the same path. Same shape as " +
      "POST /api/v1/edit/projects/:projectId/agent above.",
  },
  {
    method: "POST",
    path: "/api/v1/meetings/:meetingId/run/stream",
    params: { meetingId: "meetingId" },
    body: {},
    refusal: "indistinguishable",
    why:
      "`streamJob` answers 200 and opens the SSE stream before the work starts, so the refusal " +
      "arrives as a frame rather than as a status. `requireMeeting(tenant, meetingId)` is the " +
      "first statement of the job (meeting/run.ts:152, :287, :362 — before the runtime gate, so " +
      "this check is reached under the stub runtime too, and before anything of the meeting is " +
      "read), and a meeting that does not exist takes exactly the same path. Same shape as " +
      "POST /api/v1/edit/projects/:projectId/agent above.",
  },
  // Doc flow (docs/internal/doc-flow-plan.md section 4). Unlike the three stream rows above, both
  // look the meeting up with `requireMeeting` in the handler, before `streamJob` and before the
  // gate, so a foreign id is a real 404. The transcript file carries a file because a handler that
  // read the upload before the lookup would otherwise 400 and make the refusal assertion vacuous.
  {
    method: "POST",
    path: "/api/v1/meetings/:meetingId/translate/stream",
    params: { meetingId: "meetingId" },
    body: {},
  },
  {
    method: "POST",
    path: "/api/v1/meetings/:meetingId/transcript/file",
    params: { meetingId: "meetingId" },
    files: () => [transcriptFixture()],
  },
  {
    method: "PUT",
    path: "/api/v1/meetings/:meetingId/minutes/edits",
    params: { meetingId: "meetingId" },
    body: {},
  },

  // --- folder (Personal only) -------------------------------------------------------------------
  {
    method: "GET",
    path: "/api/v1/folder/proposals/:proposalId",
    params: { proposalId: "proposalId" },
    refusal: "indistinguishable",
    why: FOLDER_PROPOSAL_WHY,
  },
  {
    method: "POST",
    path: "/api/v1/folder/proposals/:proposalId/approve",
    params: { proposalId: "proposalId" },
    body: {},
    refusal: "indistinguishable",
    why: FOLDER_PROPOSAL_WHY,
  },
  {
    method: "POST",
    path: "/api/v1/folder/proposals/:proposalId/reject",
    params: { proposalId: "proposalId" },
    body: {},
    refusal: "indistinguishable",
    why: FOLDER_PROPOSAL_WHY,
  },

  // --- mcp connectors ---------------------------------------------------------------------------
  // `:connectorId` is not a row id — it is one of a fixed catalogue of connector names
  // (`MCP_CONNECTOR_IDS` in packages/core/src/mcp/index.ts, checked by `parseConnectorId` in
  // handlers/mcp.ts). The tenant-scoped *connection* row lives in the desk's settings under that
  // key, so a foreign call names B's own connector slot, never A's. Every request below is
  // refused on the param or the body before the store is touched, identically for A's id and a
  // ghost: the prover is that an unseeded name gets the same 400 either way.
  {
    method: "POST",
    path: "/api/v1/mcp/connectors/:connectorId",
    params: { connectorId: "unseeded" },
    body: {},
    refusal: "indistinguishable",
    why:
      "The param is a catalogue key, not a row id: `parseConnectorId` (handlers/mcp.ts) rejects " +
      "an unknown name with a 400 before `mcpStore()` is asked anything, and a known name that " +
      "is not B's own connector gets the identical refusal — the connection itself is scoped " +
      "inside the tenant's settings.",
  },
  {
    method: "DELETE",
    path: "/api/v1/mcp/connectors/:connectorId",
    params: { connectorId: "unseeded" },
    refusal: "indistinguishable",
    why:
      "Same catalogue-key param, and `mcpStore().disconnect` (mcp/store.ts) only ever deletes the " +
      "row inside the caller's own tenant settings — there is no A-side row to reach.",
  },
  {
    method: "POST",
    path: "/api/v1/mcp/connectors/:connectorId/test",
    params: { connectorId: "unseeded" },
    body: {},
    refusal: "indistinguishable",
    why:
      "Same catalogue-key param; `handlePostMcpConnectorTest` (handlers/mcp.ts) answers 400 " +
      "`not_connected` for a connector the caller's own tenant never saved, which is every " +
      "connector name B can send — before any network call.",
  },
];

let store: ReturnType<typeof createMemorySessionStore>;
let sessionA: ReturnType<typeof createSession>;
let sessionB: ReturnType<typeof createSession>;
let tenantA: TenantContext;
let seeds: Seeds;

/**
 * One real row of every kind, owned by tenant A, each carrying `LEAK_MARKER` wherever it has a text
 * field to carry it in.
 *
 * Seeded through the store functions the handlers themselves call, not through raw SQL, so a row
 * here is a row the app would have written — the same `workspace_id`, the same sealed body, the same
 * file on disk. Three kinds are direct inserts and say why inline: the edit sub-resources exist only
 * as the output of a running job, and starting one would mean a worker, ffmpeg and a model call.
 *
 * Tenant B is provisioned but seeded with nothing. It needs no data to ask for A's.
 */
/** Names the seed that threw. A bare `FOREIGN KEY constraint failed` says nothing about which row. */
async function step<T>(label: string, run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new Error(`seed "${label}" failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

async function seedTenantA(): Promise<Seeds> {
  const { db, createLocalWorkspace, editCards, editJobs, editUnplaced, ensurePortalOwner, resolvePortalTenant } =
    await import("@agentforge/db");

  await ensurePortalOwner(db, { ...IDENTITY_A, role: "owner" });
  await ensurePortalOwner(db, { ...IDENTITY_B, role: "owner" });

  const resolvedA = await resolvePortalTenant(db, IDENTITY_A);
  if (!resolvedA.ok) {
    throw new Error(`tenant A did not resolve: ${resolvedA.code}`);
  }
  tenantA = resolvedA.tenant;

  store = createMemorySessionStore();
  sessionA = createSession({ ...IDENTITY_A, now: T0 });
  sessionB = createSession({ ...IDENTITY_B, now: T0 });
  await store.create(sessionA);
  await store.create(sessionB);

  const { createEditProject } = await import("./edit/projects");
  const { createThread } = await import("./threads");
  const { agentService } = await import("./tenant");
  const { artifactStore } = await import("./artifacts");
  const { datasetStore } = await import("./datasets");
  const { legalStore } = await import("./legal/store");
  const { addMemory, addPastedSource } = await import("./knowledge");
  const { channelStore } = await import("./channels/store");
  const { inboxStore } = await import("./inbox/db");
  const { meetingStore } = await import("./meeting/store");
  const { saveMedia } = await import("./media");
  const { listChatModels } = await import("@agentforge/core");

  // A second desk of tenant A's, so `/workspaces/:workspaceId/*` is asked about a desk that really
  // exists and really belongs to somebody else — not merely about an id nothing matches.
  const desk = await step("desk", () =>
    createLocalWorkspace(db, tenantA.organizationId, LEAK_MARKER, undefined, undefined, tenantA.userId),
  );

  const project = await step("edit project", () =>
    createEditProject(tenantA, { name: LEAK_MARKER, aspect: "16:9", fps: 30 }),
  );

  // Direct inserts: `enqueueEditJob` starts the job runner, and a card and an unplaced item are
  // written by a job that has already produced output. The rows are the shape those paths write.
  const [job] = await db
    .insert(editJobs)
    .values({
      projectId: project.id,
      kind: "generate_image",
      status: "queued",
      targetClipIdsJson: [],
      requestJson: { prompt: LEAK_MARKER },
      progress: 0,
    })
    .returning();
  const [exportJob] = await db
    .insert(editJobs)
    .values({
      projectId: project.id,
      kind: "render",
      status: "succeeded",
      targetClipIdsJson: [],
      requestJson: { name: LEAK_MARKER },
      progress: 1,
    })
    .returning();
  const [card] = await db
    .insert(editCards)
    .values({
      projectId: project.id,
      runId: crypto.randomUUID(),
      toolKey: "edit.generate",
      verb: "generate",
      object: LEAK_MARKER,
      opIdsJson: [],
      status: "pending",
      thumbsJson: [],
    })
    .returning();
  const [unplaced] = await db
    .insert(editUnplaced)
    .values({ projectId: project.id, jobId: job.id, assetId: crypto.randomUUID(), prompt: LEAK_MARKER })
    .returning();

  // The static catalogue, passed explicitly: `defaultSelectableModel()` reads the settings slice,
  // which is a dependency this harness has no reason to take on.
  const models = listChatModels();
  const agent = await agentService.create(
    tenantA,
    { name: LEAK_MARKER, systemPrompt: LEAK_MARKER, model: models[0].id },
    models,
  );
  const thread = await step("thread", () => createThread(tenantA, agent.agent.id, LEAK_MARKER));

  const artifact = artifactStore().create(tenantA, {
    mode: "documents",
    kind: "draft",
    title: LEAK_MARKER,
    mime: "text/markdown",
    body: `# ${LEAK_MARKER}`,
  });

  const dataset = datasetStore().create(tenantA, {
    name: LEAK_MARKER,
    filename: "harness.csv",
    bytes: new TextEncoder().encode(`name,note\nrow,${LEAK_MARKER}\n`),
  });

  const matter = legalStore().create(tenantA, {
    title: LEAK_MARKER,
    side: { role: "borrower", party: LEAK_MARKER, counterparty: "the Lenders" },
    workType: "review",
    deliverables: ["issues-memo"],
    instructions: LEAK_MARKER,
  });
  const runId = crypto.randomUUID();
  legalStore().saveRun(tenantA, matter.id, {
    id: runId,
    matterId: matter.id,
    startedAt: T0,
    finishedAt: T0,
    manifest: { note: LEAK_MARKER } as never,
    findings: [],
    verify: null,
    artifacts: [],
    error: null,
  });

  // The doc-flow files beside the matter: an extraction with one fact, the owner's edit and comment on
  // it, and a saved question. Tenant B's table below must find none of it, and change none of it.
  const location = { quote: LEAK_MARKER, docId: "S1", anchor: "¶1", clauseId: null, page: null };
  legalStore().saveExtract(tenantA, matter.id, {
    version: 1,
    matterId: matter.id,
    createdAt: T0,
    model: "harness",
    locale: "en",
    prompt: "",
    documentType: LEAK_MARKER,
    read: { calls: 1, repairs: 0, files: [], partialDocs: [] },
    files: [],
    parties: [],
    facts: [
      { id: "payment:S1", field: "payment", label: "Payment", value: LEAK_MARKER, status: "verified", ...location },
    ],
    redFlags: [],
    conflicts: [],
    coverage: [],
    checks: { passed: true, rounds: 0, verdicts: [] },
    side: { party: null, ask: false, candidates: [], source: "none" },
  });
  legalStore().saveExtractEdits(tenantA, matter.id, {
    version: 1,
    edits: [{ itemId: "payment:S1", value: LEAK_MARKER, editedAt: T0, editedBy: tenantA.userId }],
    comments: [{ id: "harness-comment", itemId: "payment:S1", text: LEAK_MARKER, at: T0, by: tenantA.userId }],
  });
  legalStore().saveAsks(tenantA, matter.id, {
    version: 1,
    asks: [
      {
        id: "harness-ask",
        question: LEAK_MARKER,
        answer: LEAK_MARKER,
        status: "verified",
        notInDocuments: false,
        citations: [],
        askedAt: T0,
        model: "harness",
        read: { calls: 1, repairs: 0, files: [], partialDocs: [] },
        checks: { passed: true, rounds: 0, verdicts: [] },
      },
    ],
  });

  const memory = await step("memory", () => addMemory(tenantA, LEAK_MARKER));
  const source = await step("knowledge source", () =>
    addPastedSource(tenantA, LEAK_MARKER, `${LEAK_MARKER} pasted body`),
  );

  // A 1×1 PNG. `saveMedia` keys on the declared mime and the size, so the bytes only have to be a
  // real file on disk for the `/file` route to have something to serve.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const channel = await step("channel", () =>
    channelStore().create(tenantA, {
      transport: "telegram",
      chatTarget: "@tenant-a-harness",
      chatId: "-1001234567890",
      title: LEAK_MARKER,
      chatType: "channel",
    }),
  );
  const meeting = await step("meeting", () => meetingStore().create(tenantA, { title: LEAK_MARKER, locale: "en" }));

  // A customer writing to tenant A's connected number: the endpoint is tenant A's desk's, and the
  // conversation and its one message carry the marker.
  const conversationId = await step("customer conversation", async () => {
    const inbox = inboxStore();
    const endpoint = inbox.connectEndpoint(
      { organizationId: tenantA.organizationId, workspaceId: tenantA.workspaceId },
      { kind: "whatsapp", externalId: "105550000000777", displayPhone: "+62 812-0000-0777", verifiedName: LEAK_MARKER },
      T0,
    );
    return inbox.recordInbound(
      endpoint,
      {
        type: "message",
        phoneNumberId: endpoint.externalId,
        contactId: "6281200000777",
        contactName: LEAK_MARKER,
        messageId: "wamid.HARNESS0001",
        at: T0,
        kind: "text",
        text: LEAK_MARKER,
      },
      T0,
    ).conversationId;
  });

  // Through the proposal store the folder routes themselves read (`defaultFolderDeps` is the cached
  // one on the app database). A delete proposal has no proposed text to seal, and `pending` is the
  // state the survivor check below expects approve and reject to have left alone.
  const proposalId = await step("folder proposal", async () => {
    const { defaultFolderDeps } = await import("./folder-root/deps");
    const deps = await defaultFolderDeps();
    return deps.store.propose(tenantA, {
      runId: crypto.randomUUID(),
      path: `${LEAK_MARKER}.md`,
      kind: "delete",
      beforeSha256: "0".repeat(64),
      afterBody: null,
    });
  });

  const mediaRow = await step("media", () =>
    saveMedia(tenantA, new File([png], `${LEAK_MARKER}.png`, { type: "image/png" })),
  );

  return {
    projectId: project.id,
    cardId: card.id,
    jobId: job.id,
    itemId: unplaced.id,
    exportJobId: exportJob.id,
    workspaceId: desk.id,
    threadId: thread.id,
    mediaId: mediaRow.id,
    datasetId: dataset.id,
    matterId: matter.id,
    // No seed of its own. `addFile` assigns document ids sequentially inside a matter, so a real
    // `:docId` would have to be created through tenant A's matter — and the only route that takes
    // one, `DELETE …/files/:docId`, refuses on the `:matterId` first (handlers/legal.ts
    // handleDeleteLegalMatterFile → removeFile, which loads the matter before reading its docs).
    // So the `:matterId` in that path is tenant A's real matter and carries the refusal.
    docId: "S1",
    runId,
    artifactId: artifact.id,
    memoryId: memory.id,
    sourceId: source.id,
    agentId: agent.agent.id,
    channelId: channel.id,
    conversationId,
    meetingId: meeting.id,
    proposalId,
  };
}

/** An id no row has. Used for a `:param` whose kind has no seed yet. */
const UNSEEDED_ID = "00000000-0000-4000-8000-000000000000";

/** A real .docx, so the Legal file route gets past its own "attach a file" 400. */
function docxFixture(): HostFile {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = join(here, "../../core/src/docx/fixtures/original-term-sheet.docx");
  return {
    field: "file",
    filename: "harness.docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytes: new Uint8Array(readFileSync(file)),
  };
}

/**
 * Bytes for the meeting recording route. `addRecording` looks the meeting up **before** it checks
 * the file (`meeting/store.ts` addRecording), so the content only has to exist.
 */
function audioFixture(): HostFile {
  return { field: "file", filename: "harness.m4a", mime: "audio/mp4", bytes: new Uint8Array(1024) };
}

/** A plain-text transcript for the Meeting transcript-file route. Neutral content: tenant B sends it. */
function transcriptFixture(): HostFile {
  return {
    field: "file",
    filename: "harness.txt",
    mime: "text/plain",
    bytes: new TextEncoder().encode("Alice: we agree to ship on Friday.\nBob: I will send the notes."),
  };
}

/**
 * `mode: "foreign"` fills the path with tenant A's real ids — the call under test.
 * `mode: "ghost"` fills it with ids nothing has ever had — the control the foreign call is compared
 * against. If the two answers differ, tenant B can tell A's ids apart from ids that do not exist,
 * which is an existence oracle even when no field of the record comes back.
 */
function fillPath(route: ByIdRoute, mode: "foreign" | "ghost"): string {
  return route.path.replace(/:([A-Za-z]+)/g, (_, key: string) => {
    const seedKey = route.params[key];
    if (mode === "ghost" || !seedKey || seedKey === "unseeded") {
      return mode === "ghost" ? crypto.randomUUID() : UNSEEDED_ID;
    }
    return seeds[seedKey];
  });
}

function requestFor(route: ByIdRoute, sessionId: string, mode: "foreign" | "ghost" = "foreign"): HostRequest {
  return {
    method: route.method,
    path: fillPath(route, mode),
    query: {},
    params: {},
    headers: { cookie: `agentforge_session=${sessionId}` },
    body: route.body,
    files: route.files?.(),
  };
}

/** Everything a result carries, as one string, so a leak anywhere in it is one `includes` away. */
async function serialise(result: HostResult): Promise<string> {
  if (result.type === "json") {
    return JSON.stringify((result as HostJsonResult).body ?? null);
  }
  if (result.type === "bytes") {
    const bytes = (result as HostBytesResult).bytes;
    return `${(result as HostBytesResult).filename ?? ""}|${Buffer.from(bytes).toString("utf8")}`;
  }
  const chunks: string[] = [];
  for await (const event of (result as HostStreamResult).events) {
    chunks.push(event);
  }
  return chunks.join("");
}

async function callAsTenantB(
  route: ByIdRoute,
  mode: "foreign" | "ghost" = "foreign",
): Promise<{ result: HostResult; text: string }> {
  const result = await dispatch(requestFor(route, sessionB.id, mode), {
    serverMode: true,
    sessionStore: store,
    now: () => T0,
  });
  return { result, text: await serialise(result) };
}

/**
 * A response reduced to what a prober could learn from it, with the ids they already sent stripped
 * out. Two calls that reduce to the same string are two calls a prober cannot tell apart.
 *
 * UUIDs are blanked because a refusal may quote the id back ("Thread <id> not found"), and the id
 * came from the caller in the first place, so quoting it reveals nothing. Anything else that
 * differs between the two calls is a difference the caller did not already know.
 */
function shape(result: HostResult, text: string): string {
  const withoutIds = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>");
  return `${result.type} ${result.status} ${withoutIds}`;
}

describe("every by-id route refuses another tenant's id", () => {
  beforeAll(async () => {
    seeds = await seedTenantA();
  }, 120_000);

  afterAll(async () => {
    const { sql } = await import("@agentforge/db");
    sql.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("seeded a row of every kind the routes name", () => {
    for (const [kind, id] of Object.entries(seeds)) {
      expect(id, `${kind} was not seeded`).toBeTruthy();
    }
  });

  it.each(BY_ID_ROUTES.map((route) => [`${route.method} ${route.path}`, route] as const))(
    "%s",
    async (_label, route) => {
      const { result, text } = await callAsTenantB(route, "foreign");

      // 1. Nothing of tenant A's came back — the assertion a 200 leaking a nested object fails.
      expect(text, `${route.method} ${route.path} returned tenant A's data`).not.toContain(LEAK_MARKER);

      // 2. No existence oracle: A's real ids are answered exactly as ids that never existed are.
      const ghost = await callAsTenantB(route, "ghost");
      expect(
        shape(result, text),
        `${route.method} ${route.path} answers tenant A's id differently from an id nobody owns`,
      ).toBe(shape(ghost.result, ghost.text));

      // 3. The status the spec asks for, on every route that does not say otherwise in `why`.
      if ((route.refusal ?? "not_found") === "not_found") {
        expect(result.status, `${route.method} ${route.path} did not 404`).toBe(404);
        if (result.type === "json") {
          // An error envelope and nothing beside it: `{ error: { code, message } }`, no record.
          const body = result.body as { error?: { code?: string; message?: string } };
          expect(Object.keys(body ?? {})).toEqual(["error"]);
          expect(typeof body.error?.code).toBe("string");
        }
      } else {
        // A route excused from the 404 must say why, in the table, where the next reader will see it.
        expect(route.why, `${route.method} ${route.path} is marked indistinguishable with no reason`).toBeTruthy();
      }
    },
  );

  /**
   * The control, and it is not optional: every assertion above would also pass against a server
   * that answered 404 to everybody. These are tenant A reading its own rows through the same
   * `dispatch`, **after** tenant B has been through the whole table — so they are a survivor check
   * too. A delete that silently succeeded across the tenant boundary shows up here and nowhere else.
   */
  it.each([
    ["GET", "/api/v1/artifacts/:artifactId", "artifactId"],
    ["GET", "/api/v1/edit/projects/:projectId", "projectId"],
    ["GET", "/api/v1/threads/:threadId", "threadId"],
    ["GET", "/api/v1/datasets/:datasetId", "datasetId"],
    ["GET", "/api/v1/legal/matters/:matterId", "matterId"],
    ["GET", "/api/v1/agents/:agentId", "agentId"],
    ["GET", "/api/v1/customers/conversations/:conversationId", "conversationId"],
  ] as const)("tenant A still reads its own row on %s %s", async (method, path, seedKey) => {
    const result = await dispatch(
      {
        method,
        path: path.replace(/:[A-Za-z]+/, seeds[seedKey]),
        query: {},
        params: {},
        headers: { cookie: `agentforge_session=${sessionA.id}` },
      },
      { serverMode: true, sessionStore: store, now: () => T0 },
    );
    expect(result.status, `${method} ${path} did not answer tenant A`).toBe(200);
    expect(JSON.stringify((result as HostJsonResult).body)).toContain(LEAK_MARKER);
  });

  it("leaves tenant A's extraction, edit, comment and question as they were after tenant B called every doc-flow route", async () => {
    // B's PUT and POST carried a real edit and a real comment for `payment:S1`, the item A's seeded
    // extraction has. Each was refused at the matter lookup; this reads A's files back to prove it,
    // through the route (what A would see) and through the store (what is on disk).
    const asA = (path: string) =>
      dispatch(
        { method: "GET", path, query: {}, params: {}, headers: { cookie: `agentforge_session=${sessionA.id}` } },
        { serverMode: true, sessionStore: store, now: () => T0 },
      );
    const extract = await asA(`/api/v1/legal/matters/${seeds.matterId}/extract`);
    expect(extract.status).toBe(200);
    const view = (extract as HostJsonResult).body as {
      extract: { facts: { id: string; value: string; edited: boolean }[]; comments: { text: string }[] };
    };
    expect(view.extract.facts.find((fact) => fact.id === "payment:S1")).toMatchObject({
      value: LEAK_MARKER,
      edited: true,
    });
    expect(view.extract.comments.map((comment) => comment.text)).toEqual([LEAK_MARKER]);
    const { legalStore } = await import("./legal/store");
    const file = legalStore().getExtractEdits(tenantA, seeds.matterId);
    expect(file.edits.map((edit) => edit.value)).toEqual([LEAK_MARKER]);
    expect(file.comments.map((comment) => comment.text)).toEqual([LEAK_MARKER]);
    const asks = await asA(`/api/v1/legal/matters/${seeds.matterId}/asks`);
    expect((asks as HostJsonResult).body).toMatchObject({ asks: [{ id: "harness-ask", question: LEAK_MARKER }] });
  });

  it("leaves tenant A's media row and its bytes alone, though the delete answered ok", async () => {
    // Phase 8's `DELETE /api/v1/media/:mediaId`, which no-ops rather than 404s. An unscoped no-op
    // would have taken A's row AND its object and still answered `{ ok: true }` — and it ran above,
    // as tenant B, with A's real id. This is the only assertion that can tell those two apart.
    const { db, media } = await import("@agentforge/db");
    const { eq } = await import("drizzle-orm");
    const rows = await db.select().from(media).where(eq(media.id, seeds.mediaId));
    expect(rows).toHaveLength(1);
    const file = await dispatch(
      {
        method: "GET",
        path: `/api/v1/media/${seeds.mediaId}/file`,
        query: {},
        params: {},
        headers: { cookie: `agentforge_session=${sessionA.id}` },
      },
      { serverMode: true, sessionStore: store, now: () => T0 },
    );
    // The bytes as well as the row: a delete that went through the store would have taken these.
    expect(file.type).toBe("bytes");
  });

  it("leaves tenant A's knowledge rows alone, though the deletes answered ok", async () => {
    // The two routes marked `indistinguishable` because they no-op rather than 404. A no-op that
    // was not scoped would have deleted A's rows and still answered `{ ok: true }` — this is the
    // only assertion that can tell those two apart.
    const { listMemories, listSources } = await import("./knowledge");
    expect(listMemories(tenantA).map((row) => row.id)).toContain(seeds.memoryId);
    expect(listSources(tenantA).map((row) => row.id)).toContain(seeds.sourceId);
  });

  it("leaves tenant A's folder proposal pending, though B called approve and reject with its id", async () => {
    // The two folder routes that decide a proposal. `claim` and `reject` are both
    // `UPDATE ... WHERE workspace_id = ? AND id = ? AND status = 'pending'` (folder-root/
    // proposal-store.ts:178-202), so an unscoped one would have flipped A's row to approved or
    // rejected and the routes' own answers could not have said so. Read the row back as A.
    const { defaultFolderDeps } = await import("./folder-root/deps");
    const { store: proposals } = await defaultFolderDeps();
    const row = proposals.get(tenantA, seeds.proposalId);
    expect(row, "tenant A's proposal is gone").not.toBeNull();
    expect(row?.status, "tenant A's proposal was decided by somebody else").toBe("pending");
    expect(row?.decidedAt).toBeNull();
    expect(proposals.countPending(tenantA)).toBe(1);
  });

  it("refuses the workspace-agents pair on the desk check, not on something upstream", async () => {
    // These two rows are the one pair whose refusal is NOT a tenant lookup. `handleGetWorkspaceAgents`
    // (`handlers/agents.ts:165`) compares the path id against `tenant.workspaceId` — the desk the
    // session is currently on — so it refuses another desk of *tenant A's own* exactly as it refuses
    // tenant B's. That is strictly stronger than a tenant check, but it means the harness's seeded
    // second desk answers 404 for A as well as for B, and the row would hold even if the route were
    // broken upstream and 404'd everything.
    //
    // This is the control that rules that out: the same route, same session, on the desk A is
    // actually on, answers 200. So the 404 the row asserts is the desk comparison firing.
    const onOwnDesk = await dispatch(
      {
        method: "GET",
        path: `/api/v1/workspaces/${tenantA.workspaceId}/agents`,
        query: {},
        params: {},
        headers: { cookie: `agentforge_session=${sessionA.id}` },
      },
      { serverMode: true, sessionStore: store, now: () => T0 },
    );
    expect(onOwnDesk.status, "tenant A could not list agents on its own current desk").toBe(200);
    expect(Object.keys(((onOwnDesk as HostJsonResult).body ?? {}) as object)).toContain("agents");

    // And the seeded second desk — A's own, but not the one A is on — is refused all the same.
    const onOtherOwnDesk = await dispatch(
      {
        method: "GET",
        path: `/api/v1/workspaces/${seeds.workspaceId}/agents`,
        query: {},
        params: {},
        headers: { cookie: `agentforge_session=${sessionA.id}` },
      },
      { serverMode: true, sessionStore: store, now: () => T0 },
    );
    expect(onOtherOwnDesk.status, "the desk check should refuse A's other desk too").toBe(404);
  });

  /**
   * The desk file routes carry the path in the query, so they are not by-id routes and the
   * completeness assertion below does not list them. They are still a place a caller names another
   * tenant's row, so the same three properties are held here, through `dispatch`: nothing of A's
   * comes back, B cannot tell A's path from a path nobody wrote, and the answer is a 404.
   */
  describe("the desk file routes, which take the path in the query", () => {
    const SECRET_PATH = "private/harness.md";

    const asTenant = (session: { id: string }, method: string, path: string, over: Partial<HostRequest> = {}) =>
      dispatch(
        { method, path, query: {}, params: {}, headers: { cookie: `agentforge_session=${session.id}` }, ...over },
        { serverMode: true, sessionStore: store, now: () => T0 },
      );

    beforeAll(async () => {
      const root = createDeskRoot(tenantA, { kind: "user", userId: tenantA.userId });
      await root.write(SECRET_PATH as DeskPath, `${LEAK_MARKER} desk file`, { kind: "user", userId: tenantA.userId });
    });

    it("are registered in the router", () => {
      const registered = new Set(routeRegistrations().map((route) => `${route.method} ${route.path}`));
      const missing = DESK_FILE_ROUTES.map(([method, path]) => `${method} ${path}`).filter(
        (key) => !registered.has(key),
      );
      expect(missing, `DESK_FILE_ROUTES entries the router does not register: ${missing.join(", ")}`).toEqual([]);
    });

    it.each([
      ["GET", "/api/v1/files/content", (path: string) => ({ query: { path } })],
      ["GET", "/api/v1/files/download", (path: string) => ({ query: { path } })],
      ["GET", "/api/v1/files/versions", (path: string) => ({ query: { path } })],
      ["GET", "/api/v1/files/version", (path: string) => ({ query: { path, version: "1" } })],
      ["POST", "/api/v1/files/revert", (path: string) => ({ body: { path, version: 1 } })],
      ["DELETE", "/api/v1/files", (path: string) => ({ query: { path } })],
    ] as const)("%s %s refuses tenant A's path as it refuses a path nobody wrote", async (method, route, build) => {
      const foreign = await asTenant(sessionB, method, route, build(SECRET_PATH));
      const ghost = await asTenant(sessionB, method, route, build("private/never-written.md"));
      const foreignText = await serialise(foreign);
      expect(foreignText, `${method} ${route} returned tenant A's data`).not.toContain(LEAK_MARKER);
      expect(foreign.status, `${method} ${route} did not 404`).toBe(404);
      expect(shape(foreign, foreignText)).toBe(shape(ghost, await serialise(ghost)));
    });

    it("shows tenant B none of A's files, and leaves A's file as it was", async () => {
      const listed = await asTenant(sessionB, "GET", "/api/v1/files");
      expect(listed.status).toBe(200);
      expect(await serialise(listed)).not.toContain(LEAK_MARKER);
      expect((listed as HostJsonResult).body).toEqual({ items: [] });

      const own = await asTenant(sessionA, "GET", "/api/v1/files/content", { query: { path: SECRET_PATH } });
      expect(own.status).toBe(200);
      expect(await serialise(own)).toContain(LEAK_MARKER);
      expect((await asTenant(sessionA, "GET", "/api/v1/files/versions", { query: { path: SECRET_PATH } })).status).toBe(
        200,
      );
    });
  });

  /**
   * The control for the doc-flow rows, which are the only ones whose handlers are still stubs: a
   * 404 from a route that answered 404 to everybody would satisfy the table above. Tenant A, on its
   * own matter and meeting, must get past the lookup. The assertion is deliberately not "status is
   * 501" so it survives the lanes filling the bodies in: whatever the route answers once it is
   * real (200, 400, a 404 for "no extract yet"), it must not be the lookup's own refusal.
   */
  it("lets tenant A through the lookup on the doc-flow routes that B was refused", async () => {
    const docFlowPaths = new Set([
      "/api/v1/legal/matters/:matterId/extract/stream",
      "/api/v1/legal/matters/:matterId/extract",
      "/api/v1/legal/matters/:matterId/extract/edits",
      "/api/v1/legal/matters/:matterId/extract/comments",
      "/api/v1/legal/matters/:matterId/ask/stream",
      "/api/v1/legal/matters/:matterId/asks",
      "/api/v1/meetings/:meetingId/translate/stream",
      "/api/v1/meetings/:meetingId/transcript/file",
    ]);
    const routes = BY_ID_ROUTES.filter((route) => docFlowPaths.has(route.path));
    expect(routes, "the doc-flow rows are missing from BY_ID_ROUTES").toHaveLength(docFlowPaths.size);
    for (const route of routes) {
      const result = await dispatch(requestFor(route, sessionA.id), {
        serverMode: true,
        sessionStore: store,
        now: () => T0,
      });
      const text = await serialise(result);
      expect(text, `${route.method} ${route.path} refused tenant A's own row`).not.toMatch(
        /(Matter|Meeting) not found/,
      );
    }
  });

  it("covers every by-id route the router registers", () => {
    const registered = routeRegistrations()
      .filter(isByIdRoute)
      .map((route) => `${route.method} ${route.path}`);
    const covered = new Set(BY_ID_ROUTES.map((route) => `${route.method} ${route.path}`));

    const missing = registered.filter((key) => !covered.has(key));
    const stale = [...covered].filter((key) => !registered.includes(key));

    // The message is the point: whoever adds a by-id route reads this, not the diff.
    expect(missing, `by-id routes with no tenancy test — add them to BY_ID_ROUTES: ${missing.join(", ")}`).toEqual([]);
    expect(stale, `BY_ID_ROUTES names routes the router no longer has: ${stale.join(", ")}`).toEqual([]);
  });
});
