import { describe, expect, it } from "vitest";
import {
  assertMcpEndpointSafe,
  assertMcpTokenShape,
  filterSafeMcpTools,
  isAllowedMcpAction,
  isForbiddenMcpAction,
  isMcpConnectorId,
  MCP_BOUNDARY_RULES,
  MCP_CONNECTOR_IDS,
  normalizeMcpPolicy,
  redactMcpToken,
} from "./index";

describe("MCP core domain and sandbox boundaries", () => {
  it("supports Gmail, Google Drive, OneDrive, and Notion connectors", () => {
    expect(MCP_CONNECTOR_IDS).toEqual(["gmail", "google_drive", "onedrive", "notion"]);
    expect(isMcpConnectorId("gmail")).toBe(true);
    expect(isMcpConnectorId("google_drive")).toBe(true);
    expect(isMcpConnectorId("onedrive")).toBe(true);
    expect(isMcpConnectorId("notion")).toBe(true);
    expect(isMcpConnectorId("slack")).toBe(false);
  });

  it("enforces read-only allowlist and permanently refuses write/delete/harness actions", () => {
    expect(MCP_BOUNDARY_RULES.readOnlyEnforced).toBe(true);
    expect(MCP_BOUNDARY_RULES.harnessMutationBlocked).toBe(true);
    expect(MCP_BOUNDARY_RULES.subagentsCannotEscalatePolicy).toBe(true);

    expect(isAllowedMcpAction("gmail", "search_messages")).toBe(true);
    expect(isAllowedMcpAction("google_drive", "read_file")).toBe(true);
    expect(isAllowedMcpAction("onedrive", "list_files")).toBe(true);
    expect(isAllowedMcpAction("notion", "query_database")).toBe(true);

    for (const forbidden of [
      "send_email",
      "delete_message",
      "trash_file",
      "write_file",
      "update_page",
      "create_database",
      "edit_harness",
      "shell_exec",
      "share_file",
      "set_config",
    ]) {
      expect(isForbiddenMcpAction(forbidden), forbidden).toBe(true);
      expect(isAllowedMcpAction("gmail", forbidden), forbidden).toBe(false);
      expect(isAllowedMcpAction("notion", forbidden), forbidden).toBe(false);
    }

    expect(
      filterSafeMcpTools("gmail", ["search_messages", "send_email", "delete_message", "get_message", "edit_harness"]),
    ).toEqual(["search_messages", "get_message"]);
  });

  it("clamps policy safely and never permits write accessMode", () => {
    expect(normalizeMcpPolicy({ accessMode: "write" as never, allowSubagents: false, maxCallsPerTurn: 999 })).toEqual({
      accessMode: "read_only",
      allowSubagents: false,
      maxCallsPerTurn: 10,
    });
    expect(normalizeMcpPolicy({ accessMode: "disabled", maxCallsPerTurn: 0 })).toEqual({
      accessMode: "disabled",
      allowSubagents: true,
      maxCallsPerTurn: 1,
    });
  });

  it("blocks embedded credentials and private hosts in server mode", () => {
    expect(() => assertMcpEndpointSafe("https://user:pass@mcp.notion.com/mcp")).toThrow(/credentials/i);
    expect(() => assertMcpEndpointSafe("ftp://mcp.notion.com/mcp")).toThrow(/HTTPS/i);
    expect(assertMcpEndpointSafe("https://mcp.notion.com/mcp").hostname).toBe("mcp.notion.com");

    const prevServer = process.env.AGENTFORGE_SERVER;
    process.env.AGENTFORGE_SERVER = "1";
    try {
      expect(() => assertMcpEndpointSafe("http://127.0.0.1:9000/mcp")).toThrow(/HTTPS/i);
      expect(() => assertMcpEndpointSafe("https://169.254.169.254/latest")).toThrow(/private|loopback/i);
      expect(() => assertMcpEndpointSafe("https://10.0.0.5/mcp")).toThrow(/private|loopback/i);
    } finally {
      if (prevServer === undefined) {
        delete process.env.AGENTFORGE_SERVER;
      } else {
        process.env.AGENTFORGE_SERVER = prevServer;
      }
    }
  });

  it("validates token shape and redacts tokens from errors", () => {
    expect(() => assertMcpTokenShape("short")).toThrow();
    expect(() => assertMcpTokenShape("valid_token\nnewline")).toThrow();
    const token = "ntn_secret_1234567890";
    expect(assertMcpTokenShape(token)).toBe(token);
    expect(redactMcpToken(`Bearer ${token} failed`, token)).toBe("Bearer <mcp-token> failed");
  });
});
