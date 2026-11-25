import { fetch as undiciFetch } from "undici";
import {
  ApiError,
  MCP_CONNECTOR_SPECS,
  MCP_LIMITS,
  assertMcpEndpointSafe,
  filterSafeMcpTools,
  gatewayUrlOverrideAllowed,
  isAllowedMcpAction,
  isLoopbackHost,
  isServerMode,
  pinnedAgent,
  redactMcpToken,
  resolvePublicAddresses,
  type McpConnectorId,
} from "@agentforge/core";
import { log } from "../log";

type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code?: number; message?: string };
};

export type McpCallResult = {
  readonly content: string;
  readonly raw: unknown;
};

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new ApiError("mcp_response_too_large", "MCP server response exceeded the 1 MB safety limit.", 502);
    }
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ApiError("mcp_response_too_large", "MCP server response exceeded the 1 MB safety limit.", 502);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

function extractMcpText(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  if (result && typeof result === "object") {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const parts = content
        .map((item) => {
          if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
            return (item as { text: string }).text;
          }
          return JSON.stringify(item);
        })
        .filter(Boolean);
      if (parts.length > 0) {
        return parts.join("\n");
      }
    }
  }
  return JSON.stringify(result);
}

export class McpHttpClient {
  private readonly endpoint: URL;
  private readonly token: string;
  private readonly connectorId: McpConnectorId;
  private readonly fetchImpl: typeof fetch;
  private nextId = 1;

  constructor(connectorId: McpConnectorId, endpointUrl: string, token: string, fetchImpl: typeof fetch = fetch) {
    this.connectorId = connectorId;
    this.endpoint = assertMcpEndpointSafe(endpointUrl);
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const spec = MCP_CONNECTOR_SPECS[this.connectorId];
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: this.nextId++,
      method,
      params,
    });
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${this.token}`,
      ...(spec.extraHeaders ?? {}),
    };
    const allowLoopbackDev =
      gatewayUrlOverrideAllowed() && !isServerMode() && isLoopbackHost(this.endpoint.hostname);
    let response: Response;
    let dispatcher: ReturnType<typeof pinnedAgent> | undefined;
    try {
      if (this.fetchImpl === fetch && !allowLoopbackDev) {
        // Resolve DNS and pin the verified public IP on an undici Agent to prevent DNS rebinding / SSRF.
        const addresses = await resolvePublicAddresses(this.endpoint.hostname);
        if (addresses.length > 0) {
          dispatcher = pinnedAgent(this.endpoint.hostname, addresses);
        }
        response = (await undiciFetch(this.endpoint.toString(), {
          method: "POST",
          headers,
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(MCP_LIMITS.timeoutMs),
          ...(dispatcher ? { dispatcher } : {}),
        })) as unknown as Response;
      } else {
        response = await this.fetchImpl(this.endpoint.toString(), {
          method: "POST",
          headers,
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(MCP_LIMITS.timeoutMs),
        });
      }
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      const detail = redactMcpToken(error instanceof Error ? error.message : "MCP transport failed", this.token);
      log.warn("mcp_call_failed", { connector: this.connectorId, method, detail });
      throw new ApiError("mcp_unreachable", `Could not reach ${spec.label} MCP server: ${detail}`, 502);
    } finally {
      if (dispatcher) {
        await dispatcher.close().catch(() => undefined);
      }
    }

    if (response.status >= 300 && response.status < 400) {
      throw new ApiError("mcp_redirect_blocked", `${spec.label} MCP endpoint attempted a redirect, which is blocked.`, 502);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ApiError("mcp_forbidden", `${spec.label} MCP server rejected the credentials (HTTP ${response.status}).`, 403);
    }
    if (!response.ok) {
      throw new ApiError("mcp_upstream_error", `${spec.label} MCP server answered HTTP ${response.status}.`, 502);
    }

    const text = await readBoundedText(response, MCP_LIMITS.maxResponseBytes);
    let parsed: JsonRpcSuccess;
    try {
      parsed = JSON.parse(text) as JsonRpcSuccess;
    } catch {
      throw new ApiError("mcp_invalid_json", `${spec.label} MCP server returned invalid JSON.`, 502);
    }
    if (parsed.error) {
      const detail = redactMcpToken(parsed.error.message ?? "MCP error", this.token);
      throw new ApiError("mcp_rpc_error", `${spec.label} MCP error: ${detail}`, 502);
    }
    return parsed.result;
  }

  async initialize(): Promise<void> {
    await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "nultron", version: "1.0.0" },
    });
  }

  /** Lists tools exposed by the server and filters strictly to the connector's read-only allowlist. */
  async listSafeTools(): Promise<string[]> {
    const result = await this.rpc("tools/list", {});
    const rawTools =
      result && typeof result === "object" && Array.isArray((result as { tools?: unknown }).tools)
        ? ((result as { tools: Array<{ name?: unknown }> }).tools
            .map((tool) => (typeof tool?.name === "string" ? tool.name : ""))
            .filter(Boolean))
        : [];
    return filterSafeMcpTools(this.connectorId, rawTools);
  }

  /** Executes a single allowlisted read-only MCP tool call. */
  async callReadOnlyTool(action: string, args: Record<string, unknown>): Promise<McpCallResult> {
    if (!isAllowedMcpAction(this.connectorId, action)) {
      throw new ApiError(
        "mcp_boundary_violation",
        `Action "${action}" is blocked by Nultron's read-only MCP sandbox for ${MCP_CONNECTOR_SPECS[this.connectorId].label}.`,
        403,
      );
    }
    const result = await this.rpc("tools/call", { name: action, arguments: args });
    const rawText = redactMcpToken(extractMcpText(result), this.token);
    const clipped =
      rawText.length > MCP_LIMITS.maxResultChars
        ? `${rawText.slice(0, MCP_LIMITS.maxResultChars - 1).trimEnd()}…`
        : rawText;
    return { content: clipped, raw: result };
  }
}
