/**
 * The four Finance routes a closed gateway gate must NOT stop.
 *
 * `/export`, `/docx`, `/import` and `/auto` never call the gateway: they re-render a report the
 * owner already has, or read a file off their own machine, or read its figures with code only.
 * Gating them would mean an unvalidated or expired key locking the owner out of their own figures,
 * which is the one failure mode a local-first product cannot have. This pins that decision — and,
 * in the same run, proves the gate really is closed, so a green result here can never just mean
 * "nothing was gated anywhere".
 *
 * The second block pins the same split for the doc-flow routes (docs/internal/doc-flow-plan.md):
 * the Legal extract and ask presses and the Meeting translate press are gated, and everything the
 * owner does with their own files or their own words (the reads, the edits, the comments, the
 * transcript file) is not. Those routes look the row up before they check the gate, so the block
 * creates a real matter and a real meeting first.
 *
 * The gate is closed the way `handlers/settings.test.ts` closes it: by dropping the stub runtime
 * inside the test, since `test/setup.ts` puts it back before every module.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ROUTER_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";
import { writeWorkbook } from "@agentforge/core/tabular";
import type { HostFile, HostRequest, HostResult } from "../types";

// Isolation: "is really closed" needs a desk that has never held a gateway key, so this file brings
// its own data dir, set before the router is imported, instead of sharing whatever else ran here.
const dataDir = mkdtempSync(join(tmpdir(), "agentforge-finance-gate-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;

type Dispatch = (request: HostRequest) => Promise<HostResult>;
let dispatch: Dispatch;

const STUB = process.env.AGENTFORGE_RUNTIME;

function request(path: string, extra: Partial<HostRequest> = {}): HostRequest {
  return { method: "POST", path, query: {}, params: {}, headers: {}, ...extra };
}

/** The flat `{ error: "gateway_blocked" }` body `parseGatewayBlocked` reads, or "" for anything else. */
function blockedCode(result: HostResult): string {
  if (result.type !== "json") {
    return "";
  }
  return (result.body as { error?: unknown } | null)?.error === "gateway_blocked" ? "gateway_blocked" : "";
}

function statusOf(result: HostResult): number {
  return result.type === "json" ? result.status : 200;
}

const BOOK = writeWorkbook([
  {
    name: "Summary",
    rows: [
      ["Label", "Amount"],
      ["Revenue", 120000],
    ],
  },
]);

function upload(filename: string, bytes: Uint8Array): HostFile {
  return { field: "file", filename, mime: "application/octet-stream", bytes };
}

const BRIEF = {
  title: "FY2025",
  summary: ["Revenue was 120000."],
  sections: [{ heading: "Margin", body: "Revenue was 120000." }],
};

beforeAll(async () => {
  ({ dispatch } = await import("../router"));
}, ROUTER_IMPORT_BUDGET_MS);

afterEach(() => {
  process.env.AGENTFORGE_RUNTIME = STUB ?? "stub";
});

afterAll(async () => {
  // The router opened the kernel SQLite inside dataDir. Windows will not delete a file something
  // still holds, so that handle is closed before the dir goes.
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("the gateway gate and the Finance file routes", () => {
  it("is really closed, so the assertions below mean something", async () => {
    delete process.env.AGENTFORGE_RUNTIME;
    const result = await dispatch(request("/api/v1/finance", { body: { task: "brief", prompt: "x", items: [] } }));

    expect(blockedCode(result)).toBe("gateway_blocked");
    expect(statusOf(result)).toBe(403);
  });

  it("still lets the owner export, render Word and read a file with the gate shut", async () => {
    delete process.env.AGENTFORGE_RUNTIME;
    const calls: ReadonlyArray<readonly [string, Partial<HostRequest>]> = [
      ["/api/v1/finance/export", { body: { brief: BRIEF, format: "markdown" } }],
      ["/api/v1/finance/docx", { body: { brief: BRIEF } }],
      ["/api/v1/finance/import", { files: [upload("book.xlsx", BOOK)] }],
      // Code only (plan section 3). Whatever the route answers once it is real, it is not a 403.
      ["/api/v1/finance/auto", { body: { figuresText: "Revenue 120000", proseText: "" } }],
    ];
    for (const [path, extra] of calls) {
      const result = await dispatch(request(path, extra));
      expect(blockedCode(result), path).toBe("");
      expect(statusOf(result), path).not.toBe(403);
    }
  });
});

const MATTER = {
  title: "Gate probe",
  side: { role: "borrower", party: "Aurora Holdings", counterparty: "the Lenders" },
  workType: "review",
  deliverables: ["issues-memo"],
};

async function createdId(path: string, body: unknown): Promise<string> {
  const result = await dispatch(request(path, { body }));
  if (result.type !== "json" || result.status !== 201) {
    throw new Error(`${path} did not create: ${statusOf(result)}`);
  }
  return (result.body as { id: string }).id;
}

describe("the gateway gate and the doc-flow routes", () => {
  let matterId: string;
  let meetingId: string;

  beforeAll(async () => {
    // Created with the gate open: creation never reaches the gateway, but the stub runtime is the
    // state every other test file here starts from.
    matterId = await createdId("/api/v1/legal/matters", MATTER);
    meetingId = await createdId("/api/v1/meetings", { title: "Gate probe", locale: "en" });
  }, ROUTER_IMPORT_BUDGET_MS);

  type Call = readonly [method: string, path: string, extra: Partial<HostRequest>];

  const gated = (): readonly Call[] => [
    ["POST", `/api/v1/legal/matters/${matterId}/extract/stream`, { body: {} }],
    ["POST", `/api/v1/legal/matters/${matterId}/ask/stream`, { body: { question: "Who pays?" } }],
    ["POST", `/api/v1/meetings/${meetingId}/translate/stream`, { body: {} }],
  ];

  const free = (): readonly Call[] => [
    ["GET", `/api/v1/legal/matters/${matterId}/extract`, {}],
    ["GET", `/api/v1/legal/matters/${matterId}/asks`, {}],
    ["PUT", `/api/v1/legal/matters/${matterId}/extract/edits`, { body: {} }],
    ["POST", `/api/v1/legal/matters/${matterId}/extract/comments`, { body: {} }],
    [
      "POST",
      `/api/v1/meetings/${meetingId}/transcript/file`,
      { files: [upload("talk.txt", new TextEncoder().encode("Alice: we agree."))] },
    ],
  ];

  it("stops the three paid presses with the gate shut", async () => {
    delete process.env.AGENTFORGE_RUNTIME;
    for (const [method, path, extra] of gated()) {
      const result = await dispatch(request(path, { method, ...extra }));
      expect(blockedCode(result), `${method} ${path}`).toBe("gateway_blocked");
      expect(statusOf(result), `${method} ${path}`).toBe(403);
    }
  });

  it("lets the same three past the gate when it is open", async () => {
    // The control that makes the test above mean something: under the stub runtime the gate is
    // open, and each route gets past it to whatever it does next.
    for (const [method, path, extra] of gated()) {
      const result = await dispatch(request(path, { method, ...extra }));
      expect(blockedCode(result), `${method} ${path}`).toBe("");
      expect(statusOf(result), `${method} ${path}`).not.toBe(403);
    }
  });

  it("never stops the reads, the owner's edits, the comments or a transcript file", async () => {
    delete process.env.AGENTFORGE_RUNTIME;
    for (const [method, path, extra] of free()) {
      const result = await dispatch(request(path, { method, ...extra }));
      expect(blockedCode(result), `${method} ${path}`).toBe("");
      expect(statusOf(result), `${method} ${path}`).not.toBe(403);
    }
  });

  it("looks the row up before it checks the gate, so a shut gate does not hide a missing id", async () => {
    delete process.env.AGENTFORGE_RUNTIME;
    for (const [method, path, extra] of gated()) {
      const ghost = path.replace(matterId, crypto.randomUUID()).replace(meetingId, crypto.randomUUID());
      const result = await dispatch(request(ghost, { method, ...extra }));
      expect(statusOf(result), `${method} ${ghost}`).toBe(404);
      expect(blockedCode(result), `${method} ${ghost}`).toBe("");
    }
  });
});
