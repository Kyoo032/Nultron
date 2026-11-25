import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MCP_POLICY,
  MCP_BOUNDARY_RULES,
  MCP_CONNECTOR_SPECS,
  type McpConnectorId,
} from "@agentforge/core/mcp";
import { McpPageView, draftsFromConnectors } from "@/components/mcp-page";
import type { McpConnectorView } from "./mcp-client";
import { applyLocale, resetLocaleForTests } from "./i18n";

function connector(id: McpConnectorId, over: Partial<McpConnectorView> = {}): McpConnectorView {
  const spec = MCP_CONNECTOR_SPECS[id];
  return {
    id,
    label: spec.label,
    connected: false,
    endpointUrl: null,
    endpointHost: null,
    defaultEndpointHint: spec.defaultEndpointHint,
    fingerprint: null,
    policy: { ...DEFAULT_MCP_POLICY },
    allowedActions: [...spec.allowedActions],
    discoveredTools: [],
    connectedAt: null,
    ...over,
  };
}

const CONNECTORS: McpConnectorView[] = [
  connector("gmail", {
    connected: true,
    endpointUrl: "https://mcp.example.com/gmail",
    endpointHost: "mcp.example.com",
    fingerprint: "sha256:gmail-token",
    discoveredTools: ["search_messages", "get_message"],
    connectedAt: Date.UTC(2026, 0, 15, 12, 0, 0),
  }),
  connector("google_drive"),
  connector("onedrive", {
    policy: { accessMode: "disabled", allowSubagents: false, maxCallsPerTurn: 2 },
  }),
  connector("notion"),
];

function markup(): string {
  return renderToStaticMarkup(
    <McpPageView
      state={{ status: "ready", connectors: CONNECTORS, boundaries: MCP_BOUNDARY_RULES }}
      drafts={draftsFromConnectors(CONNECTORS)}
      action={null}
      feedback={null}
      onDraftChange={() => {}}
      onSave={() => {}}
      onTest={() => {}}
      onDisconnect={() => {}}
    />,
  );
}

beforeEach(() => {
  resetLocaleForTests();
  applyLocale("en");
});

describe("McpPageView", () => {
  it("renders the sandbox boundary rules and all four connectors in English", () => {
    const html = markup();
    expect(html).toContain('data-testid="mcp-page"');
    expect(html).toContain('data-testid="mcp-boundaries"');
    expect(html).toContain("Sandbox &amp; Agent Boundaries");
    expect(html).toContain("External writes, sends, deletes, and harness edits are blocked at the host boundary.");
    expect(html).toContain("Agents cannot reach or edit anything outside the desk harness.");
    expect(html).toContain("they cannot widen its policy");
    expect(html).toContain("Prompt-injection scan and egress guard");
    expect(html).toContain("Host caps: 6 connector calls per turn, and 3 calls per turn for a subagent.");

    for (const id of ["gmail", "google_drive", "onedrive", "notion"] as const) {
      expect(html).toContain(`data-testid="mcp-connector-${id}"`);
      expect(html).toContain(`data-testid="mcp-endpoint-${id}"`);
      expect(html).toContain(`data-testid="mcp-token-${id}"`);
      expect(html).toContain(`data-testid="mcp-access-read-only-${id}"`);
      expect(html).toContain(`data-testid="mcp-access-disabled-${id}"`);
      expect(html).toContain(`data-testid="mcp-subagents-${id}"`);
      expect(html).toContain(`data-testid="mcp-max-calls-${id}"`);
      expect(html).toContain(`data-testid="mcp-save-${id}"`);
      expect(html).toContain(`data-testid="mcp-test-${id}"`);
      expect(html).toContain(`data-testid="mcp-disconnect-${id}"`);
    }
    for (const label of ["Gmail", "Google Drive", "OneDrive", "Notion"]) {
      expect(html).toContain(label);
    }
  });

  it("shows connection details, policy controls, and discovered read-only actions", () => {
    const html = markup();
    expect(html).toContain('data-testid="mcp-status-gmail"');
    expect(html).toContain("Connected");
    expect(html).toContain("sha256:gmail-token");
    expect(html).toContain('value="https://mcp.example.com/gmail"');
    expect(html).toContain("search_messages");
    expect(html).toContain("get_message");
    expect(html).toContain('data-source="discovered"');
    expect(html).toContain('data-source="allowlisted"');
    expect(html.match(/type="number"/g)).toHaveLength(4);
    expect(html.match(/min="1"/g)).toHaveLength(4);
    expect(html.match(/max="10"/g)).toHaveLength(4);
    expect(html).toContain("Allow team subagents to fetch through this connector");
    expect(html).toContain("Maximum calls per turn");
  });

  it("renders the boundary rules, connectors, and controls in Bahasa Indonesia", () => {
    applyLocale("id");
    const html = markup();
    expect(html).toContain("Konektor (MCP)");
    expect(html).toContain("Batas Sandbox &amp; Agen");
    expect(html).toContain("Pengambilan hanya-baca ditegakkan");
    expect(html).toContain("Isolasi sandbox");
    expect(html).toContain("Cakupan subagen tim");
    expect(html).toContain("Pindai injeksi prompt dan penjaga keluar data");
    expect(html).toContain("Terhubung");
    expect(html).toContain("Belum terhubung");
    expect(html).toContain("Aksi hanya-baca");
    expect(html).toContain("Hubungkan");
    expect(html).toContain("Uji");
    expect(html).toContain("Putuskan");
    for (const label of ["Gmail", "Google Drive", "OneDrive", "Notion"]) {
      expect(html).toContain(label);
    }
  });
});
