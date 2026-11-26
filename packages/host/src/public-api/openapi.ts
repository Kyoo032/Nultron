/**
 * F5a — OpenAPI 3.1 for the public table. Request bodies are zod schemas emitted with
 * `z.toJSONSchema` (zod ^4, no new library — spec said "from zod if it can emit JSON
 * Schema", and this version can). Paths stay a literal description of `routes.ts`; the
 * test in `openapi.test.ts` parses the document and asserts every public route has a path
 * entry, so the two cannot drift silently.
 */
import { z } from "zod";

const messageBody = z
  .object({
    content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
    stream: z.boolean().optional(),
  })
  .describe("Same shape as the desk's own run body: text content, or an SSE stream when `stream` is true.");

const threadBody = z.object({
  agentId: z.string(),
  title: z.string().optional(),
});

const ingestBody = z.object({
  name: z.string(),
  text: z.string(),
  type: z.enum(["Paste", "Document"]).optional(),
});

const fileBody = z.object({
  name: z.string(),
  type: z.string().describe("MIME type, e.g. image/png"),
  data: z.string().describe("base64-encoded bytes"),
});

const chatCompletionsBody = z.object({
  model: z.string().describe("Agent id"),
  messages: z.array(z.object({ role: z.string().optional(), content: z.unknown() })),
  stream: z.boolean().optional(),
});

const errorResponse = {
  description: "Standard `{ error: { code, message } }` envelope; 429s carry `Retry-After`.",
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: {
          error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
        },
      },
    },
  },
} as const;

function body(schema: z.ZodType) {
  return { requestBody: { required: true, content: { "application/json": { schema: z.toJSONSchema(schema) } } } };
}

const SEC = [{ bearerAuth: [] as string[] }];

export function openApiDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Nultron Public API",
      version: "1.0.0",
      description:
        "Versioned desk API. Bearer `nk_live_…` keys are scoped to agents and desk rate-limited; runs, knowledge, files and usage behave exactly as on the web.",
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "`Authorization: Bearer nk_live_…`" },
      },
    },
    paths: {
      "/api/public/v1/openapi.json": {
        get: { summary: "This document", responses: { 200: { description: "OpenAPI 3.1" } } },
      },
      "/api/public/v1/agents": {
        get: {
          summary: "Agents this key may call",
          security: SEC,
          responses: { 200: { description: "Agent list" }, 401: errorResponse, 429: errorResponse },
        },
      },
      "/api/public/v1/agents/{agentId}/messages": {
        post: {
          summary: "Run an agent (sync JSON, or SSE when `Accept: text/event-stream`)",
          security: SEC,
          parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
          ...body(messageBody),
          responses: {
            200: { description: "Run answer or SSE stream" },
            401: errorResponse,
            403: errorResponse,
            429: errorResponse,
          },
        },
      },
      "/api/public/v1/agents/{agentId}/jobs": {
        post: {
          summary: "Start an async run; the result is stored sealed",
          security: SEC,
          parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
          ...body(messageBody),
          responses: { 202: { description: "Job id" }, 401: errorResponse, 403: errorResponse, 429: errorResponse },
        },
      },
      "/api/public/v1/jobs/{id}": {
        get: {
          summary: "Job status and, once done, its result",
          security: SEC,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Job" }, 401: errorResponse, 404: errorResponse },
        },
      },
      "/api/public/v1/threads": {
        get: {
          summary: "Threads owned by this key's service identity",
          security: SEC,
          parameters: [{ name: "agentId", in: "query", required: false, schema: { type: "string" } }],
          responses: { 200: { description: "Threads" }, 401: errorResponse },
        },
        post: {
          summary: "Open a thread on an agent",
          security: SEC,
          ...body(threadBody),
          responses: { 201: { description: "Thread" }, 401: errorResponse, 403: errorResponse },
        },
      },
      "/api/public/v1/threads/{id}": {
        get: {
          summary: "A thread and its messages",
          security: SEC,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Thread + messages" }, 401: errorResponse, 404: errorResponse },
        },
      },
      "/api/public/v1/knowledge/ingest": {
        post: {
          summary: "Index pasted text into the desk knowledge base",
          security: SEC,
          ...body(ingestBody),
          responses: { 201: { description: "Source" }, 400: errorResponse, 401: errorResponse, 413: errorResponse },
        },
      },
      "/api/public/v1/knowledge/search": {
        get: {
          summary: "Retrieve knowledge chunks",
          security: SEC,
          parameters: [{ name: "query", in: "query", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Chunks" }, 400: errorResponse, 401: errorResponse },
        },
      },
      "/api/public/v1/files": {
        post: {
          summary: "Upload a file to the desk object store",
          security: SEC,
          ...body(fileBody),
          responses: { 201: { description: "Stored media" }, 400: errorResponse, 401: errorResponse },
        },
      },
      "/api/public/v1/files/{id}": {
        get: {
          summary: "Download a stored file (range requests supported)",
          security: SEC,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            200: { description: "Bytes" },
            206: { description: "Partial bytes" },
            401: errorResponse,
            404: errorResponse,
            416: errorResponse,
          },
        },
      },
      "/api/public/v1/usage": {
        get: {
          summary: "Desk usage for a range",
          security: SEC,
          parameters: [{ name: "range", in: "query", required: false, schema: { type: "string" } }],
          responses: { 200: { description: "Usage" }, 401: errorResponse },
        },
      },
      "/v1/chat/completions": {
        post: {
          summary: "OpenAI-compatible facade; `model` is the agent id",
          security: SEC,
          ...body(chatCompletionsBody),
          responses: {
            200: { description: "chat.completion or SSE chunks" },
            401: errorResponse,
            403: errorResponse,
            429: errorResponse,
          },
        },
      },
    },
  };
}
