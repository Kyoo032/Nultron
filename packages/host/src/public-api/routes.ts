/**
 * F5a — the public route table: one curated subset under `/api/public/v1/*`, plus the
 * OpenAI-compatible facade at `/v1/chat/completions`.
 *
 * Every row declares its own auth (`key`), so `routes.test.ts` can walk the table and
 * prove nothing callable is anonymous: `resolveApiKey` has already run by the time a
 * handler sees the request, `checkApiKeyRate` has counted it, and the handler gets a
 * **service identity** (`userId: apikey-<id>`, role `member`) built in `./auth.ts` —
 * never an owner session.
 *
 * Reuse rule: no public handler re-implements what the session handlers do. It calls the
 * same inner functions (`startModalityRun`, `createThread`, `addPastedSource`,
 * `retrieveChunks`, `saveMedia`, `loadRangeUsage`, `admitRun`) with the service tenant,
 * so guardrails, quota and audit behave exactly as on the web (AC-5a.4).
 */
import { ApiError, parseUsageRange, reportAuditEvent } from "@agentforge/core";
import type { HostRequest, HostResult } from "../types";
import { jsonError, jsonOk } from "../errors";
import { requireGatewayAllowedFor } from "../gateway-gate";
import { admitRun, guardRunStream } from "../run-limits";
import { startModalityRun } from "../runs";
import { createThread, listMessages, listWorkspaceThreads, getThread } from "../threads";
import { agentService } from "../tenant";
import { addPastedSource, pastedSourceType, retrieveChunks } from "../knowledge";
import { saveMedia, statMedia } from "../media";
import { loadSettings } from "../settings-store";
import { loadRangeUsage } from "../account-usage";
import { readTenantObjectRange } from "../tenant-storage";
import { db, media } from "@agentforge/db";
import { and, eq } from "drizzle-orm";
import { allowsAgent, type ApiKeyRow } from "./keys";
import {
  authenticatePublic,
  isPublicApiPath,
  OPENAI_FACADE_PATH,
  publicApiEnabled,
  type ServiceIdentity,
} from "./auth";

export { isPublicApiPath };
import { createApiJob, failApiJob, getApiJob, sealApiJobResult, setApiJobStatus } from "./jobs";
import { checkApiKeyRate } from "../rate-limit";
import { chatCompletionsHandler } from "./openai-facade";
import { openApiDocument } from "./openapi";

type PublicHandler = (request: HostRequest, identity: ServiceIdentity) => Promise<HostResult>;

type PublicRoute = {
  method: string;
  path: string;
  /** Agent the call acts on, taken from `:agentId` or the body — checked against the key's allow-list. */
  agentKey?: "agentId";
  pattern: RegExp;
  keys: string[];
  handler: PublicHandler;
};

function compile(method: string, path: string, handler: PublicHandler, agentKey?: "agentId"): PublicRoute {
  const keys: string[] = [];
  const source = path.replace(/:([A-Za-z]+)/g, (_, key: string) => {
    keys.push(key);
    return "([^/]+)";
  });
  return { method, path, agentKey, pattern: new RegExp(`^${source}$`), keys, handler };
}

/** `run.started`/`assistant.delta`/`run.completed`… from an SSE stream of `encodeSse` frames. */
async function collectRun(events: AsyncIterable<string>): Promise<{
  runId: string | null;
  text: string;
  failed: string | null;
}> {
  let runId: string | null = null;
  let text = "";
  let failed: string | null = null;
  for await (const frame of events) {
    for (const chunk of frame.split("\n\n")) {
      const event = chunk.match(/event: (\S+)/)?.[1];
      const data = chunk.match(/data: (.*)/)?.[1];
      if (!event || !data) {
        continue;
      }
      try {
        const payload = JSON.parse(data) as { runId?: string; text?: string; message?: string };
        if (event === "run.started") {
          runId = payload.runId ?? runId;
        } else if (event === "assistant.delta") {
          text += payload.text ?? "";
        } else if (event === "run.failed") {
          failed = payload.message ?? "Run failed";
        }
      } catch {
        // A non-JSON frame is commentary, not data.
      }
    }
  }
  return { runId, text, failed };
}

async function requireAgent(identity: ServiceIdentity, agentId: string): Promise<void> {
  if (!allowsAgent(identity.key, agentId)) {
    throw new ApiError("forbidden", "This key is not allowed to call that agent", 403);
  }
  const published = await agentService.getPublishedForRun(identity.tenant, agentId);
  if (!published) {
    throw new ApiError("not_found", "Agent not found", 404);
  }
}

async function streamRun(identity: ServiceIdentity, agentId: string, body: unknown, abort?: AbortSignal) {
  const tenant = identity.tenant;
  requireGatewayAllowedFor(tenant);
  const thread = await createThread(tenant, agentId);
  const release = admitRun(tenant);
  try {
    return {
      thread,
      release,
      events: guardRunStream(
        release,
        startModalityRun({ tenant, threadId: thread.id, modality: "text", body, abortSignal: abort }),
      ),
    };
  } catch (error) {
    release();
    throw error;
  }
}

const routes: PublicRoute[] = [
  compile("GET", "/api/public/v1/openapi.json", async () => jsonOk(openApiDocument())),
  compile("GET", "/api/public/v1/agents", async (_request, identity) => {
    const agents = await agentService.list(identity.tenant);
    const allowedAgents = JSON.parse(identity.key.allowed_agents) as string[];
    const visible = allowedAgents.includes("*")
      ? agents
      : agents.filter((agent: { id: string }) => allowedAgents.includes(agent.id));
    return jsonOk({ agents: visible });
  }),
  compile(
    "POST",
    "/api/public/v1/agents/:agentId/messages",
    async (request, identity) => {
      const agentId = request.params.agentId;
      await requireAgent(identity, agentId);
      const bodyIn = (request.body ?? {}) as Record<string, unknown>;
      const wantsStream = /text\/event-stream/i.test(request.headers.accept ?? "") || bodyIn.stream === true;
      const { thread, release, events } = await streamRun(identity, agentId, bodyIn, request.abortSignal);
      if (wantsStream) {
        const iterator = events[Symbol.asyncIterator]();
        const first = await iterator.next();
        let unread: IteratorResult<string> | null = first;
        const replay: AsyncIterableIterator<string> = {
          [Symbol.asyncIterator]: () => replay,
          async next() {
            if (unread) {
              const step = unread;
              unread = null;
              return step;
            }
            return iterator.next();
          },
          async return(v) {
            unread = null;
            return iterator.return ? iterator.return(v) : { done: true, value: undefined };
          },
          async throw(e) {
            unread = null;
            if (iterator.throw) return iterator.throw(e);
            throw e;
          },
        };
        return { type: "stream", status: 200, events: replay };
      }
      const collected = await collectRun(events);
      // `release` runs at stream end via guardRunStream; collectRun consumed it to done.
      void release;
      if (collected.failed) {
        return jsonOk({ threadId: thread.id, runId: collected.runId, error: collected.failed }, 502);
      }
      return jsonOk({ threadId: thread.id, runId: collected.runId, text: collected.text });
    },
    "agentId",
  ),
  compile(
    "POST",
    "/api/public/v1/agents/:agentId/jobs",
    async (request, identity) => {
      const agentId = request.params.agentId;
      await requireAgent(identity, agentId);
      const job = createApiJob(identity.tenant.tenantId, identity.key.id, agentId);
      // Fire-and-forget inside the same process: the row is the queue, and the answer
      // lands sealed in `result_sealed` (spec S1) — never plaintext.
      void (async () => {
        setApiJobStatus(job.id, "running");
        try {
          const { events } = await streamRun(identity, agentId, (request.body ?? {}) as Record<string, unknown>);
          const collected = await collectRun(events);
          if (collected.failed) {
            failApiJob(job.id, collected.failed);
          } else {
            sealApiJobResult(job.id, collected.text);
          }
        } catch (error) {
          failApiJob(job.id, error instanceof Error ? error.message : "Job failed");
        }
      })();
      return jsonOk({ id: job.id, agentId, status: "queued" }, 202);
    },
    "agentId",
  ),
  compile("GET", "/api/public/v1/jobs/:id", async (request, identity) =>
    jsonOk(getApiJob(identity.tenant.tenantId, identity.key.id, request.params.id)),
  ),
  compile("GET", "/api/public/v1/threads", async (request, identity) =>
    jsonOk({ threads: await listWorkspaceThreads(identity.tenant, { agentId: request.query.agentId }) }),
  ),
  compile("POST", "/api/public/v1/threads", async (request, identity) => {
    const bodyIn = (request.body ?? {}) as Record<string, unknown>;
    const agentId = typeof bodyIn.agentId === "string" ? bodyIn.agentId : null;
    if (!agentId) {
      throw new ApiError("invalid_request", "agentId is required", 400);
    }
    await requireAgent(identity, agentId);
    const title = typeof bodyIn.title === "string" ? bodyIn.title : undefined;
    return jsonOk(await createThread(identity.tenant, agentId, title), 201);
  }),
  compile("GET", "/api/public/v1/threads/:id", async (request, identity) => {
    const thread = await getThread(identity.tenant, request.params.id);
    if (!thread) {
      throw new ApiError("not_found", "Thread not found", 404);
    }
    await requireAgent(identity, thread.agentId);
    return jsonOk({ thread, messages: await listMessages(identity.tenant, thread.id) });
  }),
  compile("POST", "/api/public/v1/knowledge/ingest", async (request, identity) => {
    const bodyIn = (request.body ?? {}) as Record<string, unknown>;
    const name = typeof bodyIn.name === "string" ? bodyIn.name : null;
    const text = typeof bodyIn.text === "string" ? bodyIn.text : null;
    if (!name || !text) {
      throw new ApiError("invalid_request", "name and text are required", 400);
    }
    const source = await addPastedSource(identity.tenant, name, text, pastedSourceType(bodyIn.type));
    return jsonOk(source, 201);
  }),
  compile("GET", "/api/public/v1/knowledge/search", async (request, identity) => {
    const query = typeof request.query.query === "string" ? request.query.query : "";
    if (!query.trim()) {
      throw new ApiError("invalid_request", "query is required", 400);
    }
    return jsonOk(await retrieveChunks(identity.tenant, query, 8));
  }),
  compile("POST", "/api/public/v1/files", async (request, identity) => {
    const bodyIn = (request.body ?? {}) as Record<string, unknown>;
    const name = typeof bodyIn.name === "string" ? bodyIn.name : null;
    const type = typeof bodyIn.type === "string" ? bodyIn.type : null;
    const data = typeof bodyIn.data === "string" ? bodyIn.data : null;
    if (!name || !type || !data) {
      throw new ApiError("invalid_request", "name, type and base64 data are required", 400);
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0) {
      throw new ApiError("invalid_request", "data must be base64-encoded content", 400);
    }
    const file = new File([bytes], name, { type });
    const row = await saveMedia(identity.tenant, file, ["image", "video", "audio"]);
    return jsonOk({ id: row.id, kind: row.kind, mime: row.mime, sizeBytes: row.sizeBytes }, 201);
  }),
  compile("GET", "/api/public/v1/files/:id", async (request, identity) => {
    const stat = await statMedia(identity.tenant, request.params.id);
    if (!stat) {
      throw new ApiError("not_found", "File not found", 404);
    }
    const [row] = await db
      .select()
      .from(media)
      .where(and(eq(media.organizationId, identity.tenant.organizationId), eq(media.id, request.params.id)))
      .limit(1);
    if (!row) {
      throw new ApiError("not_found", "File not found", 404);
    }
    const ranged = await readTenantObjectRange(identity.tenant.tenantId, row.storagePath, request.headers.range);
    return {
      type: "bytes",
      status: ranged.status,
      contentType: row.mime,
      bytes: ranged.bytes,
      headers: ranged.headers,
    };
  }),
  compile("GET", "/api/public/v1/usage", async (request, identity) =>
    jsonOk(await loadRangeUsage(loadSettings(identity.tenant), identity.tenant, parseUsageRange(request.query.range))),
  ),
  compile("POST", OPENAI_FACADE_PATH, chatCompletionsHandler),
];

export function publicRouteRegistrations(): readonly { method: string; path: string }[] {
  return routes.map((route) => ({ method: route.method, path: route.path }));
}

/**
 * `dispatch` in `../router.ts` calls this before its session gate whenever the path is under
 * the public prefix. With `AGENTFORGE_PUBLIC_API` unset the answer is a plain 404 — a caller
 * learns the same as for any unregistered path.
 */
export async function dispatchPublicApi(request: HostRequest): Promise<HostResult> {
  const method = request.method.toUpperCase();
  const path = request.path.replace(/\/+$/, "") || "/";
  if (!publicApiEnabled()) {
    return jsonOk({ error: { code: "not_found", message: "Not found" } }, 404);
  }
  if (!isPublicApiPath(path)) {
    return jsonOk({ error: { code: "not_found", message: "Not found" } }, 404);
  }
  let identity: ServiceIdentity;
  let outcome: { status: number; code: string } = { status: 200, code: "ok" };
  try {
    identity = await authenticatePublic(request);
  } catch (error) {
    return jsonError(error);
  }
  try {
    const rate = checkApiKeyRate(identity.key);
    if (!rate.allowed) {
      outcome = { status: 429, code: "rate_limited" };
      return jsonOk(
        { error: { code: "rate_limited", message: "Rate limit exceeded for this API key" } },
        429,
        undefined,
        { "Retry-After": String(rate.retryAfterSeconds) },
      );
    }
    for (const route of routes) {
      if (route.method !== method) {
        continue;
      }
      const match = route.pattern.exec(path);
      if (!match) {
        continue;
      }
      const params: Record<string, string> = { ...request.params };
      route.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(match[index + 1] ?? "");
      });
      const scoped = { ...request, params, path };
      const result = await route.handler(scoped, identity);
      const envelope =
        result.type === "json" ? ((result.body as { error?: { code?: string } } | null)?.error?.code ?? "ok") : "ok";
      outcome = { status: result.status, code: envelope };
      return result;
    }
    outcome = { status: 404, code: "not_found" };
    return jsonOk({ error: { code: "not_found", message: "Not found" } }, 404);
  } catch (error) {
    const result = jsonError(error);
    const envelope = (result.body as { error?: { code?: string } } | null)?.error;
    outcome = { status: result.status, code: envelope?.code ?? "error" };
    return result;
  } finally {
    // AC-5a.6: every public call is in the audit log with the key id, agent (when the
    // route names one) and outcome — metadata only, never content (S-rules).
    try {
      const key: ApiKeyRow = identity.key;
      reportAuditEvent({
        tenantId: key.tenant_id,
        event: "api_key.request",
        actorKind: "api_key",
        actorId: key.id,
        targetKind: "public_api",
        targetId: `${method} ${path}`,
        outcome: outcome.status < 400 ? "ok" : outcome.status === 401 || outcome.status === 403 ? "denied" : "failed",
        channel: "public_api",
      });
    } catch {
      // Audit is best-effort; it never refuses a call.
    }
  }
}
