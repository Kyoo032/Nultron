/**
 * What a key can actually use (2026-11-11): the pickers show the models that work, the catalogue keeps
 * the rest, and a refusal from a real call is learned per key.
 *
 * The data is what the prepaid agent key was told that day: the list carried `grok-imagine-video`,
 * `kling-v3` and `veo_3_1-fast`, and every one was refused when called. Nothing here calls the gateway;
 * `fetch` is a stub that answers the two free reads (the key's model list and the public price list).
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GatewayRefusalError,
  LOCAL_TENANT_ID,
  type ChatModel,
  type ModelOutcomeReport,
  type TenantContext,
} from "@agentforge/core";
import { transcriptionCandidates } from "@agentforge/core/meeting";
import {
  dropRefusedIds,
  forgetLessons,
  learnFromOutcome,
  refusedModelIds,
  resetAvailabilityMemo,
  standingsOfCache,
} from "./model-availability";
import { modelAvailabilityBody } from "./model-availability-payload";
import { loadModelCache } from "./model-cache";
import {
  listImageModels,
  listMusicModels,
  listProbedVideoModels,
  listSpeechModels,
  modeCatalogPayload,
  refreshModelCache,
  resetCatalogMemo,
} from "./selectable-models";
import { cachedModelIds } from "./meeting/transcribe";
import { loadSettings, saveSettings } from "./settings-store";
import {
  defaultStudioVideoModel,
  listStudioMusicModels,
  listStudioVideoModels,
  studioMusicPicker,
  studioSpeechUnavailable,
} from "./studio-generate";

const KEY_A = "sk-test-key-a-0123456789abcdef";
const KEY_B = "sk-test-key-b-fedcba9876543210";

const tenant: TenantContext = {
  tenantId: LOCAL_TENANT_ID,
  organizationId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  role: "owner",
};

/** The ids the prepaid key listed on 2026-11-11 that matter here, as the probe would have read them. */
const LISTED = [
  "gpt-5.6-luna",
  "gpt-image-2",
  "seedance-2.0",
  "seedance-2.0-fast",
  "seedance-2.5",
  "grok-imagine-video",
  "kling-v3",
  "veo_3_1-fast",
  "qwen3.5-omni-flash",
  "qwen3.5-omni-flash-realtime",
  "muse-voice-transcribe-1.0",
  "gemini-3.5-flash",
];

const PRICING = {
  data: [
    { model_name: "gpt-image-2", supported_endpoint_types: ["image-generation", "openai"] },
    { model_name: "seedance-2.0-fast", supported_endpoint_types: ["openai-video", "seedance2-native-video"] },
    // Not on the key, and a name no regex here knows: the price list says what it is.
    { model_name: "lumen-art-3", supported_endpoint_types: ["image-generation"] },
  ],
};

/** The two free reads, and a 404 for everything else (the models.dev registry refresh swallows that). */
function stubGateway(ids: readonly string[] = LISTED): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/v1/models")) {
      return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
    }
    if (url.endsWith("/api/pricing")) {
      return new Response(JSON.stringify(PRICING), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function refusal(status: number, code: string | undefined, message: string): unknown {
  return new GatewayRefusalError("tool_failed", message, status, { status, ...(code ? { code } : {}), message });
}

function report(
  model: string,
  kind: "video" | "image" | "speech" | "music" | "transcription",
  error?: unknown,
): ModelOutcomeReport {
  return error === undefined ? { tenant, model, kind, ok: true } : { tenant, model, kind, ok: false, error };
}

/** The three refusals of that day, learned the way the tools report them. */
function learnTheDaysRefusals(): void {
  learnFromOutcome(
    report("grok-imagine-video", "video", refusal(403, "prepaid_async_requires_fixed_price", "prepaid")),
  );
  learnFromOutcome(report("kling-v3", "video", refusal(503, undefined, "no available configurable resource channel")));
  learnFromOutcome(report("veo_3_1-fast", "video", refusal(403, "bad_response_status_code", "upstream")));
}

const ids = (models: ChatModel[]) => models.map((model) => model.id);

async function freshDeskWithKey(key: string): Promise<void> {
  saveSettings({ openaiApiKey: key }, tenant);
  await refreshModelCache(loadSettings(tenant), { scope: tenant });
  resetCatalogMemo();
  resetAvailabilityMemo();
}

beforeEach(() => {
  // Each test starts from a desk that has learned nothing: the cache file is where lessons live.
  rmSync(cachePath(), { force: true });
  resetCatalogMemo();
  resetAvailabilityMemo();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// First on purpose: the desk has no key yet, and every later block saves one.
describe("a desk with no key", () => {
  it("learns nothing and filters nothing", () => {
    vi.stubGlobal("fetch", vi.fn());
    expect(learnFromOutcome(report("kling-v3", "video", refusal(503, undefined, "no available channel")))).toBe(false);
    expect(refusedModelIds(tenant).size).toBe(0);
    expect(existsSync(cachePath()) ? loadModelCache(tenant).availability : undefined).toBeUndefined();
  });
});

describe("a refusal from a real call", () => {
  beforeEach(async () => {
    stubGateway();
    await freshDeskWithKey(KEY_A);
  });

  it("starts with every listed model offered (nothing has said otherwise)", () => {
    expect(ids(listProbedVideoModels(undefined, tenant))).toEqual(
      expect.arrayContaining(["seedance-2.0-fast", "grok-imagine-video", "kling-v3", "veo_3_1-fast"]),
    );
  });

  it("hides the refused models from the video picker and keeps the one that works", () => {
    learnTheDaysRefusals();
    const video = ids(listProbedVideoModels(undefined, tenant));
    expect(video).not.toContain("grok-imagine-video");
    expect(video).not.toContain("kling-v3");
    expect(video).not.toContain("veo_3_1-fast");
    expect(video).toContain("seedance-2.0-fast");
    expect(ids(modeCatalogPayload(undefined, tenant).modes.video)).toEqual(
      expect.arrayContaining(["seedance-2.0-fast"]),
    );
    expect(ids(modeCatalogPayload(undefined, tenant).modes.video)).not.toContain("kling-v3");
  });

  it("moves the defaults to the first model left, kind by kind", () => {
    learnTheDaysRefusals();
    const { defaults } = modeCatalogPayload(undefined, tenant);
    expect(defaults.video).toBe("seedance-2.0-fast");
    expect(defaults.image).toBe("gpt-image-2");
  });

  it("leaves every music entry point with nothing once the relay refuses, so the studio can say so", () => {
    expect(ids(listMusicModels(tenant))).toEqual(["suno_music"]);
    const offered = studioMusicPicker(listStudioMusicModels(undefined, tenant), "suno_music", tenant);
    expect(ids(offered.models)).toEqual(["suno_music"]);
    expect(offered.defaultModel).toBe("suno_music");

    learnFromOutcome(report("suno_music", "music", refusal(400, "model_not_found", "suno_music")));
    expect(listMusicModels(tenant)).toEqual([]);
    expect(modeCatalogPayload(undefined, tenant).modes.music).toEqual([]);
    expect(modelAvailabilityBody(tenant).kinds.music).toEqual({ offered: 0 });

    // The page's own list and the id its select seeds: both empty, so Generate is disabled with a reason.
    const refused = studioMusicPicker(listStudioMusicModels(undefined, tenant), "suno_music", tenant);
    expect(refused.models).toEqual([]);
    expect(refused.defaultModel).toBe("");
  });

  it("works again as soon as the kind has a model, so the empty state is availability and not a dead page", () => {
    const empty = studioMusicPicker([], "suno_music", tenant);
    // An empty catalog with nothing refused still offers the relay model: the key never said no to it.
    expect(ids(empty.models)).toEqual(["suno_music"]);
    expect(empty.defaultModel).toBe("suno_music");
  });

  it("answers the Music page with nothing to pick once the relay refuses", async () => {
    // The page reads this answer, so the fix has to land here and not only in the list helpers.
    const { handleGetMusic } = await import("./handlers/jobs");
    learnFromOutcome(report("suno_music", "music", refusal(400, "model_not_found", "suno_music")));
    resetAvailabilityMemo();
    const result = await handleGetMusic({
      method: "GET",
      path: "/api/v1/music",
      query: {},
      params: {},
      headers: {},
    });
    if (result.type !== "json") {
      throw new Error(`expected json, got ${result.type}`);
    }
    const body = result.body as { models: Array<{ id: string }>; defaultModel: string };
    expect(body.models).toEqual([]);
    expect(body.defaultModel).toBe("");
  });

  it("leaves the video page with no model when every video id was refused", () => {
    learnTheDaysRefusals();
    for (const id of ["seedance-2.0-fast", "seedance-2.0", "seedance-2.5"]) {
      learnFromOutcome(report(id, "video", refusal(503, "model_not_found", "no channel")));
    }
    resetAvailabilityMemo();
    expect(listStudioVideoModels(undefined, tenant)).toEqual([]);
    expect(defaultStudioVideoModel(undefined, tenant)).toBe("");
    expect(modelAvailabilityBody(tenant).kinds.video).toEqual({ offered: 0 });
  });

  it("learns nothing from a job that failed after the gateway accepted it", () => {
    const before = readFileSync(cachePath(), "utf8");
    const polled = new GatewayRefusalError("tool_failed", "may be related to copyright restrictions", 502, {
      status: 200,
      message: "may be related to copyright restrictions",
      phase: "poll",
    });
    expect(learnFromOutcome(report("seedance-2.0-fast", "video", polled))).toBe(false);
    expect(readFileSync(cachePath(), "utf8")).toBe(before);
    expect(refusedModelIds(tenant).size).toBe(0);
    expect(ids(listProbedVideoModels(undefined, tenant))).toContain("seedance-2.0-fast");
  });

  it("still files a prepaid refusal at submit time as account_blocked", () => {
    expect(
      learnFromOutcome(
        report("grok-imagine-video", "video", refusal(403, "prepaid_async_requires_fixed_price", "prepaid")),
      ),
    ).toBe(true);
    resetAvailabilityMemo();
    expect(refusedModelIds(tenant).has("grok-imagine-video")).toBe(true);
    expect(ids(listProbedVideoModels(undefined, tenant))).not.toContain("grok-imagine-video");
  });

  it("speaks through Omni, and stops offering it once the chat stream is refused", () => {
    expect(ids(listSpeechModels(tenant))).toEqual(["qwen3.5-omni-flash"]);
    expect(studioSpeechUnavailable(undefined, tenant)).toBeNull();
    learnFromOutcome(report("qwen3.5-omni-flash", "speech", refusal(503, "model_not_found", "no channel")));
    expect(listSpeechModels(tenant)).toEqual([]);
    // The catalogue still has the model; this key cannot use it, so the page says that, not "no model".
    expect(studioSpeechUnavailable(undefined, tenant)).toBe("none_on_key");
  });

  it("drops a refused recogniser from the transcription chain, leaving the next", () => {
    expect(transcriptionCandidates(cachedModelIds(tenant))[0]).toBe("muse-voice-transcribe-1.0");
    learnFromOutcome(report("muse-voice-transcribe-1.0", "transcription", refusal(400, "model_not_found", "x")));
    const chain = transcriptionCandidates(cachedModelIds(tenant));
    expect(chain).not.toContain("muse-voice-transcribe-1.0");
    expect(chain[0]).toBe("gemini-3.5-flash");
    expect(dropRefusedIds(["muse-voice-transcribe-1.0", "gemini-3.5-flash"], tenant)).toEqual(["gemini-3.5-flash"]);
  });

  it("learns nothing from a refusal that says nothing about the model", () => {
    const before = readFileSync(cachePath(), "utf8");
    expect(learnFromOutcome(report("kling-v3", "video", refusal(401, undefined, "Invalid token")))).toBe(false);
    expect(learnFromOutcome(report("kling-v3", "video", refusal(429, undefined, "slow down")))).toBe(false);
    expect(learnFromOutcome(report("kling-v3", "video", new Error("socket hang up")))).toBe(false);
    expect(readFileSync(cachePath(), "utf8")).toBe(before);
  });

  it("lets a later success clear the refusal", () => {
    learnFromOutcome(report("kling-v3", "video", refusal(503, undefined, "no available channel")));
    expect(refusedModelIds(tenant).has("kling-v3")).toBe(true);
    learnFromOutcome(report("kling-v3", "video"));
    resetAvailabilityMemo();
    expect(refusedModelIds(tenant).has("kling-v3")).toBe(false);
    expect(ids(listProbedVideoModels(undefined, tenant))).toContain("kling-v3");
  });

  it("does not rewrite the cache for a success it already knows about", () => {
    learnFromOutcome(report("seedance-2.0-fast", "video"));
    const written = readFileSync(cachePath(), "utf8");
    expect(learnFromOutcome(report("seedance-2.0-fast", "video"))).toBe(false);
    expect(readFileSync(cachePath(), "utf8")).toBe(written);
  });

  it("forgets everything learned for the key when the person presses Refresh", async () => {
    learnTheDaysRefusals();
    expect(refusedModelIds(tenant).size).toBe(3);
    const cache = forgetLessons(loadModelCache(tenant));
    expect(standingsOfCache(cache).filter((item) => item.checkedAt !== null)).toEqual([]);
    await refreshModelCache(loadSettings(tenant), { scope: tenant, forgetLessons: true });
    resetAvailabilityMemo();
    expect(refusedModelIds(tenant).size).toBe(0);
    expect(ids(listProbedVideoModels(undefined, tenant))).toContain("kling-v3");
  });

  it("keeps the lessons through a plain refresh, such as a Settings save with the same key", async () => {
    learnTheDaysRefusals();
    await refreshModelCache(loadSettings(tenant), { scope: tenant });
    resetAvailabilityMemo();
    expect(refusedModelIds(tenant).size).toBe(3);
  });
});

describe("two keys on one desk", () => {
  it("does not let one key's refusals hide models for the other", async () => {
    stubGateway();
    await freshDeskWithKey(KEY_A);
    learnTheDaysRefusals();
    expect(refusedModelIds(tenant).size).toBe(3);

    // A wider key is given: its list is read, and nothing learned for the first key applies to it.
    await freshDeskWithKey(KEY_B);
    expect(refusedModelIds(tenant).size).toBe(0);
    expect(ids(listProbedVideoModels(undefined, tenant))).toEqual(
      expect.arrayContaining(["grok-imagine-video", "kling-v3", "veo_3_1-fast"]),
    );

    // Back on the first key, its lessons are still there (while they live).
    await freshDeskWithKey(KEY_A);
    expect(refusedModelIds(tenant).size).toBe(3);
  });

  it("never writes either key to the cache file", async () => {
    stubGateway();
    await freshDeskWithKey(KEY_A);
    learnTheDaysRefusals();
    await freshDeskWithKey(KEY_B);
    learnFromOutcome(report("kling-v3", "video", refusal(503, undefined, "no available channel")));
    const text = readFileSync(cachePath(), "utf8");
    for (const key of [KEY_A, KEY_B]) {
      expect(text).not.toContain(key);
      expect(text).not.toContain(key.slice(3, 24));
    }
    expect(text).toMatch(/"keyId": "k_[0-9a-f]{16}"/);
  });
});

describe("the catalogue keeps what this key cannot use", () => {
  beforeEach(async () => {
    stubGateway();
    await freshDeskWithKey(KEY_A);
  });

  it("reads the gateway's price list on refresh and keeps it, with no key sent", async () => {
    const fetchMock = stubGateway();
    await refreshModelCache(loadSettings(tenant), { scope: tenant });
    const pricingCall = fetchMock.mock.calls.find((call) => String(call[0]).endsWith("/api/pricing"));
    expect(pricingCall).toBeDefined();
    expect(JSON.stringify(pricingCall?.[1] ?? {})).not.toContain(KEY_A);
    expect(loadModelCache(tenant).endpointHints?.["lumen-art-3"]).toEqual(["image-generation"]);
  });

  it("explains, for Settings, why each missing or refused model is not offered", () => {
    learnTheDaysRefusals();
    const body = modelAvailabilityBody(tenant);
    const byId = Object.fromEntries(body.unavailable.map((row) => [row.id, row]));
    expect(byId["grok-imagine-video"]).toMatchObject({ kind: "video", status: "account_blocked" });
    expect(byId["kling-v3"]).toMatchObject({ status: "no_channel" });
    expect(byId["veo_3_1-fast"]).toMatchObject({ status: "upstream_rejected" });
    // On the price list, not on this key: a derived reason, not a learned one.
    expect(byId["lumen-art-3"]).toMatchObject({
      kind: "image",
      status: "not_on_key",
      reason: "not_listed",
      checkedAt: null,
    });
    expect(body.kinds.video?.offered).toBeGreaterThan(0);
    expect(body.kinds.image).toEqual({ offered: 1 });
  });

  it("is the same answer on every read: nothing in it is random or time of day", () => {
    learnTheDaysRefusals();
    expect(modelAvailabilityBody(tenant)).toEqual(modelAvailabilityBody(tenant));
  });

  it("does not offer a model the key never listed, even though the gateway knows it", () => {
    expect(ids(listImageModels(tenant))).toEqual(["gpt-image-2"]);
  });
});

describe("a model the gateway adds later", () => {
  it("appears in the right picker with no code change when the key lists it", async () => {
    stubGateway([...LISTED, "lumen-art-3"]);
    await freshDeskWithKey(KEY_A);
    // No regex in this repo knows the name; the price list says it is an image model.
    expect(ids(listImageModels(tenant))).toEqual(expect.arrayContaining(["gpt-image-2", "lumen-art-3"]));
    expect(ids(modeCatalogPayload(undefined, tenant).modes.image)).toContain("lumen-art-3");
    expect(ids(modeCatalogPayload(undefined, tenant).modes.chat)).not.toContain("lumen-art-3");
  });
});

function cachePath(): string {
  return process.env.AGENTFORGE_MODELS_CACHE_PATH ?? `${process.env.AGENTFORGE_DATA_DIR}/models-cache.json`;
}
