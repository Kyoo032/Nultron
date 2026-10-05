import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeTool, type TenantContext } from "@agentforge/core";
import { addPastedSource } from "./knowledge";
import { upsertWorkSource } from "./knowledge-ingest";
import {
  KNOWLEDGE_SEARCH_EMPTY_DESK_NOTE,
  KNOWLEDGE_SEARCH_NO_MATCH_NOTE,
  KNOWLEDGE_SEARCH_UNAVAILABLE_MESSAGE,
  knowledgeSearchTool,
  toSearchHit,
} from "./knowledge-search-tool";
import { withRunContext } from "./run-context";
import { chatWorkCard } from "./work-cards";

const retrieval = vi.hoisted(() => ({ fail: false }));

vi.mock("./knowledge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./knowledge")>();
  return {
    ...actual,
    retrieveChunks: (...args: Parameters<typeof actual.retrieveChunks>) =>
      retrieval.fail ? Promise.reject(new Error("index offline")) : actual.retrieveChunks(...args),
  };
});

function desk(label: string): TenantContext {
  return {
    tenantId: "local-tenant",
    organizationId: "org-knowledge-search-test",
    workspaceId: `ws-search-${label}-${crypto.randomUUID()}`,
    userId: "user-knowledge-search-test",
    role: "owner",
  };
}

function search(tenant: TenantContext, args: unknown): Promise<unknown> {
  return invokeTool(knowledgeSearchTool, args, tenant);
}

describe("knowledge_search", () => {
  let previousRuntime: string | undefined;
  let previousSettings: string | undefined;
  let previousOpenaiKey: string | undefined;
  let settingsDir: string;

  beforeEach(() => {
    previousRuntime = process.env.AGENTFORGE_RUNTIME;
    previousSettings = process.env.AGENTFORGE_SETTINGS_PATH;
    previousOpenaiKey = process.env.OPENAI_API_KEY;
    settingsDir = mkdtempSync(join(tmpdir(), "af-knowledge-search-"));
    process.env.AGENTFORGE_RUNTIME = "stub";
    process.env.AGENTFORGE_SETTINGS_PATH = settingsDir;
    delete process.env.OPENAI_API_KEY;
    retrieval.fail = false;
  });

  afterEach(() => {
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    };
    restore("AGENTFORGE_RUNTIME", previousRuntime);
    restore("AGENTFORGE_SETTINGS_PATH", previousSettings);
    restore("OPENAI_API_KEY", previousOpenaiKey);
    rmSync(settingsDir, { recursive: true, force: true });
  });

  it("is a user_content tool with the documented key and schema", () => {
    expect(knowledgeSearchTool.key).toBe("knowledge_search");
    expect(knowledgeSearchTool.trust).toBe("user_content");
    expect(knowledgeSearchTool.schema.parse({ query: "  tariff  " })).toEqual({ query: "tariff", limit: 4 });
  });

  it("refuses arguments outside the schema", async () => {
    const ctx = desk("schema");
    const refused: unknown[] = [
      {},
      { query: "" },
      { query: "   " },
      { query: "x".repeat(501) },
      { query: "tariff", limit: 0 },
      { query: "tariff", limit: 9 },
      { query: "tariff", limit: 2.5 },
      { query: "tariff", path: "C:\\Users\\rizky\\notes.txt" },
    ];
    for (const args of refused) {
      await expect(search(ctx, args)).rejects.toMatchObject({ code: "invalid_tool_args" });
    }
    await expect(search(ctx, { query: "x".repeat(500), limit: 8 })).resolves.toEqual({
      results: [],
      note: KNOWLEDGE_SEARCH_EMPTY_DESK_NOTE,
    });
  });

  it("returns the matching source for a literal query and not the other one", async () => {
    const ctx = desk("match");
    const memo = await addPastedSource(
      ctx,
      "Harbor tariff memo",
      "The zanzibarite surcharge on bulk cargo is 4.5 percent from March.",
    );
    await addPastedSource(ctx, "Kitchen notes", "Buy flour, eggs and butter on Saturday.");

    const found = await search(ctx, { query: "zanzibarite surcharge" });

    expect(found).toEqual({
      results: [
        {
          title: "Harbor tariff memo",
          source_id: memo.id,
          snippet: "The zanzibarite surcharge on bulk cargo is 4.5 percent from March.",
          score: expect.any(Number),
        },
      ],
    });
  });

  it("never returns another desk's sources, and says so when this desk is empty", async () => {
    const mine = desk("mine");
    const theirs = desk("theirs");
    const empty = desk("empty");
    const ownSource = await addPastedSource(mine, "My ledger", "The quillfeather account closes on Friday.");
    const otherSource = await addPastedSource(theirs, "Their ledger", "The quillfeather account closes on Monday.");

    const fromMine = (await search(mine, { query: "quillfeather account" })) as {
      results: Array<{ source_id: string; snippet: string }>;
    };
    expect(fromMine.results.map((hit) => hit.source_id)).toEqual([ownSource.id]);
    expect(fromMine.results[0]?.snippet).toBe("The quillfeather account closes on Friday.");

    const fromTheirs = (await search(theirs, { query: "quillfeather account" })) as {
      results: Array<{ source_id: string }>;
    };
    expect(fromTheirs.results.map((hit) => hit.source_id)).toEqual([otherSource.id]);

    await expect(search(empty, { query: "quillfeather account" })).resolves.toEqual({
      results: [],
      note: KNOWLEDGE_SEARCH_EMPTY_DESK_NOTE,
    });
  });

  it("says nothing matched when the desk has sources but none fit", async () => {
    const ctx = desk("nomatch");
    await addPastedSource(ctx, "Kitchen notes", "Buy flour, eggs and butter on Saturday.");

    await expect(search(ctx, { query: "quarterly depreciation schedule" })).resolves.toEqual({
      results: [],
      note: KNOWLEDGE_SEARCH_NO_MATCH_NOTE,
    });
  });

  it("returns four excerpts by default and as many as `limit` asks for", async () => {
    const ctx = desk("limit");
    for (let index = 1; index <= 5; index += 1) {
      await addPastedSource(ctx, `Wharf log ${index}`, `Entry ${index}: the glimmerstone shipment cleared customs.`);
    }

    const byDefault = (await search(ctx, { query: "glimmerstone shipment" })) as { results: unknown[] };
    const two = (await search(ctx, { query: "glimmerstone shipment", limit: 2 })) as { results: unknown[] };
    const eight = (await search(ctx, { query: "glimmerstone shipment", limit: 8 })) as { results: unknown[] };

    expect(byDefault.results).toHaveLength(4);
    expect(two.results).toHaveLength(2);
    expect(eight.results).toHaveLength(5);
  });

  it("does not hand a chat thread its own work card back", async () => {
    const ctx = desk("thread");
    for (const threadId of ["thread-a", "thread-b"]) {
      await upsertWorkSource(
        ctx,
        chatWorkCard({
          threadId,
          title: `Vendor risk ${threadId}`,
          userText: "vendor concentration risk",
          assistantText: `Vendor concentration risk in ${threadId} is high above 40 percent of spend.`,
        }),
      );
    }

    const outside = (await search(ctx, { query: "vendor concentration risk" })) as { results: unknown[] };
    const inside = (await withRunContext({ threadId: "thread-a", agentId: "agent-test", locale: "en" }, () =>
      search(ctx, { query: "vendor concentration risk" }),
    )) as { results: Array<{ title: string }> };

    expect(outside.results).toHaveLength(2);
    expect(inside.results.map((hit) => hit.title)).toEqual(["Vendor risk thread-b"]);
  });

  it("refuses with `unavailable` instead of throwing when the gateway gate is closed", async () => {
    const ctx = desk("gate");
    await addPastedSource(ctx, "Harbor tariff memo", "The zanzibarite surcharge on bulk cargo is 4.5 percent.");
    process.env.AGENTFORGE_RUNTIME = "ai";

    await expect(search(ctx, { query: "zanzibarite surcharge" })).resolves.toEqual({
      ok: false,
      reason: "unavailable",
      message: KNOWLEDGE_SEARCH_UNAVAILABLE_MESSAGE,
    });
  });

  it("refuses with `unavailable` when retrieval itself fails", async () => {
    const ctx = desk("failure");
    await addPastedSource(ctx, "Harbor tariff memo", "The zanzibarite surcharge on bulk cargo is 4.5 percent.");
    retrieval.fail = true;

    await expect(search(ctx, { query: "zanzibarite surcharge" })).resolves.toEqual({
      ok: false,
      reason: "unavailable",
      message: KNOWLEDGE_SEARCH_UNAVAILABLE_MESSAGE,
    });
  });

  describe("toSearchHit", () => {
    const chunk = {
      body: "x".repeat(3000),
      sourceId: "source-1",
      sourceName: "\n## Quarterly\treport\n",
      score: 0.123456,
      chunkIndex: 0,
    };

    it("caps the snippet at 1200 characters and tidies the title", () => {
      const hit = toSearchHit(chunk);
      expect(hit.snippet).toHaveLength(1200);
      expect(hit.snippet.endsWith("…")).toBe(true);
      expect(hit.title).toBe("Quarterly report");
      expect(hit.score).toBe(0.123);
    });

    it("falls back to the source id when the name is empty, and keeps a short body whole", () => {
      expect(toSearchHit({ ...chunk, body: "short", sourceName: "###" })).toEqual({
        title: "source-1",
        source_id: "source-1",
        snippet: "short",
        score: 0.123,
      });
    });

    it("omits a score that is not a number", () => {
      expect(toSearchHit({ ...chunk, body: "short", score: Number.NaN })).toEqual({
        title: "Quarterly report",
        source_id: "source-1",
        snippet: "short",
      });
    });
  });
});
