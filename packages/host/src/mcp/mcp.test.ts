import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@agentforge/core";
import type { HostRequest, HostResult } from "../types";
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
  // The handler tests resolve a tenant through the real local database, and Windows will not
  // unlink a sqlite file a process still holds — close it before the sweep.
  try {
    const { sql } = await import("@agentforge/db");
    sql.close();
  } catch {
    // The database was never opened in this process, or was already closed.
  }
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

  it("completes the Streamable HTTP handshake before any other method, against a strict stateful server", async () => {
    const { McpHttpClient } = await import("./client");

    // The fixture is strict on purpose: a bare tools/list with no session is refused, so the
    // handshake below is what the passing call actually proves.
    const bare = await fetch(`${server.baseUrl}/notion`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }),
    });
    expect(bare.status).toBe(400);

    // No explicit initialize(): the client must run the handshake on its own first.
    const client = new McpHttpClient("notion", `${server.baseUrl}/notion`, server.token);
    const safeTools = await client.listSafeTools();
    expect(safeTools).toContain("get_page");

    const notionCalls = server.calls.filter((call) => call.path === "/notion");
    const lastThree = notionCalls.slice(-3);
    expect(lastThree.map((call) => call.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    // The initialize POST cannot carry a session yet; everything after it carries the issued one.
    expect(lastThree[0]?.sessionId).toBeUndefined();
    expect(lastThree[1]?.sessionId).toMatch(/^fixture-session-/);
    expect(lastThree[2]?.sessionId).toBe(lastThree[1]?.sessionId);
  });

  it("returns ok:false with fetch_failed when the MCP tool itself reports isError", async () => {
    const { mcpStore } = await import("./store");
    const { runMcpFetch } = await import("./mcp-tools");
    mcpStore().saveConnection(tenant, {
      id: "notion",
      endpointUrl: `${server.baseUrl}/notion`,
      token: server.token,
      policy: { accessMode: "read_only", allowSubagents: true, maxCallsPerTurn: 6 },
    });
    const result = await runMcpFetch({ connector: "notion", action: "get_page", query: "__trigger_tool_error__" }, tenant);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("fetch_failed");
      expect(result.message).toContain("fixture tool failure");
    }
  });

  it("bounds an oversized MCP response instead of hanging on it", async () => {
    const { mcpStore } = await import("./store");
    const { runMcpFetch } = await import("./mcp-tools");
    mcpStore().saveConnection(tenant, {
      id: "notion",
      endpointUrl: `${server.baseUrl}/notion`,
      token: server.token,
      policy: { accessMode: "read_only", allowSubagents: true, maxCallsPerTurn: 6 },
    });
    const result = await runMcpFetch({ connector: "notion", action: "get_page", query: "__large_response__" }, tenant);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("fetch_failed");
      expect(result.message).toContain("1 MB");
    }
  });

  it("refuses to carry private desk text into an MCP query or resource id in a tainted run", async () => {
    const { createOutboundGuard, runInToolCall, runOutboundGuarded } = await import("@agentforge/core");
    const { mcpStore } = await import("./store");
    const { runMcpFetch } = await import("./mcp-tools");

    mcpStore().saveConnection(tenant, {
      id: "notion",
      endpointUrl: `${server.baseUrl}/notion`,
      token: server.token,
      policy: { accessMode: "read_only", allowSubagents: true, maxCallsPerTurn: 6 },
    });

    const guard = createOutboundGuard({
      userText: ["what did the vendor say about renewal?"],
      privateText: ["The halimun renewal invoice total is 8,243,117 rupiah due Friday"],
      locale: "en",
    });

    await runOutboundGuarded(guard, async () => {
      // Control: a general query carries nothing private and reaches the server.
      const beforeClean = server.calls.length;
      const clean = await runMcpFetch({ connector: "notion", action: "search", query: "quarterly planning milestones" }, tenant);
      expect(clean.ok).toBe(true);
      expect(server.calls.length).toBeGreaterThan(beforeClean);

      // The figure is lifted straight out of the private text: refused before any network use.
      const beforeBlocked = server.calls.length;
      const leakyQuery = await runMcpFetch(
        { connector: "notion", action: "search", query: "invoice total is 8,243,117 rupiah" },
        tenant,
      );
      expect(leakyQuery.ok).toBe(false);
      if (!leakyQuery.ok) {
        expect(leakyQuery.reason).toBe("outbound_blocked");
      }
      const leakyId = await runMcpFetch(
        { connector: "notion", action: "get_page", resourceId: "page-8243117" },
        tenant,
      );
      expect(leakyId.ok).toBe(false);
      if (!leakyId.ok) {
        expect(leakyId.reason).toBe("outbound_blocked");
      }
      expect(server.calls.length).toBe(beforeBlocked);
    });

    // Fail closed per the outbound-guard contract: a model's tool call with no guard open at all
    // is refused rather than sent.
    const beforeUnguarded = server.calls.length;
    await runInToolCall(async () => {
      const unguarded = await runMcpFetch({ connector: "notion", action: "search", query: "ordinary market terms" }, tenant);
      expect(unguarded.ok).toBe(false);
      if (!unguarded.ok) {
        expect(unguarded.reason).toBe("outbound_blocked");
      }
    });
    expect(server.calls.length).toBe(beforeUnguarded);
  });
});

describe("MCP connector handlers (endpoint token rule and test write-back)", () => {
  function request(method: string, path: string, params: Record<string, string>, body?: unknown): HostRequest {
    return { method, path, query: {}, params, headers: {}, body };
  }

  function json(result: HostResult): { status: number; body: Record<string, unknown> } {
    if (result.type !== "json") {
      throw new Error(`expected a json result, got ${result.type}`);
    }
    return { status: result.status, body: result.body as Record<string, unknown> };
  }

  function errorCode(result: HostResult): string | undefined {
    const payload = json(result).body.error as { code?: string } | string | undefined;
    return typeof payload === "string" ? payload : payload?.code;
  }

  /** The tenant the handlers resolve for a desk-mode request, so seeds and assertions line up. */
  async function handlerTenant(): Promise<TenantContext> {
    const { getTenant } = await import("../tenant");
    return getTenant();
  }

  it("refuses an endpoint change without a fresh token before any outbound call, and keeps the old endpoint", async () => {
    const { handlePostMcpConnector } = await import("../handlers/mcp");
    const { mcpStore } = await import("./store");
    const tenant = await handlerTenant();
    const originalUrl = `${server.baseUrl}/gmail`;
    mcpStore().saveConnection(tenant, {
      id: "gmail",
      endpointUrl: originalUrl,
      token: server.token,
      policy: { accessMode: "read_only", allowSubagents: true, maxCallsPerTurn: 4 },
    });

    const spyFetch = vi.fn();
    const moved = await handlePostMcpConnector(
      request("POST", "/api/v1/mcp/connectors/gmail", { connectorId: "gmail" }, { endpointUrl: `${server.baseUrl}/google-drive` }),
      spyFetch as unknown as typeof fetch,
    );
    expect(json(moved).status).toBe(400);
    expect(errorCode(moved)).toBe("invalid_request");
    expect(((json(moved).body.error as { message?: string })?.message) ?? "").toContain("access token");
    // Not one outbound request was made with the previously saved token — verify included.
    expect(spyFetch).not.toHaveBeenCalled();
    // And nothing was saved: the connector still points where it always did.
    expect(mcpStore().getConnection(tenant, "gmail")?.endpointUrl).toBe(originalUrl);

    // Control: the same change with a fresh token alongside it is accepted and verified.
    const accepted = await handlePostMcpConnector(
      request("POST", "/api/v1/mcp/connectors/gmail", { connectorId: "gmail" }, {
        endpointUrl: `${server.baseUrl}/google-drive`,
        token: server.token,
      }),
    );
    expect(json(accepted).status).toBe(200);
    expect(mcpStore().getConnection(tenant, "gmail")?.endpointUrl).toBe(`${server.baseUrl}/google-drive`);
  });

  it("does not overwrite an owner who disables access while a connector test is in flight", async () => {
    const { handlePostMcpConnectorTest } = await import("../handlers/mcp");
    const { mcpStore } = await import("./store");
    const { runMcpFetch } = await import("./mcp-tools");
    const tenant = await handlerTenant();
    const endpointUrl = `${server.baseUrl}/notion`;
    mcpStore().saveConnection(tenant, {
      id: "notion",
      endpointUrl,
      token: server.token,
      policy: { accessMode: "read_only", allowSubagents: true, maxCallsPerTurn: 4 },
    });

    // A fetch that parks inside the first outbound call until the test lets it through, so the
    // policy flip lands exactly in the window the race needs.
    let releaseFetch!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let startedSignalled = false;
    const gatedFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (!startedSignalled) {
        startedSignalled = true;
        markStarted();
      }
      await gate;
      return fetch(input, init);
    }) as typeof fetch;

    const pending = handlePostMcpConnectorTest(
      request("POST", "/api/v1/mcp/connectors/notion/test", { connectorId: "notion" }, {}),
      gatedFetch,
    );
    await started;
    // The owner disables the connector while its test is still in flight.
    mcpStore().saveConnection(tenant, {
      id: "notion",
      endpointUrl,
      policy: { accessMode: "disabled" },
    });
    releaseFetch();
    const result = await pending;

    // The test itself succeeded — the server was reached and tools were discovered...
    expect(json(result).status).toBe(200);
    expect(json(result).body.ok).toBe(true);
    // ...but the owner's disable survived it: only discoveredTools was written back.
    const after = mcpStore().getConnection(tenant, "notion");
    expect(after?.policy.accessMode).toBe("disabled");
    expect(after?.discoveredTools.length).toBeGreaterThan(0);
    // The behavioral end of it: the connector stays refused, not silently re-enabled.
    const blocked = await runMcpFetch({ connector: "notion", action: "get_page" }, tenant);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.reason).toBe("disabled");
    }

    // Restore read-only for any later use of this tenant.
    mcpStore().saveConnection(tenant, {
      id: "notion",
      endpointUrl,
      policy: { accessMode: "read_only", allowSubagents: true, maxCallsPerTurn: 4 },
    });
  });

  it("never writes a finished test's tools onto a repointed or disconnected connector", async () => {
    const { mcpStore } = await import("./store");
    const tenant = await handlerTenant();
    const endpointA = `${server.baseUrl}/notion`;
    const endpointB = `${server.baseUrl}/google-drive`;
    mcpStore().saveConnection(tenant, {
      id: "notion",
      endpointUrl: endpointA,
      token: server.token,
      policy: { accessMode: "read_only", allowSubagents: true, maxCallsPerTurn: 4 },
      discoveredTools: [],
    });

    // Repointed mid-test: the tools discovered against endpoint A do not belong to endpoint B.
    mcpStore().saveConnection(tenant, { id: "notion", endpointUrl: endpointB, token: server.token });
    mcpStore().updateDiscoveredTools(tenant, "notion", ["injected_tool"], endpointA);
    expect(mcpStore().getConnection(tenant, "notion")?.discoveredTools ?? []).toEqual([]);

    // The same write against the endpoint it actually ran on is the one that lands.
    mcpStore().updateDiscoveredTools(tenant, "notion", ["search", "get_page"], endpointB);
    expect(mcpStore().getConnection(tenant, "notion")?.discoveredTools).toEqual(["search", "get_page"]);

    // Disconnected mid-test: the write must not resurrect the record.
    mcpStore().disconnect(tenant, "notion");
    mcpStore().updateDiscoveredTools(tenant, "notion", ["injected_tool"], endpointB);
    expect(mcpStore().getConnection(tenant, "notion")).toBeNull();
    expect(mcpStore().listViews(tenant).find((view) => view.id === "notion")?.connected).toBe(false);
  });

  it("allows compact 32-hex Notion page IDs returned by a search in the same run back to Notion read", async () => {
    const { createOutboundGuard, runInToolCall, runOutboundGuarded } = await import("@agentforge/core");
    const { withToolRun } = await import("../tool-run-context");
    const { mcpStore } = await import("./store");
    const { runMcpFetch } = await import("./mcp-tools");

    mcpStore().saveConnection(tenant, {
      id: "notion",
      endpointUrl: `${server.baseUrl}/notion`,
      token: server.token,
      policy: { accessMode: "read_only", allowSubagents: true, maxCallsPerTurn: 4 },
    });

    const guard = createOutboundGuard({
      userText: ["Find the roadmap page in Notion and summarize it"],
      privateText: [],
      locale: "en",
    });

    await withToolRun({ runId: "run_notion_hex_id", mode: "chat" }, () =>
      runOutboundGuarded(guard, () =>
        runInToolCall(async () => {
          const found = await runMcpFetch({ connector: "notion", action: "search", query: "roadmap" }, tenant);
          expect(found.ok).toBe(true);
          if (found.ok) {
            expect(found.content).toContain("c77d2a3d-e936-47de-8d7c-a0d97a52a1ba");
          }
          const page = await runMcpFetch(
            { connector: "notion", action: "get_page", resourceId: "c77d2a3d-e936-47de-8d7c-a0d97a52a1ba" },
            tenant,
          );
          expect(page.ok).toBe(true);
          if (page.ok) {
            expect(page.content).toContain("Roadmap priorities");
          }
          // Passing the displayed hyphenated ID translates back to the exact wire ID the endpoint returned.
          const lastGetPage = [...server.calls]
            .reverse()
            .find((call) => call.path === "/notion" && call.tool === "get_page");
          expect((lastGetPage?.args as { resourceId?: string } | undefined)?.resourceId).toBe(
            "c77d2a3de93647de8d7ca0d97a52a1ba",
          );
          // An arbitrary 32-hex blob never returned by Notion is still refused.
          const arbitrary = await runMcpFetch(
            { connector: "notion", action: "get_page", resourceId: "deadbeefdeadbeefdeadbeefdeadbeef" },
            tenant,
          );
          expect(arbitrary.ok).toBe(false);
          if (!arbitrary.ok) {
            expect(arbitrary.reason).toBe("outbound_blocked");
          }
        }),
      ),
    );
  });

  it("preserves exact hyphenated Notion page IDs when a result also includes a compact URL suffix", async () => {
    const { createOutboundGuard, runInToolCall, runOutboundGuarded } = await import("@agentforge/core");
    const { withToolRun } = await import("../tool-run-context");
    const { mcpStore } = await import("./store");
    const { runMcpFetch } = await import("./mcp-tools");

    mcpStore().saveConnection(tenant, {
      id: "notion",
      endpointUrl: `${server.baseUrl}/notion`,
      token: server.token,
      policy: { accessMode: "read_only", allowSubagents: true, maxCallsPerTurn: 4 },
    });

    const guard = createOutboundGuard({
      userText: ["Open the mixed format Notion page"],
      privateText: [],
      locale: "en",
    });

    const hyphenatedId = "b11a2b3c-d4e5-4f6a-8b9c-0d1e2f3a4b5c";
    const redactedCompactId = "e44e5f6a7b8c4d0e9f2a3b4c5d6e7f8a";

    await withToolRun({ runId: "run_notion_mixed_id", mode: "chat" }, () =>
      runOutboundGuarded(guard, () =>
        runInToolCall(async () => {
          const found = await runMcpFetch({ connector: "notion", action: "search", query: "__mixed_notion_id__" }, tenant);
          expect(found.ok).toBe(true);
          if (found.ok) {
            expect(found.content).toContain(hyphenatedId);
            expect(found.content).not.toContain("e44e5f6a-7b8c-4d0e-9f2a-3b4c5d6e7f8a");
            // 32-hex secrets and hashes in Notion content must NOT be turned into whitelisted UUIDs.
            expect(found.content).toContain("api_secret = [REDACTED]");
            expect(found.content).toContain("webhook_secret: [REDACTED]");
            expect(found.content).toContain("checksum: [REDACTED]");
            expect(found.content).not.toContain("0f3ab19c");
            expect(found.content).not.toContain("9a8b7c6d");
            expect(found.content).not.toContain("d41d8cd9");
          }

          const page = await runMcpFetch(
            { connector: "notion", action: "get_page", resourceId: hyphenatedId },
            tenant,
          );
          expect(page.ok).toBe(true);

          // Follow-up read must send the exact visible hyphenated wire ID, not the URL's compact suffix.
          const lastGetPage = [...server.calls]
            .reverse()
            .find((call) => call.path === "/notion" && call.tool === "get_page");
          expect((lastGetPage?.args as { id?: string; resourceId?: string } | undefined)).toMatchObject({
            id: hyphenatedId,
            resourceId: hyphenatedId,
          });

          // Compact IDs from URLs that were redacted out must not be registered as remembered IDs.
          const redactedRetry = await runMcpFetch(
            { connector: "notion", action: "get_page", resourceId: redactedCompactId },
            tenant,
          );
          expect(redactedRetry.ok).toBe(false);
          if (!redactedRetry.ok) {
            expect(redactedRetry.reason).toBe("outbound_blocked");
          }
        }),
      ),
    );
  });

  it("canonicalizes Markdown-formatted Notion page IDs while redacting Markdown-formatted secrets", async () => {
    const { createOutboundGuard, runInToolCall, runOutboundGuarded } = await import("@agentforge/core");
    const { withToolRun } = await import("../tool-run-context");
    const { mcpStore } = await import("./store");
    const { runMcpFetch } = await import("./mcp-tools");

    mcpStore().saveConnection(tenant, {
      id: "notion",
      endpointUrl: `${server.baseUrl}/notion`,
      token: server.token,
      policy: { accessMode: "read_only", allowSubagents: true, maxCallsPerTurn: 4 },
    });

    const guard = createOutboundGuard({
      userText: ["Open the Markdown Notion search result"],
      privateText: [],
      locale: "en",
    });

    const compactId = "c77d2a3de93647de8d7ca0d97a52a1ba";
    const hyphenatedId = "c77d2a3d-e936-47de-8d7c-a0d97a52a1ba";

    await withToolRun({ runId: "run_notion_markdown_id", mode: "chat" }, () =>
      runOutboundGuarded(guard, () =>
        runInToolCall(async () => {
          const found = await runMcpFetch({ connector: "notion", action: "search", query: "__markdown_notion_id__" }, tenant);
          expect(found.ok).toBe(true);
          if (found.ok) {
            expect(found.content).toContain(`\`${hyphenatedId}\``);
            expect(found.content).toContain("**api_secret:** `[REDACTED]`");
            expect(found.content).not.toContain("0f3ab19c");
          }

          const page = await runMcpFetch({ connector: "notion", action: "get_page", resourceId: hyphenatedId }, tenant);
          expect(page.ok).toBe(true);
          const lastGetPage = [...server.calls]
            .reverse()
            .find((call) => call.path === "/notion" && call.tool === "get_page");
          expect(lastGetPage?.args).toMatchObject({ id: compactId, resourceId: compactId });
        }),
      ),
    );
  });

  it("resolves visible compact Notion aliases even when a redacted URL query carried the hyphenated form", async () => {
    const { createOutboundGuard, runInToolCall, runOutboundGuarded } = await import("@agentforge/core");
    const { withToolRun } = await import("../tool-run-context");
    const { mcpStore } = await import("./store");
    const { runMcpFetch } = await import("./mcp-tools");

    mcpStore().saveConnection(tenant, {
      id: "notion",
      endpointUrl: `${server.baseUrl}/notion`,
      token: server.token,
      policy: { accessMode: "read_only", allowSubagents: true, maxCallsPerTurn: 4 },
    });

    const guard = createOutboundGuard({
      userText: ["Open the Notion result with a redacted link parameter"],
      privateText: [],
      locale: "en",
    });

    const compactId = "c77d2a3de93647de8d7ca0d97a52a1ba";
    const hyphenatedId = "c77d2a3d-e936-47de-8d7c-a0d97a52a1ba";

    await withToolRun({ runId: "run_notion_redacted_url_id", mode: "chat" }, () =>
      runOutboundGuarded(guard, () =>
        runInToolCall(async () => {
          const found = await runMcpFetch(
            { connector: "notion", action: "search", query: "__redacted_url_notion_id__" },
            tenant,
          );
          expect(found.ok).toBe(true);
          if (found.ok) {
            expect(found.content).toContain(`Page ID: ${hyphenatedId}`);
            expect(found.content).toContain("?p=[REDACTED]");
          }

          const page = await runMcpFetch({ connector: "notion", action: "get_page", resourceId: hyphenatedId }, tenant);
          expect(page.ok).toBe(true);
          const lastGetPage = [...server.calls]
            .reverse()
            .find((call) => call.path === "/notion" && call.tool === "get_page");
          expect(lastGetPage?.args).toMatchObject({ id: compactId, resourceId: compactId });
        }),
      ),
    );
  });
});
