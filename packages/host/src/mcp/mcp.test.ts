import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "@agentforge/core";
import { startMcpFixtureServer, type McpFixtureServer } from "./__fixtures__/mcp-server";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-mcp-test-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_SECRETS_KEY = "c".repeat(64);
delete process.env.AGENTFORGE_SERVER;

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org-mcp",
  workspaceId: "ws-mcp",
  userId: "user-mcp",
  role: "owner",
};

const otherDeskTenant: TenantContext = {
  ...tenant,
  workspaceId: "ws-other",
};

let server: McpFixtureServer;

beforeAll(async () => {
  server = await startMcpFixtureServer();
});

afterAll(async () => {
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("MCP connectors (Gmail, Google Drive, OneDrive, Notion) and sandbox boundaries", () => {
  it("connects all 4 connectors, strips dangerous write/delete/harness tools, and fetches read-only data", async () => {
    const { mcpStore } = await import("./store");
    const { McpHttpClient } = await import("./client");
    const { runMcpFetch, runMcpListSources } = await import("./mcp-tools");

    const endpoints: Array<{ id: "gmail" | "google_drive" | "onedrive" | "notion"; path: string; action: string; needle: string }> = [
      { id: "gmail", path: "/gmail", action: "search_messages", needle: "PT Kopi Nusantara" },
      { id: "google_drive", path: "/google-drive", action: "read_file", needle: "Revenue Q3: $180,000" },
      { id: "onedrive", path: "/onedrive", action: "read_file", needle: "99.9%" },
      { id: "notion", path: "/notion", action: "get_page", needle: "MCP Sandbox Connectors" },
    ];

    for (const entry of endpoints) {
      const client = new McpHttpClient(entry.id, `${server.baseUrl}${entry.path}`, server.token);
      await client.initialize();
      const safeTools = await client.listSafeTools();
      // Dangerous write/delete/harness tools advertised by server must be filtered out.
      expect(safeTools).not.toContain("send_email");
      expect(safeTools).not.toContain("delete_message");
      expect(safeTools).not.toContain("edit_harness");
      expect(safeTools).not.toContain("delete_file");
      expect(safeTools).not.toContain("upload_file");
      expect(safeTools).not.toContain("update_page");

      const view = mcpStore().saveConnection(tenant, {
        id: entry.id,
        endpointUrl: `${server.baseUrl}${entry.path}`,
        token: server.token,
        policy: { accessMode: "read_only", allowSubagents: entry.id !== "gmail", maxCallsPerTurn: 4 },
        discoveredTools: safeTools,
      });
      expect(view.connected).toBe(true);
      expect(view.fingerprint).toMatch(/^sha256:/);
      // Token must never appear in the view.
      expect(JSON.stringify(view)).not.toContain(server.token);

      const res = await runMcpFetch({ connector: entry.id, action: entry.action, query: "test" }, tenant);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.content).toContain(entry.needle);
        expect(res.boundary).toBe("read_only_sandbox");
      }
    }

    const listed = await runMcpListSources(tenant);
    expect(listed.sources).toHaveLength(4);
    expect(listed.sandbox.readOnlyEnforced).toBe(true);
    expect(listed.sandbox.harnessMutationBlocked).toBe(true);

    // Another desk cannot see or fetch from tenant's connected sources.
    expect((await runMcpListSources(otherDeskTenant)).sources).toHaveLength(0);
    const crossDesk = await runMcpFetch({ connector: "notion", action: "get_page" }, otherDeskTenant);
    expect(crossDesk.ok).toBe(false);
    if (!crossDesk.ok) {
      expect(crossDesk.reason).toBe("not_connected");
    }
  });

  it("blocks write, delete, and harness mutation actions even if requested directly", async () => {
    const { runMcpFetch } = await import("./mcp-tools");
    const callsBefore = server.calls.length;

    for (const attempt of [
      { connector: "gmail" as const, action: "send_email" },
      { connector: "gmail" as const, action: "edit_harness" },
      { connector: "google_drive" as const, action: "delete_file" },
      { connector: "onedrive" as const, action: "upload_file" },
      { connector: "notion" as const, action: "update_page" },
    ]) {
      const result = await runMcpFetch(attempt, tenant);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("boundary_blocked");
      }
    }
    // Zero network requests were even sent to the MCP server for blocked actions.
    expect(server.calls.length).toBe(callsBefore);
  });

  it("enforces subagent delegation boundary rules per connector", async () => {
    const { withDelegation } = await import("../delegation/delegation-context");
    const { runMcpFetch, runMcpListSources } = await import("./mcp-tools");

    await withDelegation(
      { agent: "research", fromThreadId: "t_parent", threadId: "t_child" },
      async () => {
        // Subagent sees Notion/Drive/OneDrive (allowSubagents=true), NOT Gmail (allowSubagents=false).
        const listed = await runMcpListSources(tenant);
        expect(listed.callerRole).toBe("delegated_subagent");
        expect(listed.sources.map((s) => s.id).sort()).toEqual(["google_drive", "notion", "onedrive"]);

        const blocked = await runMcpFetch({ connector: "gmail", action: "search_messages" }, tenant);
        expect(blocked.ok).toBe(false);
        if (!blocked.ok) {
          expect(blocked.reason).toBe("subagent_blocked");
        }

        const allowed = await runMcpFetch({ connector: "notion", action: "get_page" }, tenant);
        expect(allowed.ok).toBe(true);
        if (allowed.ok) {
          expect(allowed.callerRole).toBe("delegated_subagent");
          expect(allowed.content).toContain("Roadmap priorities");
        }
      },
    );
  });

  it("enforces per-turn maxCallsPerTurn limit per connector", async () => {
    const { withToolRun } = await import("../tool-run-context");
    const { mcpStore } = await import("./store");
    const { runMcpFetch } = await import("./mcp-tools");

    mcpStore().saveConnection(tenant, {
      id: "notion",
      endpointUrl: `${server.baseUrl}/notion`,
      policy: { accessMode: "read_only", allowSubagents: true, maxCallsPerTurn: 2 },
    });

    await withToolRun({ runId: "run_mcp_cap_test", mode: "chat" }, async () => {
      const r1 = await runMcpFetch({ connector: "notion", action: "get_page" }, tenant);
      const r2 = await runMcpFetch({ connector: "notion", action: "get_page" }, tenant);
      const r3 = await runMcpFetch({ connector: "notion", action: "get_page" }, tenant);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(r3.ok).toBe(false);
      if (!r3.ok) {
        expect(r3.reason).toBe("turn_limit_reached");
      }
    });
  });
});
