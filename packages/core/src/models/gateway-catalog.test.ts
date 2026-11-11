import { describe, expect, it } from "vitest";
import { withOutcome, emptyStore, recordsFor } from "./availability";
import {
  buildCatalog,
  catalogKindOf,
  computeAvailability,
  offeredIdsFor,
  parsePricingHints,
  speechWireFor,
  unavailableModels,
  videoWireFor,
} from "./gateway-catalog";
import { pickPreferredImageModel, pickPreferredSpeechModel, pickPreferredVideoModel } from "./media-kind";
import { pickTranscriptionModel } from "../meeting/asr-model";

const NOW = Date.parse("2026-11-11T10:00:00.000Z");

/** The media ids a prepaid agent key listed on 2026-11-11, plus a few chat ids for contrast. */
const KEY_LIST = [
  "gpt-5.6-luna",
  "gpt-image-2",
  "seedance-2.0",
  "seedance-2.0-fast",
  "seedance-2.0-mini",
  "seedance-2.5",
  "grok-imagine-video",
  "kling-v3",
  "veo_3_1-fast",
  "qwen3.5-omni-flash",
  "qwen3.5-omni-flash-realtime",
  "muse-voice-transcribe-1.0",
  "qwen3-tts-instruct-flash-realtime",
];

const PRICING = {
  data: [
    { model_name: "gpt-image-2", supported_endpoint_types: ["image-generation", "openai-image-edit", "openai"] },
    { model_name: "seedance-2.0-fast", supported_endpoint_types: ["openai-video", "seedance2-native-video"] },
    { model_name: "gpt-5.4-pro", supported_endpoint_types: ["openai-response"] },
    // A model this repo has never heard of, whose endpoint types say what it is.
    { model_name: "lumen-art-3", supported_endpoint_types: ["image-generation"] },
    { model_name: "lumen-clip-1", supported_endpoint_types: ["openai-video"] },
  ],
};

describe("catalogKindOf", () => {
  it("places a model by what the price list says it is, before its name", () => {
    const hints = parsePricingHints(PRICING);
    expect(catalogKindOf("lumen-art-3", hints)).toBe("image");
    expect(catalogKindOf("lumen-clip-1", hints)).toBe("video");
    // With no price list it is only an unknown chat-looking name.
    expect(catalogKindOf("lumen-art-3")).toBe("chat");
  });

  it("knows each kind of audio and keeps the realtime ones out of the HTTP kinds", () => {
    expect(catalogKindOf("suno_music")).toBe("music");
    expect(catalogKindOf("suno_lyrics")).toBe("music");
    expect(catalogKindOf("tts-1")).toBe("speech");
    expect(catalogKindOf("muse-voice-transcribe-1.0")).toBe("transcription");
    expect(catalogKindOf("qwen3.5-omni-flash-realtime")).toBe("realtime");
    expect(catalogKindOf("qwen3-tts-instruct-flash-realtime")).toBe("realtime");
  });
});

describe("the wire each model is driven on", () => {
  it("sends Grok to /v1/videos and the Seedance family to its own body", () => {
    expect(videoWireFor("grok-imagine-video")).toMatchObject({
      id: "videos_json",
      method: "POST",
      route: "/v1/videos",
    });
    expect(videoWireFor("grok-imagine-video-1.5-preview").id).toBe("videos_json");
    expect(videoWireFor("seedance-2.0-fast")).toMatchObject({ id: "video_seedance", route: "/v1/video/generations" });
    expect(videoWireFor("veo_3_1-fast").id).toBe("video_seedance");
    expect(videoWireFor("omni-fast-v2v").id).toBe("video_generations");
  });

  it("speaks through the chat stream for an Omni id and nothing for a realtime one", () => {
    expect(speechWireFor("qwen3.5-omni-flash")).toMatchObject({
      id: "chat_audio_stream",
      route: "/v1/chat/completions",
    });
    expect(speechWireFor("qwen3.5-omni-plus")?.id).toBe("chat_audio_stream");
    expect(speechWireFor("qwen3.5-omni-flash-realtime")).toBeUndefined();
    expect(speechWireFor("tts-1")?.id).toBe("audio_speech");
    expect(speechWireFor("gpt-5.6-luna")).toBeUndefined();
  });
});

describe("buildCatalog", () => {
  const catalog = buildCatalog({ listedIds: KEY_LIST, hints: parsePricingHints(PRICING) });
  const entry = (id: string) => catalog.find((item) => item.id === id);

  it("keeps models the key cannot use, so a wider key finds them without a code change", () => {
    expect(entry("lumen-art-3")).toMatchObject({ kind: "image", listedOnKey: false });
    expect(entry("lumen-clip-1")).toMatchObject({ kind: "video", listedOnKey: false });
    expect(entry("gpt-image-2")).toMatchObject({ kind: "image", listedOnKey: true });
  });

  it("adds the relay models the gateway never lists, as relay-only", () => {
    expect(entry("suno_music")).toMatchObject({ kind: "music", listedOnKey: false, relayOnly: true });
    expect(entry("suno_lyrics")).toMatchObject({ relayOnly: true });
  });

  it("treats a relay model the gateway does list as an ordinary listed model", () => {
    const listed = buildCatalog({ listedIds: ["suno_music"] });
    expect(listed.find((item) => item.id === "suno_music")).toMatchObject({ listedOnKey: true, relayOnly: false });
  });

  it("counts an Omni chat id as a chat model that can also speak", () => {
    expect(entry("qwen3.5-omni-flash")).toMatchObject({ kind: "chat" });
    expect(entry("qwen3.5-omni-flash")?.wires.speech?.id).toBe("chat_audio_stream");
  });

  it("is case-insensitive about ids", () => {
    const merged = buildCatalog({ listedIds: ["Seedance-2.0-Fast"], hints: { "seedance-2.0-fast": ["openai-video"] } });
    expect(merged.filter((item) => item.id.toLowerCase() === "seedance-2.0-fast")).toHaveLength(1);
  });
});

describe("availability and the pickers", () => {
  const catalog = buildCatalog({ listedIds: KEY_LIST, hints: parsePricingHints(PRICING) });

  /** What the three real refusals of 2026-11-11 would have taught, filed under one key. */
  function learned() {
    let store = emptyStore("salt-one-1234");
    store = withOutcome(
      store,
      "k_a",
      "grok-imagine-video",
      { status: "account_blocked", reason: "prepaid_async_requires_fixed_price" },
      NOW,
    );
    store = withOutcome(store, "k_a", "kling-v3", { status: "no_channel", reason: "no available channel" }, NOW);
    store = withOutcome(
      store,
      "k_a",
      "veo_3_1-fast",
      { status: "upstream_rejected", reason: "bad_response_status_code" },
      NOW,
    );
    return recordsFor(store, "k_a");
  }

  it("offers every model the key lists, until a real call says it does not work", () => {
    const standings = computeAvailability({ catalog, records: {}, nowMs: NOW });
    const video = offeredIdsFor(catalog, standings, "video");
    expect(video).toEqual(
      expect.arrayContaining(["seedance-2.0-fast", "grok-imagine-video", "kling-v3", "veo_3_1-fast"]),
    );
    // Not on the key: never offered.
    expect(video).not.toContain("lumen-clip-1");
  });

  it("hides what a call refused, and keeps what works", () => {
    const standings = computeAvailability({ catalog, records: learned(), nowMs: NOW });
    const video = offeredIdsFor(catalog, standings, "video");
    expect(video).not.toContain("grok-imagine-video");
    expect(video).not.toContain("kling-v3");
    expect(video).not.toContain("veo_3_1-fast");
    expect(video).toContain("seedance-2.0-fast");
    expect(offeredIdsFor(catalog, standings, "image")).toEqual(["gpt-image-2"]);
  });

  it("offers a refused model again once its lesson has expired", () => {
    const later = NOW + 20 * 60_000;
    const standings = computeAvailability({ catalog, records: learned(), nowMs: later });
    const video = offeredIdsFor(catalog, standings, "video");
    // upstream_rejected is a quarter hour; the other two are an hour and a day.
    expect(video).toContain("veo_3_1-fast");
    expect(video).not.toContain("kling-v3");
    expect(video).not.toContain("grok-imagine-video");
  });

  it("falls back, kind by kind, to the first model that is left (his key, 2026-11-11)", () => {
    const standings = computeAvailability({ catalog, records: learned(), nowMs: NOW });
    expect(pickPreferredVideoModel(offeredIdsFor(catalog, standings, "video"))).toBe("seedance-2.0-fast");
    expect(pickPreferredImageModel(offeredIdsFor(catalog, standings, "image"))).toBe("gpt-image-2");
    expect(pickPreferredSpeechModel(offeredIdsFor(catalog, standings, "speech"))).toBe("qwen3.5-omni-flash");
    expect(pickTranscriptionModel(offeredIdsFor(catalog, standings, "transcription"))).toBe(
      "muse-voice-transcribe-1.0",
    );
  });

  it("lists nothing for a kind the key has none of, so the entry point can say so", () => {
    const standings = computeAvailability({ catalog, records: {}, nowMs: NOW });
    const music = offeredIdsFor(catalog, standings, "music");
    // Only the relay seed, which a list can never prove either way: it stays unknown, not offered-as-working.
    expect(music).toEqual(["suno_music", "suno_lyrics"]);
    const afterRefusal = withOutcome(
      emptyStore("salt-one-1234"),
      "k_a",
      "suno_music",
      { status: "not_on_key", reason: "model_not_found" },
      NOW,
    );
    const taught = computeAvailability({ catalog, records: recordsFor(afterRefusal, "k_a"), nowMs: NOW });
    expect(offeredIdsFor(catalog, taught, "music")).toEqual(["suno_lyrics"]);
  });

  it("derives not_on_key for a catalog model the key's list lacks, with the reason Settings shows", () => {
    const standings = computeAvailability({ catalog, records: {}, nowMs: NOW });
    const lumen = standings.find((item) => item.id === "lumen-art-3");
    expect(lumen).toMatchObject({ status: "not_on_key", reason: "not_listed", checkedAt: null, listedOnKey: false });
    // A relay model is not "missing" just because the list never carries it.
    expect(standings.find((item) => item.id === "suno_music")?.status).toBe("unknown");
  });

  it("derives nothing when no list was ever read (a stub desk)", () => {
    const stubCatalog = buildCatalog({ listedIds: [], hints: parsePricingHints(PRICING) });
    const standings = computeAvailability({ catalog: stubCatalog, records: {}, nowMs: NOW });
    expect(standings.every((item) => item.status === "unknown")).toBe(true);
  });

  it("lets a success clear an earlier refusal", () => {
    let store = withOutcome(emptyStore("salt-one-1234"), "k_a", "kling-v3", { status: "no_channel", reason: "" }, NOW);
    store = withOutcome(store, "k_a", "kling-v3", { status: "available", reason: "" }, NOW + 1_000);
    const standings = computeAvailability({ catalog, records: recordsFor(store, "k_a"), nowMs: NOW + 2_000 });
    expect(standings.find((item) => item.id === "kling-v3")?.status).toBe("available");
    expect(offeredIdsFor(catalog, standings, "video")).toContain("kling-v3");
  });

  it("lists, for Settings, the media the key cannot use and the chat models only once a call said so", () => {
    const standings = computeAvailability({ catalog, records: learned(), nowMs: NOW });
    const ids = unavailableModels(standings).map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining(["grok-imagine-video", "kling-v3", "veo_3_1-fast", "lumen-art-3"]));
    // Realtime ids and chat ids absent from the list are not "cannot use": they are simply not part of this key.
    expect(ids).not.toContain("qwen3.5-omni-flash-realtime");
    const withChat = computeAvailability({
      catalog: buildCatalog({ listedIds: ["gpt-5.6-luna"], hints: { "gpt-5.4-pro": ["openai-response"] } }),
      records: {},
      nowMs: NOW,
    });
    expect(unavailableModels(withChat).map((item) => item.id)).not.toContain("gpt-5.4-pro");
  });
});
