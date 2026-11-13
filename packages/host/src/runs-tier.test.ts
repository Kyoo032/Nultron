import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, InputModality } from "@agentforge/core";
import { GATEWAY_PROVIDER_ID } from "@agentforge/core";
import { MODEL_TIERS, TIER_DEFINITIONS, type ModelTierId } from "@agentforge/core/tiers";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";
import { markJobModelDown, resetJobModelCircuit } from "./job-model-fallback";
import type { SelectableModel } from "./selectable-models";
import type { HostRequest, HostResult } from "./types";

/**
 * `POST /threads/:id/runs/{text,image,video}` with a `tier` (chat-first plan, track M1). The router is
 * real; the runtime is a stub that records what it was asked, and the catalog the host reads is the one
 * each test sets, so a tier resolves against exactly the models the test lists.
 */

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-runs-tier-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "c".repeat(64);
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;

type ExecuteInput = Parameters<AgentRuntime["execute"]>[0];
const executed: ExecuteInput[] = [];

const state = vi.hoisted(() => ({ catalog: [] as SelectableModel[] }));

vi.mock("@agentforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentforge/core")>();
  return {
    ...actual,
    createRuntime: (): AgentRuntime => ({
      async execute(input) {
        executed.push(input);
        await input.onEvent({ type: "assistant.delta", text: "hello" });
        await input.onEvent({ type: "run.completed", runId: input.runId });
      },
    }),
  };
});

vi.mock("./selectable-models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./selectable-models")>();
  return { ...actual, listSelectableModels: () => state.catalog };
});

const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TEXT: InputModality[] = ["text"];
const TEXT_IMAGE: InputModality[] = ["text", "image"];
const ALL: InputModality[] = ["text", "image", "video"];

function row(id: string, inputModalities: InputModality[] = TEXT): SelectableModel {
  return {
    id,
    label: id,
    provider: "openai",
    inputModalities,
    friendlyLabel: `Friendly ${id}`,
    bestFor: "Fast drafts",
    tier: "everyday",
  };
}

function candidates(tier: ModelTierId): readonly string[] {
  return TIER_DEFINITIONS[tier].candidates[GATEWAY_PROVIDER_ID] ?? [];
}

/** Every gateway candidate of every tier, text only unless `modalities` says more. */
function fullCatalog(modalities: InputModality[] = TEXT): SelectableModel[] {
  return [...new Set(MODEL_TIERS.flatMap((tier) => candidates(tier)))].map((id) => row(id, modalities));
}

let dispatch: (request: HostRequest) => Promise<HostResult>;
let threadId = "";
let chatAgentId = "";

function request(method: string, path: string, extra: Partial<HostRequest> = {}): HostRequest {
  return { method, path, query: {}, params: {}, headers: {}, ...extra };
}

type Route = "text" | "image" | "video";

async function send(
  body: Record<string, unknown>,
  route: Route = "text",
  thread: string = threadId,
): Promise<HostResult> {
  return dispatch(request("POST", `/api/v1/threads/${thread}/runs/${route}`, { params: { threadId: thread }, body }));
}

/** Post a run that must start, and drain it: the run only finishes once its frames have been read. */
async function postRun(
  body: Record<string, unknown>,
  route: Route = "text",
  thread: string = threadId,
): Promise<void> {
  const result = await send(body, route, thread);
  if (result.type !== "stream") {
    throw new Error(`expected a stream, got ${result.type}: ${JSON.stringify((result as { body?: unknown }).body)}`);
  }
  for await (const _frame of result.events) {
    // Drain.
  }
}

/** Post a run that must be refused, and return the flat answer. */
async function refused(
  body: Record<string, unknown>,
  route: Route = "text",
): Promise<{ status: number; error: { code: string; message: string } }> {
  const result = await send(body, route);
  if (result.type !== "json") {
    throw new Error(`expected a refusal, got ${result.type}`);
  }
  return { status: result.status, error: (result.body as { error: { code: string; message: string } }).error };
}

function imageBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    content: [
      { type: "text", text: "what is this" },
      { type: "image_url", image_url: { url: TINY_PNG } },
    ],
    ...extra,
  };
}

function videoBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    content: [
      { type: "text", text: "what is this" },
      { type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA" } },
    ],
    ...extra,
  };
}

async function newThread(): Promise<string> {
  const created = await json<{ thread: { id: string } }>("POST", "/api/v1/threads", { agentId: chatAgentId });
  return created.thread.id;
}

async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
  const result = await dispatch(request(method, path, { body }));
  if (result.type !== "json") {
    throw new Error(`expected json, got ${result.type}`);
  }
  return (result.body ?? {}) as T;
}

beforeAll(async () => {
  state.catalog = fullCatalog();
  ({ dispatch } = await import("./router"));
  // The first visit creates the local owner and the default chat agent, like opening Chat does.
  const chat = await json<{ agent: { id: string } }>("GET", "/api/v1/chat");
  chatAgentId = chat.agent.id;
  threadId = await newThread();
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(() => {
  executed.length = 0;
  state.catalog = fullCatalog();
});

afterEach(() => {
  resetJobModelCircuit();
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("a tier together with a model, or a tier that is not one", () => {
  it("refuses a model beside a tier with 400 tier_and_model, and starts no run", async () => {
    const answer = await refused({ content: "hello", tier: "daily", model: candidates("daily")[0] });
    expect(answer.status).toBe(400);
    expect(answer.error.code).toBe("tier_and_model");
    expect(executed).toHaveLength(0);
  });

  it("checks the model rule before the tier's name", async () => {
    const answer = await refused({ content: "hello", tier: "turbo", model: "gpt-6-luna" });
    expect(answer.error.code).toBe("tier_and_model");
  });

  it("does not count a blank model as a model", async () => {
    await postRun({ content: "hello", tier: "fast", model: "  " });
    expect(executed).toHaveLength(1);
  });

  it("refuses a name that is not a tier with 400 unknown_tier, never defaulting it", async () => {
    for (const tier of ["turbo", "Daily", "", 7, true, {}]) {
      const answer = await refused({ content: "hello", tier });
      expect(answer.status, JSON.stringify(tier)).toBe(400);
      expect(answer.error.code, JSON.stringify(tier)).toBe("unknown_tier");
    }
    expect(executed).toHaveLength(0);
  });
});

describe("a tier with no live candidate", () => {
  it("answers 503 tier_unavailable, and the answer names no model", async () => {
    state.catalog = [row("acme-chat-000")];
    const answer = await refused({ content: "hello", tier: "reasoning" });
    expect(answer.status).toBe(503);
    expect(answer.error.code).toBe("tier_unavailable");
    for (const id of [...candidates("reasoning"), "acme-chat-000"]) {
      expect(JSON.stringify(answer)).not.toContain(id);
    }
    expect(executed).toHaveLength(0);
  });

  it("does not fall to another tier or to the default model", async () => {
    // Only Daily and Fast are listed. Reasoning must not borrow one of them.
    state.catalog = [row(candidates("daily")[0] as string), row(candidates("fast")[0] as string)];
    expect((await refused({ content: "hello", tier: "reasoning" })).error.code).toBe("tier_unavailable");
    expect(executed).toHaveLength(0);
  });

  it("answers 503 when every candidate of the tier is held down", async () => {
    for (const id of candidates("fast")) {
      markJobModelDown(id);
    }
    expect((await refused({ content: "hello", tier: "fast" })).status).toBe(503);
  });
});

describe("a tier that resolves", () => {
  it.each(MODEL_TIERS)("runs the head of %s", async (tier) => {
    await postRun({ content: "hello", tier });
    expect(executed).toHaveLength(1);
    expect(executed[0]?.version.model).toBe(candidates(tier)[0]);
  });

  it("runs the catalog's spelling of the model", async () => {
    const head = candidates("fast")[0] as string;
    state.catalog = [row("acme-chat-000"), row(head.toUpperCase())];
    await postRun({ content: "hello", tier: "fast" });
    expect(executed[0]?.version.model).toBe(head.toUpperCase());
    expect(executed[0]?.thinking).toBe(false);
  });

  it("skips a model the breaker holds down, and the next one too", async () => {
    // Held down, the first two of Fast's list: the run lands on the third, not on the default model
    // (which is the second, `gpt-6-luna`, so one held-down model would not tell the two apart).
    const [first, second, third] = candidates("fast") as [string, string, string];
    markJobModelDown(first);
    markJobModelDown(second);
    await postRun({ content: "hello", tier: "fast" });
    expect(executed[0]?.version.model).toBe(third);
  });

  it("maps Fast to Thinking off, as a choice", async () => {
    await postRun({ content: "hello", tier: "fast" });
    expect(executed[0]?.reasoningEffort).toBe("none");
    expect(executed[0]?.reasoningEffortExplicit).toBe(true);
    expect(executed[0]?.thinking).toBe(false);
  });

  it("maps Reasoning to the deep level, as a choice", async () => {
    await postRun({ content: "hello", tier: "reasoning" });
    expect(executed[0]?.reasoningEffort).toBe("high");
    expect(executed[0]?.reasoningEffortExplicit).toBe(true);
    expect(executed[0]?.thinking).toBe(true);
  });

  it("maps Daily to the model's own default, not a choice", async () => {
    await postRun({ content: "hello", tier: "daily" });
    expect(executed[0]?.reasoningEffort).toBe("medium");
    expect(executed[0]?.reasoningEffortExplicit).toBe(false);
    expect(executed[0]?.thinking).toBe(true);
  });

  it("ignores thinking and reasoningEffort in the body, including a malformed one", async () => {
    await postRun({ content: "hello", tier: "reasoning", thinking: false, reasoningEffort: "low" });
    expect(executed[0]?.reasoningEffort).toBe("high");
    expect(executed[0]?.thinking).toBe(true);
    await postRun({ content: "hello", tier: "fast", thinking: true, reasoningEffort: "xhigh" });
    expect(executed[1]?.reasoningEffort).toBe("none");
    expect(executed[1]?.thinking).toBe(false);
    // Not a level at all: without a tier this is a 400, with one it is never read.
    await postRun({ content: "hello", tier: "daily", reasoningEffort: { not: "a level" } });
    expect(executed[2]?.reasoningEffort).toBe("medium");
    expect(executed[2]?.reasoningEffortExplicit).toBe(false);
  });
});

describe("a request without a tier is handled as before", () => {
  it("uses the default model and the defaulted Thinking level when the body names no tier", async () => {
    await postRun({ content: "hello" });
    const defaultModel = executed[0]?.version.model;
    expect(defaultModel).toBe("gpt-6-luna");
    expect(executed[0]?.reasoningEffort).toBe("medium");
    expect(executed[0]?.reasoningEffortExplicit).toBe(false);
    // A tier of Fast would have chosen another model and turned Thinking off.
    expect(defaultModel).not.toBe(candidates("fast")[0]);
    expect(executed[0]?.thinking).toBe(true);
  });

  it("treats a null tier as no tier", async () => {
    await postRun({ content: "hello", tier: null });
    expect(executed[0]?.version.model).toBe("gpt-6-luna");
    expect(executed[0]?.reasoningEffortExplicit).toBe(false);
  });

  it("still pins a model the body names, and still reads the Thinking level", async () => {
    const pinned = candidates("reasoning")[1] as string;
    await postRun({ content: "hello", model: pinned, reasoningEffort: "xhigh" });
    expect(executed[0]?.version.model).toBe(pinned);
    expect(executed[0]?.reasoningEffort).toBe("xhigh");
    expect(executed[0]?.reasoningEffortExplicit).toBe(true);
  });

  it("still refuses a Thinking level that is not one", async () => {
    const answer = await refused({ content: "hello", reasoningEffort: { not: "a level" } });
    expect(answer.status).toBe(400);
    expect(answer.error.code).toBe("invalid_request");
  });

  it("still refuses a model the catalog does not list", async () => {
    const answer = await refused({ content: "hello", model: "not-in-the-catalog" });
    expect(answer.error.code).toBe("unknown_model");
  });
});

describe("a tier on the image and video routes", () => {
  it("resolves an image run to a model that takes images", async () => {
    // The head takes text only and the second takes images (`claude-*` does, `gpt-6-*` does not).
    const [head, second] = candidates("daily") as [string, string];
    state.catalog = [row(head, TEXT), row(second, TEXT_IMAGE)];
    await postRun(imageBody({ tier: "daily" }), "image");
    expect(executed).toHaveLength(1);
    expect(executed[0]?.modality).toBe("image");
    expect(executed[0]?.version.model).toBe(second);
  });

  it("resolves the same tier to the head when the run is text", async () => {
    const [head, second] = candidates("daily") as [string, string];
    state.catalog = [row(head, TEXT), row(second, TEXT_IMAGE)];
    // A thread of its own: the shared one holds the picture of the test above, and a follow-up in it would
    // replay that picture (the next describe covers that case).
    await postRun({ content: "hello", tier: "daily" }, "text", await newThread());
    expect(executed[0]?.version.model).toBe(head);
  });

  it("answers 503 for an image run when no listed candidate takes images", async () => {
    state.catalog = [row(candidates("daily")[0] as string, TEXT)];
    const answer = await refused(imageBody({ tier: "daily" }), "image");
    expect(answer.status).toBe(503);
    expect(answer.error.code).toBe("tier_unavailable");
  });

  it("resolves a video run to a model that takes video", async () => {
    const watcher = candidates("daily").find((id) => id.startsWith("gemini"));
    expect(watcher, "the Daily list has a Gemini model, which the capability table says watches video").toBeTruthy();
    state.catalog = [row(candidates("daily")[0] as string, TEXT), row(watcher as string, ALL)];
    await postRun(videoBody({ tier: "daily" }), "video");
    expect(executed[0]?.modality).toBe("video");
    expect(executed[0]?.version.model).toBe(watcher);
  });

  it("refuses a model beside a tier on these routes too", async () => {
    const answer = await refused(imageBody({ tier: "daily", model: "gpt-6-luna" }), "image");
    expect(answer.error.code).toBe("tier_and_model");
  });
});

describe("a tier on a turn that carries a picture", () => {
  // The Luna models read a picture and misreported it (measured 2026-11-13, `PICTURE_MISREADS`), so a tier
  // tries them after every other candidate. Every row here lists images, so only the demotion decides.
  const LUNA = "gpt-6-luna";
  // A picture stays in its thread and is replayed on later turns, so each test starts on a thread of its own.
  let thread = "";

  beforeEach(async () => {
    state.catalog = fullCatalog(TEXT_IMAGE);
    thread = await newThread();
  });

  it("sends a picture on Daily to claude-sonnet-5-5, where a text turn still goes to gpt-6-luna", async () => {
    expect(candidates("daily")[0]).toBe(LUNA);
    await postRun(imageBody({ tier: "daily" }), "image", thread);
    expect(executed[0]?.modality).toBe("image");
    expect(executed[0]?.version.model).toBe("claude-sonnet-5-5");
    // The tier's Thinking is the tier's, whichever model answers.
    expect(executed[0]?.reasoningEffort).toBe("medium");
    expect(executed[0]?.reasoningEffortExplicit).toBe(false);
    // The same words on a thread that holds no picture.
    await postRun({ content: "hello", tier: "daily" }, "text", await newThread());
    expect(executed[1]?.version.model).toBe(LUNA);
  });

  it("keeps Fastest on its head and Reasoning on its own for a picture", async () => {
    await postRun(imageBody({ tier: "fast" }), "image", thread);
    await postRun(imageBody({ tier: "reasoning" }), "image", thread);
    expect(executed.map((input) => input.version.model)).toEqual(["deepseek-v4-1-flash", "claude-opus-5-5"]);
    expect(executed[0]?.reasoningEffort).toBe("none");
    expect(executed[1]?.reasoningEffort).toBe("high");
  });

  it("still answers when the only live models of the tier are the marked ones", async () => {
    state.catalog = [row(LUNA, TEXT_IMAGE), row("gpt-5.6-luna", TEXT_IMAGE)];
    await postRun(imageBody({ tier: "daily" }), "image", thread);
    await postRun(imageBody({ tier: "fast" }), "image", thread);
    expect(executed.map((input) => input.version.model)).toEqual([LUNA, LUNA]);
  });

  it("accepts a marked model that the person names with a picture", async () => {
    await postRun(imageBody({ model: LUNA }), "image", thread);
    await postRun(imageBody({ model: "gpt-5.6-luna" }), "image", thread);
    expect(executed.map((input) => input.version.model)).toEqual([LUNA, "gpt-5.6-luna"]);
  });

  it("gives a text follow-up in a thread that holds a picture the same demotion, because the replay sends it", async () => {
    await postRun(imageBody({ tier: "daily" }), "image", thread);
    await postRun({ content: "and the right half?", tier: "daily" }, "text", thread);
    await postRun({ content: "and the right half?", tier: "fast" }, "text", thread);
    await postRun({ content: "and the right half?", tier: "reasoning" }, "text", thread);
    expect(executed.map((input) => input.version.model)).toEqual([
      "claude-sonnet-5-5",
      "claude-sonnet-5-5",
      "deepseek-v4-1-flash",
      "claude-opus-5-5",
    ]);
    // The follow-up's history really carries the picture to the model.
    const history = executed[1]?.history ?? [];
    expect(JSON.stringify(history)).toContain("image_url");
  });

  it("leaves a text turn in a thread with no picture on gpt-6-luna", async () => {
    await postRun({ content: "hello", tier: "daily" }, "text", thread);
    await postRun({ content: "hello again", tier: "daily" }, "text", thread);
    expect(executed.map((input) => input.version.model)).toEqual([LUNA, LUNA]);
  });

  it("keeps an explicit model on a follow-up in a thread that holds a picture", async () => {
    await postRun(imageBody({ tier: "daily" }), "image", thread);
    await postRun({ content: "and the right half?", model: LUNA }, "text", thread);
    expect(executed[1]?.version.model).toBe(LUNA);
  });

  it("does not change the tiers the catalog reports: Daily still takes pictures", async () => {
    const chat = await json<{ tiers: { id: string; available: boolean; inputModalities: string[] }[] }>(
      "GET",
      "/api/v1/chat",
    );
    const daily = chat.tiers.find((tier) => tier.id === "daily");
    expect(daily?.available).toBe(true);
    expect(daily?.inputModalities).toContain("image");
  });
});
