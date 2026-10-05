import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, wrappingKeyFromSecret, type ChatModel, type TenantContext } from "@agentforge/core";
import type { DeskPath, FileRoot } from "@agentforge/core/tools/files";
import { ensureSchema } from "@agentforge/db/ensure-schema";
import { createDeskFileStore } from "./desk-files/file-store";
import { SOURCE_MATERIAL_RULE } from "./job-source";
import type { WorkCard } from "./work-cards";

/**
 * Same boundary as `document-generate.test.ts`: the gateway call, the artifact store and the
 * Knowledge Base write are mocked; reading the body, the pin and what gets recorded are real.
 */
type Asked = Record<string, unknown>;
const asked: Asked[] = [];
const created: Array<{ meta?: Record<string, unknown> }> = [];
const ingested: WorkCard[] = [];
let answer = { text: "", model: "" };
/**
 * Scripted answers, taken in order before `answer` is used. An Error is a call that throws; a
 * function runs at that call (to cancel mid-run) and returns the text.
 */
const scripted: Array<string | Error | (() => string)> = [];
/** The desk the source files are read from: a scratch store, so the read goes through the real file root. */
let deskRoot: FileRoot | null = null;

vi.mock("./desk-files/store", () => ({
  createDeskRoot: () => {
    if (!deskRoot) {
      throw new Error("no desk root in this test");
    }
    return deskRoot;
  },
}));

function nextText(): string {
  const next = scripted.shift();
  if (next instanceof Error) {
    throw next;
  }
  return typeof next === "function" ? next() : (next ?? answer.text);
}

vi.mock("./job-regen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./job-regen")>();
  return {
    ...actual,
    collectJobAssistantText: async (options: Asked) => {
      asked.push(options);
      return nextText();
    },
    collectJobAssistantRun: async (options: Asked) => {
      asked.push(options);
      return { text: nextText(), model: answer.model };
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
  return {
    ...actual,
    upsertWorkSource: async (_tenant: TenantContext, card: WorkCard) => {
      ingested.push(card);
      return { status: "skipped" as const, reason: "test" };
    },
  };
});

const CATALOG = ["deepseek-v4-flash", "gpt-5.6-luna", "gpt-5.6-sol"].map(
  (id): ChatModel => ({ id, label: id, provider: "openai", inputModalities: ["text", "image"] }) as ChatModel,
);

vi.mock("./selectable-models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./selectable-models")>();
  return {
    ...actual,
    listSelectableModels: () => CATALOG,
    modeCatalogPayload: () => ({ defaults: { presentations: "deepseek-v4-flash" } }),
  };
});

const { generatePresentationOutline, regeneratePresentationSlide } = await import("./presentation-generate");

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org",
  workspaceId: "ws-presentations-model",
  userId: "local",
  role: "owner",
};

const OUTLINE = {
  title: "Vendor switch",
  slides: [
    { kind: "bullets", heading: "We switch on Monday", subhead: "", bullets: ["Billing moves"], aside: "", notes: "" },
    {
      kind: "close",
      heading: "Approve by Friday",
      subhead: "",
      bullets: ["Sign the order before 17:00."],
      aside: "",
      notes: "",
    },
  ],
};

describe("the model a Presentations job uses and records", () => {
  beforeEach(() => {
    asked.length = 0;
    created.length = 0;
    ingested.length = 0;
    scripted.length = 0;
    answer = { text: JSON.stringify(OUTLINE), model: "deepseek-v4-flash" };
    vi.stubEnv("AGENTFORGE_RUNTIME", "ai");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("records the model that answered, not the one requested, when a stand-in wrote the outline", async () => {
    answer = { text: JSON.stringify(OUTLINE), model: "gpt-5.6-luna" };
    const outline = await generatePresentationOutline(tenant, {
      prompt: "Vendor switch deck",
      model: "deepseek-v4-flash",
    });
    expect(outline.title).toBe("Vendor switch");
    expect(created[0]?.meta?.model).toBe("gpt-5.6-luna");
    expect(ingested[0]?.model).toBe("gpt-5.6-luna");
  });

  it("hands a pinned pick to the job run as modelExplicit", async () => {
    await generatePresentationOutline(tenant, {
      prompt: "Vendor switch deck",
      model: "gpt-5.6-sol",
      modelPinned: true,
    });
    expect(asked[0]).toMatchObject({ model: "gpt-5.6-sol", modelExplicit: true });
  });

  it("leaves a seeded default rescuable", async () => {
    await generatePresentationOutline(tenant, { prompt: "Vendor switch deck", model: "deepseek-v4-flash" });
    expect(asked[0]?.modelExplicit).toBe(false);
  });

  it("passes the pin on a slide rewrite too", async () => {
    answer = { text: JSON.stringify(OUTLINE.slides[0]), model: "gpt-5.6-sol" };
    await regeneratePresentationSlide(tenant, {
      outline: OUTLINE,
      slideIndex: 0,
      model: "gpt-5.6-sol",
      modelPinned: true,
    });
    expect(asked[0]).toMatchObject({ model: "gpt-5.6-sol", modelExplicit: true });
  });
});

const KEY = wrappingKeyFromSecret("e".repeat(64));
const person = { kind: "user", userId: "local" } as const;
const path = (value: string): DeskPath => value as DeskPath;

function slidesJson(headings: string[]): string {
  return JSON.stringify({
    title: "Vendor switch",
    slides: headings.map((heading) => ({
      kind: "bullets",
      heading,
      subhead: "",
      bullets: ["Billing moves to the new vendor on the first of the month."],
      aside: "",
      notes: "",
    })),
  });
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; status: number; message: string }> {
  try {
    await promise;
  } catch (error) {
    const { code, status, message } = error as { code: string; status: number; message: string };
    return { code, status, message };
  }
  throw new Error("expected the request to be refused");
}

describe("desk files as the source of an outline", () => {
  let db: Database.Database;

  beforeEach(async () => {
    asked.length = 0;
    created.length = 0;
    ingested.length = 0;
    scripted.length = 0;
    answer = { text: JSON.stringify(OUTLINE), model: "deepseek-v4-flash" };
    vi.stubEnv("AGENTFORGE_RUNTIME", "ai");
    db = new Database(":memory:");
    ensureSchema(db);
    deskRoot = createDeskFileStore(db, () => KEY).createDeskRoot(tenant, person);
    await deskRoot.write(path("notes/plan.md"), "1. gather\n2. draft\n3. ship\n", person);
    await deskRoot.write(path("brief.txt"), "Vendor switch on Monday.", person);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    db.close();
    deskRoot = null;
  });

  it("adds each named file to the brief under a header, after the pasted text, and says only that material counts", async () => {
    await generatePresentationOutline(tenant, {
      prompt: "Vendor switch deck",
      model: "deepseek-v4-flash",
      sourceText: "Pasted: the price is fixed.",
      sourceFiles: ["notes/plan.md", "brief.txt"],
    });
    expect(asked).toHaveLength(1);
    expect(String(asked[0]?.prompt)).toContain(
      "<<<\nPasted: the price is fixed.\n\n=== Desk file: notes/plan.md ===\n1. gather\n2. draft\n3. ship\n\n=== Desk file: brief.txt ===\nVendor switch on Monday.\n>>>",
    );
    expect(String(asked[0]?.systemPrompt)).toContain(SOURCE_MATERIAL_RULE);
    expect(created[0]?.meta?.sourceFiles).toEqual(["notes/plan.md", "brief.txt"]);
  });

  it("works with files alone, and a request without them reaches the model exactly as before", async () => {
    await generatePresentationOutline(tenant, {
      prompt: "Vendor switch deck",
      model: "deepseek-v4-flash",
      sourceFiles: ["brief.txt"],
    });
    expect(String(asked[0]?.prompt)).toContain("<<<\n=== Desk file: brief.txt ===\nVendor switch on Monday.\n>>>");
    asked.length = 0;
    await generatePresentationOutline(tenant, { prompt: "Vendor switch deck", model: "deepseek-v4-flash" });
    expect(asked[0]?.prompt).toBe("Vendor switch deck");
    expect(String(asked[0]?.systemPrompt)).not.toContain(SOURCE_MATERIAL_RULE);
  });

  it("answers 400 before any model call when a path is bad, missing, or the list is wrong", async () => {
    const bodies: Array<[unknown, string]> = [
      [["../secret"], "bad_path"],
      [["/etc/passwd"], "bad_path"],
      [["missing.md"], "source_file_not_found"],
      [["notes/plan.md", "nope.md"], "source_file_not_found"],
      ["notes/plan.md", "invalid_request"],
      [[7], "invalid_request"],
      [["a", "b", "c", "d", "e", "f"], "invalid_request"],
    ];
    for (const [sourceFiles, code] of bodies) {
      const error = await refusal(generatePresentationOutline(tenant, { prompt: "Vendor switch deck", sourceFiles }));
      expect(error, JSON.stringify(sourceFiles)).toMatchObject({ code, status: 400 });
    }
    expect(asked).toHaveLength(0);
    expect(created).toHaveLength(0);
  });

  it("reads the files for a slide rewrite too", async () => {
    answer = { text: JSON.stringify(OUTLINE.slides[0]), model: "deepseek-v4-flash" };
    await regeneratePresentationSlide(tenant, { outline: OUTLINE, slideIndex: 0, sourceFiles: ["brief.txt"] });
    expect(String(asked[0]?.prompt)).toContain("=== Desk file: brief.txt ===\nVendor switch on Monday.");
    expect(String(asked[0]?.systemPrompt)).toContain(SOURCE_MATERIAL_RULE);
  });
});

describe("an outline is done when it passes its checks", () => {
  beforeEach(() => {
    asked.length = 0;
    created.length = 0;
    ingested.length = 0;
    scripted.length = 0;
    answer = { text: JSON.stringify(OUTLINE), model: "deepseek-v4-flash" };
    vi.stubEnv("AGENTFORGE_RUNTIME", "ai");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a passing outline after one model call, with no checks on it", async () => {
    const outline = await generatePresentationOutline(tenant, { prompt: "Vendor switch deck", slideCount: 3 });
    expect(asked).toHaveLength(1);
    expect(outline).not.toHaveProperty("checks");
    expect(created[0]?.meta).not.toHaveProperty("repairRounds");
  });

  it("tells the model the slide count in total and in the list, and records what the person asked", async () => {
    await generatePresentationOutline(tenant, { prompt: "Vendor switch deck", slideCount: 3 });
    expect(asked[0]?.prompt).toBe(
      'Vendor switch deck\n\nSlide count: 3 slides in total, counting the title slide, so "slides" holds exactly 2 items.',
    );
    expect(created[0]?.meta?.question).toBe("Vendor switch deck");
  });

  it("refuses a slideCount that is not a whole number from 2 to 15", async () => {
    for (const slideCount of [1, 16, 2.5, "8", Number.NaN]) {
      const error = await refusal(generatePresentationOutline(tenant, { prompt: "Vendor switch deck", slideCount }));
      expect(error, String(slideCount)).toMatchObject({ code: "invalid_request", status: 400 });
    }
    expect(asked).toHaveLength(0);
  });

  it("repairs a wrong slide count once: the second call carries the first outline and the exact note", async () => {
    const first = slidesJson(["We switch on Monday", "Billing moves first", "Approve by Friday"]);
    const second = slidesJson(["We switch on Monday", "Approve by Friday"]);
    scripted.push(first, second);
    const outline = await generatePresentationOutline(tenant, { prompt: "Vendor switch deck", slideCount: 3 });

    expect(asked).toHaveLength(2);
    expect(String(asked[0]?.prompt)).not.toContain("Your previous outline:");
    expect(asked[1]?.prompt).toBe(
      [
        asked[0]?.prompt,
        `Your previous outline:\n${first}`,
        "The output did not pass these checks. Fix every item and return the whole corrected output, not a diff.",
        [
          'ERROR: The outline has 3 items in "slides", but the request asked for 2.',
          'WHY: The request asked for 3 slides in total. The title slide is one of them and is not in "slides".',
          'FIX: Return the whole outline with exactly 2 items in "slides".',
        ].join("\n"),
      ].join("\n\n"),
    );
    expect(outline.slides.map((slide) => slide.heading)).toEqual(["We switch on Monday", "Approve by Friday"]);
    expect(outline).not.toHaveProperty("checks");
    expect(created[0]?.meta).toMatchObject({ slides: 2, repairRounds: 1 });
    expect(created[0]?.meta).not.toHaveProperty("failedChecks");
  });

  it("repairs a repeated heading with the slide numbers named", async () => {
    scripted.push(slidesJson(["Billing moves", "Support follows", "billing moves!"]));
    answer = {
      text: slidesJson(["Billing moves", "Support follows", "Approve by Friday"]),
      model: "deepseek-v4-flash",
    };
    const outline = await generatePresentationOutline(tenant, { prompt: "Vendor switch deck" });
    expect(String(asked[1]?.prompt)).toContain(
      'ERROR: Slides share a heading: item 1 of "slides" ("Billing moves") and item 3 of "slides" ("billing moves!") share one heading.',
    );
    expect(outline.slides.map((slide) => slide.heading)).toEqual([
      "Billing moves",
      "Support follows",
      "Approve by Friday",
    ]);
  });

  it("returns an outline that still fails after the repair round, with what it fails", async () => {
    const repeated = slidesJson(["Billing moves", "Support follows", "Billing moves"]);
    scripted.push(repeated, repeated);
    const outline = await generatePresentationOutline(tenant, { prompt: "Vendor switch deck" });
    expect(asked).toHaveLength(2);
    expect(outline.slides).toHaveLength(3);
    expect(outline.checks).toEqual([{ check: "duplicate_title", slides: [1, 3] }]);
    // The outline is saved as a draft like any other, with the failure recorded beside it.
    expect(created[0]?.meta).toMatchObject({ slides: 3, repairRounds: 1, failedChecks: ["duplicate_title"] });
    expect(ingested).toHaveLength(1);
  });

  it("keeps the first outline when the repair answers with something that is not an outline", async () => {
    scripted.push(slidesJson(["Billing moves", "Support follows", "Billing moves"]), "I could not fix it.");
    const outline = await generatePresentationOutline(tenant, { prompt: "Vendor switch deck" });
    expect(asked).toHaveLength(2);
    expect(outline.slides.map((slide) => slide.heading)).toEqual(["Billing moves", "Support follows", "Billing moves"]);
    expect(outline.checks).toEqual([{ check: "duplicate_title", slides: [1, 3] }]);
  });

  it("keeps the first outline when the repair answers with nothing", async () => {
    scripted.push(slidesJson(["Billing moves", "Support follows", "Billing moves"]), "  ");
    const outline = await generatePresentationOutline(tenant, { prompt: "Vendor switch deck" });
    expect(outline.slides).toHaveLength(3);
    expect(outline.checks).toEqual([{ check: "duplicate_title", slides: [1, 3] }]);
  });

  it("keeps the first outline when the repair call itself fails, as Research and Meeting do", async () => {
    for (const failure of [new ApiError("upstream_error", "Gateway returned 502", 502), new Error("socket hang up")]) {
      asked.length = 0;
      created.length = 0;
      ingested.length = 0;
      scripted.push(slidesJson(["Billing moves", "Support follows", "Billing moves"]), failure);
      const outline = await generatePresentationOutline(tenant, { prompt: "Vendor switch deck" });
      expect(asked, failure.message).toHaveLength(2);
      expect(outline.slides.map((slide) => slide.heading)).toEqual([
        "Billing moves",
        "Support follows",
        "Billing moves",
      ]);
      expect(outline.checks).toEqual([{ check: "duplicate_title", slides: [1, 3] }]);
      expect(created).toHaveLength(1);
      expect(created[0]?.meta).toMatchObject({ slides: 3, repairRounds: 1, failedChecks: ["duplicate_title"] });
      expect(ingested).toHaveLength(1);
    }
  });

  it("still cancels with 499 when the person leaves during the repair call", async () => {
    const controller = new AbortController();
    scripted.push(slidesJson(["Billing moves", "Support follows", "Billing moves"]), () => {
      controller.abort(new Error("client left"));
      throw new ApiError("upstream_error", "Gateway returned 502", 502);
    });
    const error = await refusal(
      generatePresentationOutline(tenant, { prompt: "Vendor switch deck" }, controller.signal),
    );
    expect(error).toMatchObject({ code: "aborted", status: 499 });
    expect(created).toHaveLength(0);
    expect(ingested).toHaveLength(0);
  });

  it("repairs a first answer that is not an outline, quoting it back and saying so", async () => {
    scripted.push("Sure! Here is your deck about the vendor switch.");
    answer = {
      text: slidesJson(["Billing moves", "Support follows", "Approve by Friday"]),
      model: "deepseek-v4-flash",
    };
    const outline = await generatePresentationOutline(tenant, { prompt: "Vendor switch deck" });
    expect(asked).toHaveLength(2);
    expect(String(asked[0]?.prompt)).not.toContain("Your previous outline:");
    expect(String(asked[1]?.prompt)).toContain(
      "Your previous outline:\nSure! Here is your deck about the vendor switch.",
    );
    expect(String(asked[1]?.prompt)).toContain(
      "ERROR: The reply was not a valid outline JSON: Model did not return a JSON presentation outline.",
    );
    expect(outline.slides.map((slide) => slide.heading)).toEqual([
      "Billing moves",
      "Support follows",
      "Approve by Friday",
    ]);
    expect(outline).not.toHaveProperty("checks");
    expect(created[0]?.meta).toMatchObject({ slides: 3, repairRounds: 1 });
    expect(created[0]?.meta).not.toHaveProperty("failedChecks");
  });

  it("repairs a first answer that is JSON but not an outline", async () => {
    scripted.push('{"title":"Vendor switch","slides":[]}');
    const outline = await generatePresentationOutline(tenant, { prompt: "Vendor switch deck" });
    expect(asked).toHaveLength(2);
    expect(String(asked[1]?.prompt)).toContain("ERROR: The reply was not a valid outline JSON: ");
    expect(outline.title).toBe("Vendor switch");
  });

  it("still answers 502 invalid_outline when the repair is not an outline either, and saves nothing", async () => {
    scripted.push("not json at all", "still not json");
    const error = await refusal(generatePresentationOutline(tenant, { prompt: "Vendor switch deck" }));
    expect(error).toMatchObject({ code: "invalid_outline", status: 502 });
    expect(asked).toHaveLength(2);
    expect(created).toHaveLength(0);
    expect(ingested).toHaveLength(0);
  });

  it("answers the first answer's own 502 invalid_outline when it is not an outline and the repair call fails", async () => {
    scripted.push("not json at all", new ApiError("upstream_error", "Gateway returned 502", 502));
    const error = await refusal(generatePresentationOutline(tenant, { prompt: "Vendor switch deck" }));
    expect(error).toMatchObject({ code: "invalid_outline", status: 502 });
    expect(asked).toHaveLength(2);
    expect(created).toHaveLength(0);
  });

  it("still fails an empty first answer without a repair", async () => {
    scripted.push("  ");
    const error = await refusal(generatePresentationOutline(tenant, { prompt: "Vendor switch deck" }));
    expect(error).toMatchObject({ code: "generation_failed", status: 502 });
    expect(asked).toHaveLength(1);
  });

  it("records the model that wrote the outline it returns, not the one that wrote the first try", async () => {
    scripted.push(slidesJson(["Billing moves", "Support follows", "Billing moves"]));
    answer = {
      text: slidesJson(["Billing moves", "Support follows", "Approve by Friday"]),
      model: "gpt-5.6-luna",
    };
    await generatePresentationOutline(tenant, { prompt: "Vendor switch deck", model: "deepseek-v4-flash" });
    expect(created[0]?.meta?.model).toBe("gpt-5.6-luna");
  });
});
