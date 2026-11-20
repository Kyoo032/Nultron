import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError, type ChatModel, type TenantContext } from "@agentforge/core";
import { AUTO_LIMITS } from "@agentforge/core/auto-choice";
import {
  ChoiceUnavailableError,
  readRunChoice,
  readThreadContext,
  resolveRunChoice,
  type RunChoiceInput,
} from "./choice-resolve";
import type { ModelAllowance } from "./model-allowance";
import { isJobModelDown, markJobModelDown, resetJobModelCircuit } from "./job-model-fallback";
import { saveModelCache } from "./model-cache";
import { resetCatalogMemo, type SelectableModel } from "./selectable-models";

const TENANT: TenantContext = {
  tenantId: "tenant-alpha",
  organizationId: "org-alpha",
  workspaceId: "workspace-alpha",
  userId: "user-alpha",
  role: "owner",
};

const OTHER_TENANT: TenantContext = {
  tenantId: "tenant-beta",
  organizationId: "org-beta",
  workspaceId: "workspace-beta",
  userId: "user-beta",
  role: "owner",
};

function chat(
  id: string,
  inputModalities: ChatModel["inputModalities"] = ["text"],
  provider: ChatModel["provider"] = "openai",
): ChatModel {
  return { id, label: id, provider, inputModalities };
}

function apiErrorOf(run: () => unknown): ApiError {
  try {
    run();
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected an ApiError");
}

function resolveWith(
  overrides: Partial<RunChoiceInput> & Pick<RunChoiceInput, "request">,
): ReturnType<typeof resolveRunChoice> {
  return resolveRunChoice({ tenant: TENANT, modality: "text", ...overrides });
}

function allowOnly(ids: readonly string[]): ModelAllowance {
  return { allows: (model: SelectableModel) => ids.includes(model.id) };
}

describe("readRunChoice reads the body's choice", () => {
  it("returns null when the body names no choice or tier, so the model path runs unchanged", () => {
    expect(readRunChoice(undefined)).toBeNull();
    expect(readRunChoice({ content: "hi" })).toBeNull();
    expect(readRunChoice({ model: "gpt-6-luna", modelPinned: true })).toBeNull();
    expect(readRunChoice({ choice: null, tier: null, model: "gpt-6-luna" })).toBeNull();
  });

  it("reads the three presets", () => {
    expect(readRunChoice({ choice: "auto" })).toEqual({ kind: "auto" });
    expect(readRunChoice({ choice: "everyday" })).toEqual({ kind: "everyday" });
    expect(readRunChoice({ choice: "reasoning" })).toEqual({ kind: "reasoning" });
  });

  it("reads a custom choice and trims its model id", () => {
    expect(readRunChoice({ choice: { kind: "custom", model: "  gpt-6-luna ", effort: "low" } })).toEqual({
      kind: "custom",
      model: "gpt-6-luna",
      effort: "low",
    });
  });

  it("refuses a custom choice without a model or with an unknown effort", () => {
    expect(apiErrorOf(() => readRunChoice({ choice: { kind: "custom", model: " ", effort: "low" } })).code).toBe(
      "custom_model_required",
    );
    expect(apiErrorOf(() => readRunChoice({ choice: "custom" })).code).toBe("custom_model_required");
    const effort = apiErrorOf(() =>
      readRunChoice({ choice: { kind: "custom", model: "gpt-6-luna", effort: "max" } }),
    );
    expect(effort.code).toBe("custom_effort_invalid");
    expect(effort.status).toBe(400);
  });

  it("refuses a choice that is not one of the four", () => {
    const unknown = apiErrorOf(() => readRunChoice({ choice: "turbo" }));
    expect(unknown.code).toBe("unknown_choice");
    expect(unknown.status).toBe(400);
    expect(apiErrorOf(() => readRunChoice({ choice: ["auto"] })).code).toBe("unknown_choice");
  });

  it("refuses a choice beside a tier or a model, and a tier beside a model", () => {
    expect(apiErrorOf(() => readRunChoice({ choice: "auto", model: "gpt-6-luna" })).code).toBe("choice_and_model");
    expect(apiErrorOf(() => readRunChoice({ choice: "auto", tier: "fast" })).code).toBe("choice_and_model");
    expect(apiErrorOf(() => readRunChoice({ tier: "fast", model: "gpt-6-luna" })).code).toBe("choice_and_model");
  });

  it("maps a legacy tier to its choice, and refuses a tier it does not know", () => {
    expect(readRunChoice({ tier: "daily" })).toEqual({ kind: "auto" });
    expect(readRunChoice({ tier: "fast" })).toEqual({ kind: "everyday" });
    expect(readRunChoice({ tier: "reasoning" })).toEqual({ kind: "reasoning" });
    const unknown = apiErrorOf(() => readRunChoice({ tier: "bogus" }));
    expect(unknown.code).toBe("unknown_choice");
    expect(unknown.status).toBe(400);
  });
});

describe("resolveRunChoice on the desk catalogue", () => {
  let cacheDir: string;
  let previousCachePath: string | undefined;
  let previousServer: string | undefined;

  function useDeskCache(openai: ChatModel[]): void {
    saveModelCache({ openai, anthropic: [chat("claude-sonnet-5", ["text"], "anthropic")] });
    resetCatalogMemo();
  }

  beforeEach(() => {
    previousCachePath = process.env.AGENTFORGE_MODELS_CACHE_PATH;
    previousServer = process.env.AGENTFORGE_SERVER;
    delete process.env.AGENTFORGE_SERVER;
    cacheDir = mkdtempSync(join(tmpdir(), "af-choice-resolve-"));
    process.env.AGENTFORGE_MODELS_CACHE_PATH = join(cacheDir, "models-cache.json");
    resetJobModelCircuit();
    useDeskCache([chat("gpt-6-luna"), chat("deepseek-v4-1-flash"), chat("deepseek-v4-pro"), chat("alpha-only-chat")]);
  });

  afterEach(() => {
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    };
    restore("AGENTFORGE_MODELS_CACHE_PATH", previousCachePath);
    restore("AGENTFORGE_SERVER", previousServer);
    resetJobModelCircuit();
    resetCatalogMemo();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("everyday runs the first live everyday candidate, with an explicit effort of none to medium", () => {
    const result = resolveWith({ request: { kind: "everyday" } });
    expect(result.requested).toBe("everyday");
    expect(result.ran).toBe("everyday");
    expect(result.model).toBe("deepseek-v4-1-flash");
    expect(["none", "low", "medium"]).toContain(result.reasoning.effort);
    expect(result.reasoning.explicit).toBe(true);
    expect(result.autoReason).toBeUndefined();
  });

  it("reasoning runs the live reasoning model at high", () => {
    expect(resolveWith({ request: { kind: "reasoning" } })).toEqual({
      requested: "reasoning",
      ran: "reasoning",
      model: "deepseek-v4-pro",
      reasoning: { effort: "high", explicit: true },
    });
  });

  it("reasoning with no live reasoning model is a 503 choice_unavailable that names the choice", () => {
    useDeskCache([chat("gpt-6-luna")]);
    const error = apiErrorOf(() => resolveWith({ request: { kind: "reasoning" } }));
    expect(error).toBeInstanceOf(ChoiceUnavailableError);
    expect(error.code).toBe("choice_unavailable");
    expect(error.status).toBe(503);
    expect((error as ChoiceUnavailableError).choice).toBe("reasoning");
  });

  it("everyday never falls onto a reasoning model when no everyday model is live", () => {
    useDeskCache([chat("deepseek-v4-pro")]);
    const error = apiErrorOf(() => resolveWith({ request: { kind: "everyday" } }));
    expect(error.code).toBe("choice_unavailable");
    expect((error as ChoiceUnavailableError).choice).toBe("everyday");
  });

  it("a model held down for one company is skipped for that company only", () => {
    const now = Date.now();
    markJobModelDown("deepseek-v4-1-flash", now, TENANT);
    expect(isJobModelDown("deepseek-v4-1-flash", now, TENANT)).toBe(true);
    expect(isJobModelDown("deepseek-v4-1-flash", now, OTHER_TENANT)).toBe(false);
    expect(isJobModelDown("deepseek-v4-1-flash", now)).toBe(false);

    expect(resolveWith({ request: { kind: "everyday" }, now }).model).toBe("gpt-6-luna");
    expect(resolveWith({ request: { kind: "everyday" }, tenant: OTHER_TENANT, now }).model).toBe(
      "deepseek-v4-1-flash",
    );
  });

  it("a custom model held down for one company is unavailable to that company and not to the other", () => {
    const now = Date.now();
    markJobModelDown("gpt-6-luna", now, TENANT);
    const error = apiErrorOf(() =>
      resolveWith({ request: { kind: "custom", model: "gpt-6-luna", effort: "default" }, now }),
    );
    expect(error.code).toBe("custom_model_unavailable");
    expect(error.status).toBe(503);
    expect(
      resolveWith({ request: { kind: "custom", model: "gpt-6-luna", effort: "default" }, tenant: OTHER_TENANT, now })
        .ran,
    ).toBe("custom");
  });

  it("the allowance seam decides which models a choice can reach", () => {
    expect(resolveWith({ request: { kind: "everyday" }, allowance: allowOnly(["gpt-6-luna"]) }).model).toBe(
      "gpt-6-luna",
    );
    expect(
      apiErrorOf(() => resolveWith({ request: { kind: "everyday" }, allowance: allowOnly(["alpha-only-chat"]) })).code,
    ).toBe("choice_unavailable");
    const outside = apiErrorOf(() =>
      resolveWith({
        request: { kind: "custom", model: "gpt-6-luna", effort: "default" },
        allowance: allowOnly(["deepseek-v4-1-flash"]),
      }),
    );
    expect(outside.code).toBe("custom_model_not_allowed");
    expect(outside.status).toBe(403);
  });

  it("auto picks everyday for plain typed text and says why", () => {
    expect(resolveWith({ request: { kind: "auto" }, currentText: "hello there" })).toEqual({
      requested: "auto",
      ran: "everyday",
      model: "deepseek-v4-1-flash",
      reasoning: expect.objectContaining({ explicit: true }),
      autoReason: "default",
    });
  });

  it("auto picks reasoning for a wording cue in English or Bahasa Indonesia", () => {
    const english = resolveWith({ request: { kind: "auto" }, currentText: "Please analyze the churn numbers" });
    expect(english).toMatchObject({ ran: "reasoning", model: "deepseek-v4-pro", autoReason: "wording_cue" });
    const indonesian = resolveWith({ request: { kind: "auto" }, currentText: "tolong bandingkan dua vendor ini" });
    expect(indonesian).toMatchObject({ ran: "reasoning", autoReason: "wording_cue" });
  });

  it("auto picks reasoning for an attached file, and the file's text does not pick the reason", () => {
    const attached = resolveWith({
      request: { kind: "auto" },
      currentText: "summarise this\n\n--- notes.txt ---\nanalyze the quarterly figures",
    });
    expect(attached).toMatchObject({ ran: "reasoning", autoReason: "attachment" });
  });

  it("auto counts a picture or video as an attachment, and needs a model that reads that modality", () => {
    useDeskCache([chat("deepseek-v4-pro", ["text", "image"]), chat("gpt-6-luna")]);
    expect(resolveWith({ request: { kind: "auto" }, modality: "image", currentText: "what is this" })).toMatchObject({
      ran: "reasoning",
      model: "deepseek-v4-pro",
      autoReason: "attachment",
    });
    useDeskCache([chat("gpt-6-luna"), chat("deepseek-v4-pro")]);
    const error = apiErrorOf(() =>
      resolveWith({ request: { kind: "auto" }, modality: "image", currentText: "what is this" }),
    );
    expect(error.code).toBe("choice_unavailable");
  });

  it("auto picks reasoning when the earlier conversation is long", () => {
    const history = {
      texts: ["x".repeat(AUTO_LIMITS.LONG_CONTEXT_TOKENS * AUTO_LIMITS.CHARS_PER_TOKEN)],
      imageCount: 0,
    };
    expect(resolveWith({ request: { kind: "auto" }, currentText: "hi", history })).toMatchObject({
      ran: "reasoning",
      autoReason: "long_context",
    });
  });

  it("auto crosses over to the other kind when its pick has no live model, and says so", () => {
    useDeskCache([chat("gpt-6-luna")]);
    const result = resolveWith({ request: { kind: "auto" }, currentText: "analyze this" });
    expect(result).toMatchObject({
      requested: "auto",
      ran: "everyday",
      model: "gpt-6-luna",
      autoReason: "pick_unavailable",
    });
    expect(result.reasoning.explicit).toBe(true);
  });

  it("auto is a 503 choice_unavailable when neither kind has a live model", () => {
    useDeskCache([chat("alpha-only-chat")]);
    const error = apiErrorOf(() => resolveWith({ request: { kind: "auto" }, currentText: "hello" }));
    expect(error.code).toBe("choice_unavailable");
    expect((error as ChoiceUnavailableError).choice).toBe("auto");
  });

  it("custom runs the named model under its catalogue spelling, and default effort is not explicit", () => {
    expect(resolveWith({ request: { kind: "custom", model: "GPT-6-LUNA", effort: "default" } })).toEqual({
      requested: "custom",
      ran: "custom",
      model: "gpt-6-luna",
      reasoning: { effort: "medium", explicit: false },
    });
  });

  it("custom refuses a model that is not in the catalogue", () => {
    const error = apiErrorOf(() =>
      resolveWith({ request: { kind: "custom", model: "no-such-model", effort: "default" } }),
    );
    expect(error.code).toBe("custom_model_not_allowed");
    expect(error.status).toBe(403);
  });

  it("custom refuses an effort the model does not take", () => {
    const error = apiErrorOf(() =>
      resolveWith({ request: { kind: "custom", model: "alpha-only-chat", effort: "low" } }),
    );
    expect(error.code).toBe("custom_effort_invalid");
    expect(error.status).toBe(400);
  });
});

describe("readThreadContext reads the stored conversation", () => {
  afterAll(async () => {
    const { sql } = await import("@agentforge/db");
    sql.close();
  });

  it("returns the stored text of each turn and counts the picture and video parts", async () => {
    const { agentService, getTenant } = await import("./tenant");
    const { createThread, insertMessage } = await import("./threads");
    const tenant = await getTenant();
    const ready = await agentService.ensureDefaultChat(tenant);
    const thread = await createThread(tenant, ready.agent.id, "Context probe");
    await insertMessage(tenant, thread.id, "user", [{ type: "text", text: "first question" }]);
    await insertMessage(tenant, thread.id, "assistant", [
      { type: "text", text: "first answer" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
    expect(await readThreadContext(tenant, thread.id)).toEqual({
      texts: ["first question", "first answer"],
      imageCount: 1,
    });
  });

  it("is empty for a thread with no messages", async () => {
    const { agentService, getTenant } = await import("./tenant");
    const { createThread } = await import("./threads");
    const tenant = await getTenant();
    const ready = await agentService.ensureDefaultChat(tenant);
    const thread = await createThread(tenant, ready.agent.id, "Empty probe");
    expect(await readThreadContext(tenant, thread.id)).toEqual({ texts: [], imageCount: 0 });
  });
});
