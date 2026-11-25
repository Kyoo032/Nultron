import {
  MCP_CONNECTOR_IDS,
  type McpConnectorId,
  type McpConnectorPolicy,
} from "@agentforge/core/mcp";
import { z } from "zod";
import { apiFetch } from "./api-client";

const policySchema = z.object({
  accessMode: z.enum(["read_only", "disabled"]),
  allowSubagents: z.boolean(),
  maxCallsPerTurn: z.number().int(),
});

const connectorSchema = z.object({
  id: z.enum(MCP_CONNECTOR_IDS),
  label: z.string(),
  connected: z.boolean(),
  endpointUrl: z.string().nullable(),
  endpointHost: z.string().nullable(),
  defaultEndpointHint: z.string(),
  fingerprint: z.string().nullable(),
  policy: policySchema,
  allowedActions: z.array(z.string()),
  discoveredTools: z.array(z.string()),
  connectedAt: z.number().nullable(),
});

const boundarySchema = z.object({
  readOnlyEnforced: z.literal(true),
  harnessMutationBlocked: z.literal(true),
  sandboxIsolated: z.literal(true),
  subagentsCanCollaborateInDesk: z.literal(true),
  subagentsCannotEscalatePolicy: z.literal(true),
  maxCallsPerTurn: z.number().int(),
  subagentMaxCallsPerTurn: z.number().int(),
});

const connectorsPayloadSchema = z.object({
  connectors: z.array(connectorSchema),
  boundaries: boundarySchema,
});

const mutationPayloadSchema = z.object({
  connector: connectorSchema,
  boundaries: boundarySchema,
});

const testPayloadSchema = mutationPayloadSchema.extend({
  ok: z.literal(true),
  safeTools: z.array(z.string()),
});

export type McpConnectorView = z.infer<typeof connectorSchema>;
export type McpBoundaryRulesView = z.infer<typeof boundarySchema>;
export type McpConnectorsPayload = z.infer<typeof connectorsPayloadSchema>;
export type McpConnectorMutationPayload = z.infer<typeof mutationPayloadSchema>;
export type McpConnectorTestPayload = z.infer<typeof testPayloadSchema>;

export type SaveMcpConnectorInput = {
  readonly endpointUrl: string;
  readonly token?: string;
  readonly policy: McpConnectorPolicy;
  readonly verify?: boolean;
};

export class McpError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}

const errorPayloadSchema = z.object({
  error: z
    .union([
      z.object({
        code: z.string().optional(),
        message: z.string().optional(),
      }),
      z.string(),
    ])
    .optional(),
  message: z.string().optional(),
});

function errorFrom(payload: unknown, fallback: string): McpError {
  const parsed = errorPayloadSchema.safeParse(payload);
  if (parsed.success) {
    const body = parsed.data;
    if (body.error && typeof body.error === "object") {
      const message = body.error.message?.trim() ? body.error.message : fallback;
      const code = body.error.code?.trim() ? body.error.code : "mcp_error";
      return new McpError(code, message);
    }
    if (typeof body.error === "string") {
      const message = body.message?.trim() ? body.message : fallback;
      return new McpError(body.error, message);
    }
  }
  return new McpError("mcp_error", fallback);
}

async function readJson(res: Response, fallback: string): Promise<unknown> {
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw errorFrom(data, fallback);
  }
  return data;
}

function parseWith<T>(schema: z.ZodType<T, unknown>, data: unknown, what: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new McpError("unexpected_response", `The host returned an unexpected ${what}. Refresh and try again.`);
  }
  return result.data;
}

function connectorPath(connectorId: McpConnectorId): string {
  return `/api/v1/mcp/connectors/${encodeURIComponent(connectorId)}`;
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export async function loadMcpConnectors(): Promise<McpConnectorsPayload> {
  const res = await apiFetch("/api/v1/mcp/connectors");
  const data = await readJson(res, "Could not load the MCP connectors");
  return parseWith(connectorsPayloadSchema, data, "MCP connector list");
}

export async function saveMcpConnector(
  connectorId: McpConnectorId,
  input: SaveMcpConnectorInput,
): Promise<McpConnectorMutationPayload> {
  const token = input.token?.trim();
  const body = {
    endpointUrl: input.endpointUrl,
    ...(token ? { token } : {}),
    policy: input.policy,
    ...(input.verify === undefined ? {} : { verify: input.verify }),
  };
  const res = await apiFetch(connectorPath(connectorId), jsonPost(body));
  const data = await readJson(res, "Could not save this MCP connector");
  return parseWith(mutationPayloadSchema, data, "MCP connector save result");
}

export async function testMcpConnector(connectorId: McpConnectorId): Promise<McpConnectorTestPayload> {
  const res = await apiFetch(`${connectorPath(connectorId)}/test`, jsonPost({}));
  const data = await readJson(res, "Could not test this MCP connector");
  return parseWith(testPayloadSchema, data, "MCP connector test result");
}

export async function disconnectMcpConnector(connectorId: McpConnectorId): Promise<McpConnectorMutationPayload> {
  const res = await apiFetch(connectorPath(connectorId), { method: "DELETE" });
  const data = await readJson(res, "Could not disconnect this MCP connector");
  return parseWith(mutationPayloadSchema, data, "MCP connector disconnect result");
}
