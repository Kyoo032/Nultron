/**
 * F5a — `/v1/chat/completions`: the OpenAI-compatible facade, one endpoint group of the
 * public table. `model` is the desk agent id (spec: the key's allow-list applies to it
 * exactly as it does to `/api/public/v1/agents/:id/messages`).
 *
 * In and out it speaks OpenAI: `{messages: [{role, content}], stream?}` in, a
 * `chat.completion` chunk stream or a single `chat.completion` object back. Underneath it
 * is the same `startModalityRun` as the session route — same guardrails, same quota, same
 * audit — so the facade is a translation, not a second engine.
 */
import type { HostRequest, HostResult } from "../types";
import { jsonOk } from "../errors";
import { ApiError } from "@agentforge/core";
import type { ServiceIdentity } from "./auth";
import { allowsAgent } from "./keys";
import { requireGatewayAllowedFor } from "../gateway-gate";
import { admitRun, guardRunStream } from "../run-limits";
import { startModalityRun } from "../runs";
import { createThread } from "../threads";
import { agentService } from "../tenant";

type ChatMessage = { role?: string; content?: unknown };

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "object" && part && "text" in part ? String(part.text) : ""))
      .join("");
  }
  return "";
}

function promptFrom(messages: ChatMessage[] | undefined): string {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ApiError("invalid_request", "messages is required", 400);
  }
  const last = messages[messages.length - 1];
  const text = contentToText(last?.content);
  if (!text.trim()) {
    throw new ApiError("invalid_request", "the last message needs content", 400);
  }
  // Earlier turns fold into the prompt as context: the run takes one text input.
  const history = messages
    .slice(0, -1)
    .map((m) => `${m.role ?? "user"}: ${contentToText(m.content)}`)
    .join("\n");
  return history ? `${history}\nuser: ${text}` : text;
}

function openAiChunk(agentId: string, id: string, delta: unknown, finish: string | null = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: agentId,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

function openAiCompletion(agentId: string, id: string, text: string) {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: agentId,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

export async function chatCompletionsHandler(request: HostRequest, identity: ServiceIdentity): Promise<HostResult> {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const agentId = typeof body.model === "string" ? body.model : null;
  if (!agentId) {
    throw new ApiError("invalid_request", "model is required", 400);
  }
  if (!allowsAgent(identity.key, agentId)) {
    throw new ApiError("forbidden", "This key is not allowed to call that agent", 403);
  }
  const tenant = identity.tenant;
  // The allow-list alone does not prove the agent exists: an unknown id must answer 404
  // like `requireAgent` on the other routes, never a foreign-key failure inside
  // `createThread`.
  const published = await agentService.getPublishedForRun(tenant, agentId);
  if (!published) {
    throw new ApiError("not_found", "Agent not found", 404);
  }
  const prompt = promptFrom(body.messages as ChatMessage[] | undefined);
  requireGatewayAllowedFor(tenant);
  const thread = await createThread(tenant, agentId, `OpenAI facade ${agentId}`);
  const release = admitRun(tenant);
  const runId = `chatcmpl-${crypto.randomUUID()}`;
  const events = guardRunStream(
    release,
    startModalityRun({
      tenant,
      threadId: thread.id,
      modality: "text",
      body: { content: prompt },
      abortSignal: request.abortSignal,
    }),
  );
  if (body.stream === true) {
    const mapped = (async function* () {
      yield `data: ${JSON.stringify(openAiChunk(agentId, runId, { role: "assistant" }))}\n\n`;
      let failed = false;
      for await (const frame of events) {
        const event = frame.match(/event: (\S+)/)?.[1];
        const data = frame.match(/data: (.*)/)?.[1];
        if (!event || !data) continue;
        try {
          const payload = JSON.parse(data) as { text?: string; message?: string };
          if (event === "assistant.delta") {
            yield `data: ${JSON.stringify(openAiChunk(agentId, runId, { content: payload.text ?? "" }))}\n\n`;
          } else if (event === "run.failed") {
            failed = true;
            yield `data: ${JSON.stringify({ error: { message: payload.message ?? "Run failed", type: "server_error" } })}\n\n`;
          } else if (event === "run.completed") {
            yield `data: ${JSON.stringify(openAiChunk(agentId, runId, {}, "stop"))}\n\n`;
          }
        } catch {
          // Non-JSON frame: pass through nothing.
        }
      }
      if (!failed) {
        yield "data: [DONE]\n\n";
      }
    })();
    return { type: "stream", status: 200, events: mapped };
  }
  let text = "";
  let failed: string | null = null;
  for await (const frame of events) {
    const event = frame.match(/event: (\S+)/)?.[1];
    const data = frame.match(/data: (.*)/)?.[1];
    if (!event || !data) continue;
    try {
      const payload = JSON.parse(data) as { text?: string; message?: string };
      if (event === "assistant.delta") text += payload.text ?? "";
      if (event === "run.failed") failed = payload.message ?? "Run failed";
    } catch {
      // ignore
    }
  }
  if (failed) {
    return jsonOk({ error: { message: failed, type: "server_error" } }, 502);
  }
  return jsonOk(openAiCompletion(agentId, runId, text));
}
