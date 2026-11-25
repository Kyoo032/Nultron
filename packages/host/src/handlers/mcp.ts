import {
  ApiError,
  MCP_BOUNDARY_RULES,
  assertMcpEndpointSafe,
  assertMcpTokenShape,
  canAdminister,
  isMcpConnectorId,
  isServerMode,
  normalizeMcpPolicy,
  type McpConnectorId,
  type McpConnectorPolicy,
} from "@agentforge/core";
import { jsonError, jsonOk } from "../errors";
import { McpHttpClient } from "../mcp/client";
import { mcpStore } from "../mcp/store";
import { getTenant } from "../tenant";
import type { HostRequest, HostResult } from "../types";

function parseConnectorId(raw: string | undefined): McpConnectorId {
  if (!isMcpConnectorId(raw)) {
    throw new ApiError("invalid_request", "Unknown MCP connector. Expected gmail, google_drive, onedrive, or notion.", 400);
  }
  return raw;
}

function assertMayManageMcp(role: string): void {
  if (isServerMode() && !canAdminister(role as "owner" | "admin" | "member")) {
    throw new ApiError("forbidden", "Only an owner or admin can manage MCP connectors.", 403);
  }
}

export async function handleGetMcpConnectors(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    const hideUrls = isServerMode() && !canAdminister(tenant.role);
    const connectors = mcpStore()
      .listViews(tenant)
      .map((view) => (hideUrls ? { ...view, endpointUrl: null } : view));
    return jsonOk({
      connectors,
      boundaries: MCP_BOUNDARY_RULES,
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function handlePostMcpConnector(
  request: HostRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    assertMayManageMcp(tenant.role);
    const connectorId = parseConnectorId(request.params.connectorId);
    const body = (request.body ?? {}) as {
      endpointUrl?: unknown;
      token?: unknown;
      policy?: Partial<McpConnectorPolicy>;
      verify?: unknown;
    };

    const existing = mcpStore().getConnection(tenant, connectorId);
    const rawEndpoint =
      typeof body.endpointUrl === "string" && body.endpointUrl.trim().length > 0
        ? body.endpointUrl.trim()
        : existing?.endpointUrl;
    if (!rawEndpoint) {
      throw new ApiError("invalid_request", "endpointUrl is required.", 400);
    }
    const validatedUrl = assertMcpEndpointSafe(rawEndpoint).toString();

    let tokenToSave: string | undefined;
    let activeToken: string | undefined = existing?.token;
    if (typeof body.token === "string" && body.token.trim().length > 0) {
      tokenToSave = assertMcpTokenShape(body.token);
      activeToken = tokenToSave;
    }
    if (!activeToken) {
      throw new ApiError("invalid_request", "Access token is required to connect this MCP source.", 400);
    }

    const policy = normalizeMcpPolicy(body.policy ?? existing?.policy);
    let discoveredTools: string[] | undefined;

    if (body.verify !== false) {
      const client = new McpHttpClient(connectorId, validatedUrl, activeToken, fetchImpl);
      await client.initialize();
      discoveredTools = await client.listSafeTools();
    }

    const connector = mcpStore().saveConnection(tenant, {
      id: connectorId,
      endpointUrl: validatedUrl,
      ...(tokenToSave !== undefined ? { token: tokenToSave } : {}),
      policy,
      ...(discoveredTools !== undefined ? { discoveredTools } : {}),
    });
    return jsonOk({ connector, boundaries: MCP_BOUNDARY_RULES });
  } catch (error) {
    return jsonError(error);
  }
}

export async function handleDeleteMcpConnector(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    assertMayManageMcp(tenant.role);
    const connectorId = parseConnectorId(request.params.connectorId);
    const connector = mcpStore().disconnect(tenant, connectorId);
    return jsonOk({ connector, boundaries: MCP_BOUNDARY_RULES });
  } catch (error) {
    return jsonError(error);
  }
}

export async function handlePostMcpConnectorTest(
  request: HostRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    assertMayManageMcp(tenant.role);
    const connectorId = parseConnectorId(request.params.connectorId);
    const connection = mcpStore().getConnection(tenant, connectorId);
    if (!connection) {
      throw new ApiError("not_connected", "Connect this MCP source before testing it.", 400);
    }
    const client = new McpHttpClient(connectorId, connection.endpointUrl, connection.token, fetchImpl);
    await client.initialize();
    const safeTools = await client.listSafeTools();
    const connector = mcpStore().saveConnection(tenant, {
      id: connectorId,
      endpointUrl: connection.endpointUrl,
      policy: connection.policy,
      discoveredTools: safeTools,
    });
    return jsonOk({ ok: true, connector, safeTools, boundaries: MCP_BOUNDARY_RULES });
  } catch (error) {
    return jsonError(error);
  }
}
