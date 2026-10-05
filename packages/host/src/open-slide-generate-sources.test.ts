import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrappingKeyFromSecret, type ChatModel, type TenantContext } from "@agentforge/core";
import { draftOpenSlideDeck } from "@agentforge/core/open-slide";
import type { DeskPath, FileRoot } from "@agentforge/core/tools/files";
import { ensureSchema } from "@agentforge/db/ensure-schema";
import { createDeskFileStore } from "./desk-files/file-store";
import { SOURCE_MATERIAL_RULE } from "./job-source";

/**
 * Open Slide on a live runtime reads desk files the way the Nultron outline does. The model call,
 * the artifact store and the Knowledge Base write are stood in for; the file read is the real store.
 * Open Slide has no structure checks (a page is free-placed blocks, with no heading or bullets), so
 * a deck is one model call whatever it holds.
 */
type Asked = Record<string, unknown>;
const asked: Asked[] = [];
const created: Array<{ meta?: Record<string, unknown> }> = [];
let deskRoot: FileRoot | null = null;

vi.mock("./desk-files/store", () => ({
  createDeskRoot: () => {
    if (!deskRoot) {
      throw new Error("no desk root in this test");
    }
    return deskRoot;
  },
}));

vi.mock("./job-regen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./job-regen")>();
  return {
    ...actual,
    collectJobAssistantRun: async (options: Asked) => {
      asked.push(options);
      const deck = draftOpenSlideDeck({
        prompt: "Vendor switch",
        pageCount: "short",
        density: "light",
        motion: "static",
        locale: "en",
      });
      return { text: JSON.stringify(deck), model: "deepseek-v4-flash" };
    },
  };
});

vi.mock("./artifacts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./artifacts")>();
  return {
    ...actual,
    artifactStore: () => ({
      create: (_tenant: TenantContext, input: { meta?: Record<string, unknown> }) => {
        created.push(input);
        return { id: "artifact-1" };
      },
    }),
  };
});

vi.mock("./knowledge-ingest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./knowledge-ingest")>();
  return { ...actual, upsertWorkSource: async () => ({ status: "skipped" as const, reason: "test" }) };
});

const CATALOG = ["deepseek-v4-flash"].map(
  (id): ChatModel => ({ id, label: id, provider: "openai", inputModalities: ["text", "image"] }) as ChatModel,
);

vi.mock("./selectable-models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./selectable-models")>();
  return { ...actual, listSelectableModels: () => CATALOG };
});

const { generateOpenSlideDeck } = await import("./open-slide-generate");

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org",
  workspaceId: "ws-open-slide-sources",
  userId: "local",
  role: "owner",
};

const person = { kind: "user", userId: "local" } as const;

describe("Open Slide with desk files as the source", () => {
  let db: Database.Database;

  beforeEach(async () => {
    asked.length = 0;
    created.length = 0;
    vi.stubEnv("AGENTFORGE_RUNTIME", "ai");
    db = new Database(":memory:");
    ensureSchema(db);
    deskRoot = createDeskFileStore(db, () => wrappingKeyFromSecret("f".repeat(64))).createDeskRoot(tenant, person);
    await deskRoot.write("brief.txt" as DeskPath, "Vendor switch on Monday.", person);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    db.close();
    deskRoot = null;
  });

  it("adds the file to the brief under a header and records which file was used", async () => {
    await generateOpenSlideDeck(tenant, {
      prompt: "Vendor switch",
      model: "deepseek-v4-flash",
      brief: { pageCount: "short" },
      sourceText: "Pasted first.",
      sourceFiles: ["brief.txt"],
    });
    expect(asked).toHaveLength(1);
    expect(String(asked[0]?.prompt)).toContain(
      "<<<\nPasted first.\n\n=== Desk file: brief.txt ===\nVendor switch on Monday.\n>>>",
    );
    expect(String(asked[0]?.systemPrompt)).toContain(SOURCE_MATERIAL_RULE);
    expect(created[0]?.meta).toMatchObject({ engine: "open-slide", sourceFiles: ["brief.txt"] });
  });

  it("refuses a file that is not on the desk before any model call", async () => {
    await expect(
      generateOpenSlideDeck(tenant, { prompt: "Vendor switch", sourceFiles: ["nope.md"] }),
    ).rejects.toMatchObject({ code: "source_file_not_found", status: 400 });
    expect(asked).toHaveLength(0);
  });
});
