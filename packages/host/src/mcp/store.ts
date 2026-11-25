import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  DEFAULT_MCP_POLICY,
  MCP_CONNECTOR_IDS,
  MCP_CONNECTOR_SPECS,
  assertMcpEndpointSafe,
  keyFingerprintOrNull,
  normalizeMcpPolicy,
  type McpConnectorId,
  type McpConnectorPolicy,
  type TenantContext,
} from "@agentforge/core";
import { localDataDir } from "@agentforge/db/vault-key";
import { loadSettings, saveSettings } from "../settings-store";
import { tenantScopedRoot } from "../tenant-paths";

export type StoredMcpConnector = {
  readonly id: McpConnectorId;
  readonly endpointUrl: string;
  readonly policy: McpConnectorPolicy;
  readonly connectedAt: number;
  readonly discoveredTools: readonly string[];
};

export type McpConnectorView = {
  readonly id: McpConnectorId;
  readonly label: string;
  readonly connected: boolean;
  readonly endpointUrl: string | null;
  readonly endpointHost: string | null;
  readonly defaultEndpointHint: string;
  readonly fingerprint: string | null;
  readonly policy: McpConnectorPolicy;
  readonly allowedActions: readonly string[];
  readonly discoveredTools: readonly string[];
  readonly connectedAt: number | null;
};

type StoredFile = {
  connectors: Partial<Record<McpConnectorId, StoredMcpConnector>>;
};

const SAFE_ID = /^[A-Za-z0-9_-]{1,120}$/;

function workspaceDir(tenant: TenantContext, workspaceId = tenant.workspaceId): string {
  if (!SAFE_ID.test(workspaceId)) {
    throw new Error("Invalid workspace id");
  }
  return path.join(tenantScopedRoot(path.join(localDataDir(), "mcp"), tenant.tenantId), workspaceId);
}

function configPath(tenant: TenantContext): string {
  return path.join(workspaceDir(tenant), "connectors.json");
}

function readConfig(tenant: TenantContext): StoredFile {
  const file = configPath(tenant);
  if (!existsSync(file)) {
    return { connectors: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as StoredFile;
    return parsed && typeof parsed === "object" && parsed.connectors && typeof parsed.connectors === "object"
      ? parsed
      : { connectors: {} };
  } catch {
    return { connectors: {} };
  }
}

function writeConfig(tenant: TenantContext, data: StoredFile): void {
  const file = configPath(tenant);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

export class McpStore {
  listViews(tenant: TenantContext): McpConnectorView[] {
    const file = readConfig(tenant);
    const settings = loadSettings(tenant);
    const tokens = settings.mcpTokens ?? {};

    return MCP_CONNECTOR_IDS.map((id) => {
      const spec = MCP_CONNECTOR_SPECS[id];
      const stored = file.connectors[id];
      const token = tokens[id];
      const connected = Boolean(stored?.endpointUrl && token);
      let endpointHost: string | null = null;
      if (stored?.endpointUrl) {
        try {
          endpointHost = new URL(stored.endpointUrl).host;
        } catch {
          endpointHost = null;
        }
      }
      return {
        id,
        label: spec.label,
        connected,
        endpointUrl: stored?.endpointUrl ?? null,
        endpointHost,
        defaultEndpointHint: spec.defaultEndpointHint,
        fingerprint: token ? keyFingerprintOrNull(token) : null,
        policy: normalizeMcpPolicy(stored?.policy ?? DEFAULT_MCP_POLICY),
        allowedActions: spec.allowedActions,
        discoveredTools: stored?.discoveredTools ?? [],
        connectedAt: connected ? (stored?.connectedAt ?? null) : null,
      };
    });
  }

  getConnection(
    tenant: TenantContext,
    id: McpConnectorId,
  ): { endpointUrl: string; token: string; policy: McpConnectorPolicy; discoveredTools: readonly string[] } | null {
    const file = readConfig(tenant);
    const stored = file.connectors[id];
    const token = loadSettings(tenant).mcpTokens?.[id];
    if (!stored?.endpointUrl || !token) {
      return null;
    }
    return {
      endpointUrl: stored.endpointUrl,
      token,
      policy: normalizeMcpPolicy(stored.policy),
      discoveredTools: stored.discoveredTools ?? [],
    };
  }

  saveConnection(
    tenant: TenantContext,
    input: {
      id: McpConnectorId;
      endpointUrl: string;
      token?: string;
      policy?: Partial<McpConnectorPolicy>;
      discoveredTools?: readonly string[];
    },
  ): McpConnectorView {
    const validatedUrl = assertMcpEndpointSafe(input.endpointUrl).toString();
    const current = readConfig(tenant);
    const existing = current.connectors[input.id];
    if (input.token !== undefined) {
      saveSettings({ mcpTokens: { [input.id]: input.token } }, tenant);
    }
    const nextRecord: StoredMcpConnector = {
      id: input.id,
      endpointUrl: validatedUrl,
      policy: normalizeMcpPolicy(input.policy ?? existing?.policy),
      connectedAt: existing?.connectedAt ?? Date.now(),
      discoveredTools: input.discoveredTools ?? existing?.discoveredTools ?? [],
    };
    current.connectors[input.id] = nextRecord;
    writeConfig(tenant, current);
    const updated = this.listViews(tenant).find((view) => view.id === input.id);
    if (!updated) {
      throw new Error(`Unknown MCP connector: ${input.id}`);
    }
    return updated;
  }

  disconnect(tenant: TenantContext, id: McpConnectorId): McpConnectorView {
    saveSettings({ mcpTokens: { [id]: "" } }, tenant);
    const current = readConfig(tenant);
    delete current.connectors[id];
    writeConfig(tenant, current);
    const updated = this.listViews(tenant).find((view) => view.id === id);
    if (!updated) {
      throw new Error(`Unknown MCP connector: ${id}`);
    }
    return updated;
  }

  dropWorkspace(tenant: TenantContext, workspaceId: string): void {
    if (!SAFE_ID.test(workspaceId)) {
      return;
    }
    const dir = workspaceDir(tenant, workspaceId);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

const sharedStore = new McpStore();

export function mcpStore(): McpStore {
  return sharedStore;
}
