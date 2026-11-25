import { z } from "zod";
import {
  MCP_BOUNDARY_RULES,
  MCP_CONNECTOR_IDS,
  MCP_CONNECTOR_SPECS,
  MCP_FETCH_TOOL_KEY,
  MCP_LIMITS,
  MCP_LIST_SOURCES_TOOL_KEY,
  currentOutboundGuard,
  defineTool,
  inToolCall,
  isAllowedMcpAction,
  isMcpConnectorId,
  outboundRefusal,
  queryShapeProblem,
  redactCredentials,
  redactSecrets,
  type OutboundRefusal,
  type TenantContext,
} from "@agentforge/core";
import { currentDelegation } from "../delegation/delegation-context";
import { currentToolRun, type ToolRun } from "../tool-run-context";
import { McpHttpClient } from "./client";
import { mcpStore } from "./store";

/**
 * The outbound-guard verdict for text an MCP call would carry off this machine (SR-112).
 *
 * `mcp_fetch` is a sender in the same sense as web search: the query and the resource id leave the
 * host on a third-party server, so a tainted run must never pack the person's private text into
 * either. The contract of `security/outbound-guard.ts` is mirrored exactly: inside a guarded run the
 * guard judges the text; inside a model's tool call with no guard open the send is refused closed;
 * anywhere else (a host route, a test) the shape rules still apply and nothing is counted.
 */
function mcpOutboundRefusal(text: string): OutboundRefusal | null {
  const guard = currentOutboundGuard();
  if (guard) {
    return guard.judgeQuery(text);
  }
  if (inToolCall()) {
    return outboundRefusal("unguarded", "en");
  }
  const shape = queryShapeProblem(text);
  return shape ? outboundRefusal(shape, "en") : null;
}

function mcpOutboundStoppedRefusal(): OutboundRefusal | null {
  const guard = currentOutboundGuard();
  if (!guard) {
    return inToolCall() ? outboundRefusal("unguarded", "en") : null;
  }
  const probe = guard.judgeQuery("ok");
  return probe?.kind === "stopped" ? probe : null;
}

const runConnectorCalls = new WeakMap<ToolRun, Map<string, number>>();
/** Per-run, per-connector map of displayed resourceId -> original wire resourceId returned by the endpoint. */
const runConnectorResourceIds = new WeakMap<ToolRun, Map<string, Map<string, string>>>();
const RESOURCE_ID_TOKEN_RE = /\b[A-Za-z0-9_-]{16,80}\b/g;
const COMPACT_HEX_UUID_V4_RE = /\b([0-9a-f]{8})([0-9a-f]{4})(4[0-9a-f]{3})([89ab][0-9a-f]{3})([0-9a-f]{12})\b/gi;
const NOTION_URL_BEFORE_RE = /https?:\/\/(?:[a-z0-9-]+\.)*notion\.(?:so|site)\/[^\s?#]*$/i;
const NOTION_ID_LABEL_BEFORE_RE =
  /(?:^|[\s,{[(])["']?(?:(?:page|block|database|db|parent|resource|notion|object|record|workspace)[_\s-]*)?(?:id|page|block|database|resource)["']?[\s:=#-]{1,6}["']?$/i;
const SECRET_LABEL_BEFORE_RE =
  /(?:^|[\s,:{[("'_-])(?:secret|token|key|pass(?:word|wd)?|pwd|auth|bearer|cookie|sig(?:nature)?|hash|checksum|md5|sha\d*|hmac|cred(?:ential)?|private|webhook)(?:[_\s-]*id)?["']?[\s:=#-]{0,6}["']?$/i;

function hasNotionIdContext(text: string, offset: number): boolean {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const before = text.slice(Math.max(lineStart, offset - 160), offset);
  if (NOTION_URL_BEFORE_RE.test(before)) {
    return true;
  }
  if (SECRET_LABEL_BEFORE_RE.test(before)) {
    return false;
  }
  return NOTION_ID_LABEL_BEFORE_RE.test(before);
}

function canonicalizeNotionIds(text: string): { text: string; aliases: Array<readonly [string, string]> } {
  const aliases: Array<readonly [string, string]> = [];
  const replaced = text.replace(
    COMPACT_HEX_UUID_V4_RE,
    (raw, a: string, b: string, c: string, d: string, e: string, offset: number) => {
      if (!hasNotionIdContext(text, offset)) {
        return raw;
      }
      const hyphenated = `${a}-${b}-${c}-${d}-${e}`;
      aliases.push([hyphenated, raw]);
      return hyphenated;
    },
  );
  return { text: replaced, aliases };
}

function rememberConnectorResourceIds(
  toolRun: ToolRun | undefined,
  connectorId: string,
  rawContent: string,
  redactedContent: string,
  aliases: ReadonlyArray<readonly [string, string]> = [],
): void {
  if (!toolRun) {
    return;
  }
  let byConnector = runConnectorResourceIds.get(toolRun);
  if (!byConnector) {
    byConnector = new Map<string, Map<string, string>>();
    runConnectorResourceIds.set(toolRun, byConnector);
  }
  let known = byConnector.get(connectorId);
  if (!known) {
    known = new Map<string, string>();
    byConnector.set(connectorId, known);
  }
  const rawTokens = new Set<string>();
  for (const match of rawContent.matchAll(RESOURCE_ID_TOKEN_RE)) {
    rawTokens.add(match[0]);
  }
  const visibleTokens = new Set<string>();
  for (const match of redactedContent.matchAll(RESOURCE_ID_TOKEN_RE)) {
    visibleTokens.add(match[0]);
  }
  for (const token of visibleTokens) {
    if (!rawTokens.has(token)) {
      continue;
    }
    if (!known.has(token) && known.size >= 200) {
      continue;
    }
    known.set(token, token);
  }
  for (const [displayed, original] of aliases) {
    if (known.has(displayed) || !redactedContent.includes(displayed)) {
      continue;
    }
    if (known.size >= 200) {
      break;
    }
    known.set(displayed, original);
    if (!known.has(original) && known.size < 200) {
      known.set(original, original);
    }
  }
}

function resolveRememberedResourceId(
  toolRun: ToolRun | undefined,
  connectorId: string,
  resourceId: string,
): string | undefined {
  if (!toolRun) {
    return undefined;
  }
  return runConnectorResourceIds.get(toolRun)?.get(connectorId)?.get(resourceId);
}

function trackConnectorCall(toolRun: ToolRun | undefined, connectorId: string, maxAllowed: number): boolean {
  if (!toolRun) {
    return true;
  }
  let counts = runConnectorCalls.get(toolRun);
  if (!counts) {
    counts = new Map<string, number>();
    runConnectorCalls.set(toolRun, counts);
  }
  const used = counts.get(connectorId) ?? 0;
  if (used >= maxAllowed) {
    return false;
  }
  counts.set(connectorId, used + 1);
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

  const toolRun = currentToolRun();
  // The egress check comes before the turn counter: a query the guard refuses never leaves the
  // machine, so it must not spend one of the turn's calls either.
  // Exact resourceIds returned earlier in this run by the SAME connector (e.g. Notion page UUIDs)
  // are permitted back to that connector unless the outbound guard has stopped the turn.
  if (args.query !== undefined) {
    const refusal = mcpOutboundRefusal(args.query);
    if (refusal) {
      return {
        ok: false,
        reason: "outbound_blocked",
        connector: args.connector,
        message: refusal.message,
      };
    }
  }
  let wireResourceId = args.resourceId;
  if (args.resourceId !== undefined) {
    const rememberedWireId = resolveRememberedResourceId(toolRun, args.connector, args.resourceId);
    const refusal =
      rememberedWireId !== undefined ? mcpOutboundStoppedRefusal() : mcpOutboundRefusal(args.resourceId);
    if (refusal) {
      return {
        ok: false,
        reason: "outbound_blocked",
        connector: args.connector,
        message: refusal.message,
      };
    }
    if (rememberedWireId !== undefined) {
      wireResourceId = rememberedWireId;
    }
  }

  const effectiveLimit = delegated
    ? Math.min(connection.policy.maxCallsPerTurn, MCP_LIMITS.subagentMaxCallsPerTurn)
    : connection.policy.maxCallsPerTurn;
  if (!trackConnectorCall(toolRun, args.connector, effectiveLimit)) {
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
  if (wireResourceId !== undefined) {
    rpcArgs.id = wireResourceId;
    rpcArgs.resourceId = wireResourceId;
  }
  if (args.limit !== undefined) {
    rpcArgs.limit = args.limit;
  }

  try {
    const client = new McpHttpClient(args.connector, connection.endpointUrl, connection.token, fetchImpl);
    const result = await client.callReadOnlyTool(args.action, rpcArgs);
    const credentialRedacted = redactCredentials(result.content);
    const prepared =
      args.connector === "notion"
        ? canonicalizeNotionIds(credentialRedacted)
        : { text: credentialRedacted, aliases: [] as Array<readonly [string, string]> };
    const redactedContent = redactSecrets(prepared.text);
    rememberConnectorResourceIds(toolRun, args.connector, credentialRedacted, redactedContent, prepared.aliases);
    return {
      ok: true,
      connector: args.connector,
      label: spec.label,
      action: args.action,
      boundary: "read_only_sandbox",
      callerRole: delegated ? "delegated_subagent" : "primary_agent",
      content: redactedContent,
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
