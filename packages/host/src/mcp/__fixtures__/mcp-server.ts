import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Local JSON-RPC 2.0 MCP HTTP server fixture for Gmail, Google Drive, OneDrive, and Notion.
 * Deliberately advertises both safe read-only tools and forbidden write/delete/harness tools so
 * tests prove Nultron's boundary filters out dangerous tools and blocks any attempt to invoke them.
 */
export type McpFixtureServer = {
  readonly baseUrl: string;
  readonly token: string;
  readonly calls: Array<{ path: string; method: string; tool?: string; args?: unknown; sessionId?: string }>;
  close(): Promise<void>;
};

const FIXTURE_DATA: Record<string, { tools: Array<{ name: string }>; responses: Record<string, string> }> = {
  "/gmail": {
    tools: [
      { name: "search_messages" },
      { name: "get_message" },
      { name: "send_email" },
      { name: "delete_message" },
      { name: "edit_harness" },
    ],
    responses: {
      search_messages: "Message #101: Q4 Vendor Renewal Quote from PT Kopi Nusantara — IDR 45,000,000.",
      get_message: "Full email #101 body: Please confirm renewal by Dec 15.",
    },
  },
  "/google-drive": {
    tools: [
      { name: "search_files" },
      { name: "read_file" },
      { name: "delete_file" },
      { name: "share_file" },
    ],
    responses: {
      search_files: "File drv_01: 2026_Budget_Sheet.xlsx (modified yesterday)",
      read_file: "Revenue Q3: $180,000; Expenses Q3: $112,000.",
    },
  },
  "/onedrive": {
    tools: [
      { name: "list_files" },
      { name: "read_file" },
      { name: "upload_file" },
      { name: "remove_file" },
    ],
    responses: {
      list_files: "OneDrive item od_09: Enterprise_Contract_Draft.docx",
      read_file: "Clause 4.2: Service availability SLA is 99.9%.",
    },
  },
  "/notion": {
    tools: [
      { name: "search" },
      { name: "get_page" },
      { name: "query_database" },
      { name: "update_page" },
      { name: "delete_block" },
    ],
    responses: {
      search: "Notion page c77d2a3de93647de8d7ca0d97a52a1ba (pg_77): Nultron Product Roadmap 2026",
      get_page: "Roadmap priorities: Omnichannel, Voice Mode, MCP Sandbox Connectors.",
      query_database: "3 active launch milestones found.",
    },
  },
};

export async function startMcpFixtureServer(expectedToken = "mcp_live_test_token_987654"): Promise<McpFixtureServer> {
  const calls: McpFixtureServer["calls"] = [];
  /** Issued session id -> whether `notifications/initialized` has arrived for it. */
  const sessions = new Map<string, boolean>();
  let nextSession = 1;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${expectedToken}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const route = req.url ?? "/";
      const fixture = FIXTURE_DATA[route];
      if (!fixture) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id?: number;
        method: string;
        params?: { name?: string; arguments?: { query?: unknown } };
      };
      // Node lowercases every incoming header name, so this read is the wire casing already normalised.
      const sessionHeader = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : undefined;
      calls.push({
        path: route,
        method: body.method,
        tool: body.params?.name,
        args: body.params?.arguments,
        ...(sessionHeader !== undefined ? { sessionId: sessionHeader } : {}),
      });

      if (body.method === "initialize") {
        // A strict stateful Streamable HTTP server: a session id is issued here and every later
        // method is refused until `notifications/initialized` arrives carrying it.
        const sessionId = `fixture-session-${nextSession++}`;
        sessions.set(sessionId, false);
        res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": sessionId });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05" } }));
        return;
      }
      if (body.method === "notifications/initialized") {
        if (!sessionHeader || !sessions.has(sessionHeader)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unknown_session" }));
          return;
        }
        sessions.set(sessionHeader, true);
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end();
        return;
      }
      if (body.method === "tools/list" || body.method === "tools/call") {
        if (!sessionHeader || sessions.get(sessionHeader) !== true) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "session_not_initialized" }));
          return;
        }
      }
      if (body.method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: fixture.tools } }));
        return;
      }
      if (body.method === "tools/call") {
        const name = body.params?.name ?? "";
        if (body.params?.arguments?.query === "__trigger_tool_error__") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: { isError: true, content: [{ type: "text", text: "fixture tool failure: the upstream read failed" }] },
            }),
          );
          return;
        }
        if (body.params?.arguments?.query === "__large_response__") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: { content: [{ type: "text", text: "x".repeat(1_100_000) }] },
            }),
          );
          return;
        }
        if (body.params?.arguments?.query === "__mixed_notion_id__") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                content: [
                  {
                    type: "text",
                    text:
                      "id: b11a2b3c-d4e5-4f6a-8b9c-0d1e2f3a4b5c, " +
                      "url: https://www.notion.so/Roadmap-b11a2b3cd4e54f6a8b9c0d1e2f3a4b5c, " +
                      "secretUrl: https://www.notion.so/Private-e44e5f6a7b8c4d0e9f2a3b4c5d6e7f8a, " +
                      "api_secret = 0f3ab19c77de4521bc90ff12ad7e6b48, " +
                      "webhook_secret: 9a8b7c6d5e4f4321a1b2c3d4e5f60718, " +
                      "checksum: d41d8cd98f00b204e9800998ecf8427e",
                  },
                ],
              },
            }),
          );
          return;
        }
        const text = fixture.responses[name] ?? `Executed ${name}`;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text }] },
          }),
        );
        return;
      }
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32601, message: "Unknown method" } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: expectedToken,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
