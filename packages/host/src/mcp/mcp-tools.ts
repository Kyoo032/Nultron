import { z } from "zod";
import {
  MCP_BOUNDARY_RULES,
  MCP_CONNECTOR_IDS,
  MCP_CONNECTOR_SPECS,
  MCP_FETCH_TOOL_KEY,
  MCP_LIMITS,
  MCP_LIST_SOURCES_TOOL_KEY,
  defineTool,
  isAllowedMcpAction,
  isMcpConnectorId,
  redactSecrets,
  type TenantContext,
} from "@agentforge/core";
import { currentDelegation } from "../delegation/delegation-context";
import { currentToolRun } from "../tool-run-context";
import { McpHttpClient } from "./client";
import { mcpStore } from "./store";

const runConnectorCalls = new Map<string, number>();

function trackConnectorCall(runId: string | undefined, connectorId: string, maxAllowed: number): boolean {
  if (!runId) {
    return true;
  }
  if (runConnectorCalls.size > 500) {
    runConnectorCalls.clear();
  }
  const key = `${runId}:${connectorId}`;
  const used = runConnectorCalls.get(key) ?? 0;
  if (used >= maxAllowed) {
    return false;
  }
  runConnectorCalls.set(key, used + 1);
  return true;
}

const listSourcesSchema = z.object({});

const fetchSchema = z.object({
  connector: z
    .enum(MCP_CONNECTOR_IDS)
    .describe("Connected MCP source to read from: gmail, google_drive, onedrive, or notion."),
  action: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .describe(
      "Allowlisted read-only action for the connector (e.g. search_messages, get_message, search_files, read_file, search, get_page, query_database). Write/delete/harness actions are strictly blocked.",
    ),
  query: z
    .string()
    .trim()
    .max(MCP_LIMITS.maxQueryChars)
    .optional()
    .describe("Search query string for search/list actions."),
  resourceId: z
    .string()
    .trim()
    .max(256)
    .optional()
    .describe("Specific message, file, page, or database ID for get/read actions."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .optional()
    .describe("Maximum number of items to return (1–25)."),
});

export async function runMcpListSources(tenant: TenantContext) {
  const delegated = Boolean(currentDelegation());
  const views = mcpStore()
    .listViews(tenant)
    .filter((view) => view.connected && view.policy.accessMode === "read_only")
    .filter((view) => !delegated || view.policy.allowSubagents);

  return {
    sandbox: MCP_BOUNDARY_RULES,
    callerRole: delegated ? "delegated_subagent" : "primary_agent",
    sources: views.map((view) => ({
      id: view.id,
      label: view.label,
      endpointHost: view.endpointHost,
      accessMode: view.policy.accessMode,
      allowSubagents: view.policy.allowSubagents,
      allowedActions: view.allowedActions,
      discoveredTools: view.discoveredTools,
    })),
  };
}

export async function runMcpFetch(
  args: z.infer<typeof fetchSchema>,
  tenant: TenantContext,
  fetchImpl: typeof fetch = fetch,
) {
  if (!isMcpConnectorId(args.connector)) {
    return {
      ok: false,
      reason: "unknown_connector",
      message: `Unsupported MCP connector "${String(args.connector)}".`,
    };
  }
  const spec = MCP_CONNECTOR_SPECS[args.connector];
  if (!isAllowedMcpAction(args.connector, args.action)) {
    return {
      ok: false,
      reason: "boundary_blocked",
      connector: args.connector,
      message: `Blocked by sandbox boundary: "${args.action}" is not an allowlisted read-only action for ${spec.label}. Allowed actions: ${spec.allowedActions.join(", ")}.`,
    };
  }

  const connection = mcpStore().getConnection(tenant, args.connector);
  if (!connection) {
    return {
      ok: false,
      reason: "not_connected",
      connector: args.connector,
      message: `${spec.label} is not connected on this desk. Ask the owner to connect it in Settings → Connectors (MCP).`,
    };
  }
  if (connection.policy.accessMode !== "read_only") {
    return {
      ok: false,
      reason: "disabled",
      connector: args.connector,
      message: `${spec.label} MCP access is currently disabled by desk policy.`,
    };
  }

  const delegated = currentDelegation();
  if (delegated && !connection.policy.allowSubagents) {
    return {
      ok: false,
      reason: "subagent_blocked",
      connector: args.connector,
      message: `Delegated subagents are not permitted to access ${spec.label} under this desk's MCP boundary policy. Return to the primary orchestrator or ask the owner to allow subagent access.`,
    };
  }

  const effectiveLimit = delegated
    ? Math.min(connection.policy.maxCallsPerTurn, MCP_LIMITS.subagentMaxCallsPerTurn)
    : connection.policy.maxCallsPerTurn;
  if (!trackConnectorCall(currentToolRun()?.runId, args.connector, effectiveLimit)) {
    return {
      ok: false,
      reason: "turn_limit_reached",
      connector: args.connector,
      message: `Per-turn MCP call limit (${effectiveLimit}) reached for ${spec.label}.`,
    };
  }

  const rpcArgs: Record<string, unknown> = {};
  if (args.query !== undefined) {
    rpcArgs.query = args.query;
  }
  if (args.resourceId !== undefined) {
    rpcArgs.id = args.resourceId;
    rpcArgs.resourceId = args.resourceId;
  }
  if (args.limit !== undefined) {
    rpcArgs.limit = args.limit;
  }

  try {
    const client = new McpHttpClient(args.connector, connection.endpointUrl, connection.token, fetchImpl);
    const result = await client.callReadOnlyTool(args.action, rpcArgs);
    return {
      ok: true,
      connector: args.connector,
      label: spec.label,
      action: args.action,
      boundary: "read_only_sandbox",
      callerRole: delegated ? "delegated_subagent" : "primary_agent",
      content: redactSecrets(result.content),
    };
  } catch (error) {
    return {
      ok: false,
      reason: "fetch_failed",
      connector: args.connector,
      message: redactSecrets(error instanceof Error ? error.message : `Failed to read from ${spec.label}.`),
    };
  }
}

export const mcpListSourcesTool = defineTool({
  key: MCP_LIST_SOURCES_TOOL_KEY,
  name: "List MCP sources",
  description:
    "List connected read-only MCP sources (Gmail, Google Drive, OneDrive, Notion) available inside this desk's sandbox and their active boundary rules.",
  schema: listSourcesSchema,
  trust: "internal",
  execute: (_args, tenant) => runMcpListSources(tenant),
});

/**
 * `user_content` trust: external Gmail, Google Drive, OneDrive, and Notion text is attacker-reachable
 * and private, so it MUST pass through Nultron's prompt-injection scanner AND taint the run's egress
 * guard (SR-112) to prevent exfiltration.
 */
export const mcpFetchTool = defineTool({
  key: MCP_FETCH_TOOL_KEY,
  name: "Fetch from MCP source",
  description:
    "Read or search data from a connected MCP source (Gmail, Google Drive, OneDrive, Notion) inside Nultron's read-only sandbox. External writes, sends, deletes, and harness changes are strictly blocked.",
  schema: fetchSchema,
  trust: "user_content",
  execute: (args, tenant) => runMcpFetch(args, tenant),
});
