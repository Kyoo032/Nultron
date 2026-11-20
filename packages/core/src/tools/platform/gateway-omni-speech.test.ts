import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayRefusalError, classifyGatewayRefusal } from "../../models/availability";
import { setModelOutcomeSink, type ModelOutcomeReport } from "../../models/outcome-sink";
import type { TenantContext } from "../../tenancy/types";
import { invokeTool } from "../define-tool";
import { runWithToolSecrets } from "../secret-scope";
import { generateGatewayOmniSpeech, omniAudioChunks, wavFromPcm16 } from "./gateway-audio";
import { speechGenerateTool } from "./music-generate";
import { videoGenerateTool } from "./video-generate";

const BASE = "https://api.example.test/v1";
const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  role: "member",
};

/** Two PCM16 chunks, the way the Omni stream sends them, with the SSE framing the gateway uses. */
function omniStream(chunks: Uint8Array[]): string {
  const lines = chunks.map(
    (chunk) =>
      `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: Buffer.from(chunk).toString("base64") } } }] })}`,
  );
  return `${[`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}`, ...lines, "data: [DONE]"].join("\n\n")}\n\n`;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setModelOutcomeSink(null);
});

describe("omniAudioChunks", () => {
  it("takes only the audio deltas, in order, and skips framing and [DONE]", () => {
    const sse = omniStream([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
    expect(omniAudioChunks(sse).map((chunk) => [...Buffer.from(chunk, "base64")])).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("ignores lines that are not JSON", () => {
    expect(omniAudioChunks("data: not json\n\ndata: [DONE]\n")).toEqual([]);
  });
});

describe("wavFromPcm16", () => {
  it("puts a 44-byte RIFF header in front of 24 kHz mono PCM16", () => {
    const pcm = new Uint8Array(480);
    const wav = wavFromPcm16(pcm);
    expect(wav.byteLength).toBe(44 + 480);
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
    expect(view.getUint32(4, true)).toBe(36 + 480);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint32(40, true)).toBe(480);
  });
});

describe("generateGatewayOmniSpeech", () => {
  it("streams the chat call with audio out and answers a WAV data URL (the shape driven 2026-11-11)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => omniStream([new Uint8Array(200), new Uint8Array(280)]),
    });
    const spoken = await generateGatewayOmniSpeech({
      baseUrl: BASE,
      apiKey: "sk-test",
      model: "qwen3.5-omni-flash",
      text: "Halo dunia",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${BASE}/chat/completions`);
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({
      model: "qwen3.5-omni-flash",
      stream: true,
      modalities: ["audio", "text"],
      audio: { voice: "Tina", format: "wav" },
    });
    expect(body.messages[0].content).toContain("Halo dunia");
    expect(spoken.model).toBe("qwen3.5-omni-flash");
    expect(spoken.url.startsWith("data:audio/wav;base64,")).toBe(true);
    const wav = Buffer.from(spoken.url.split(",")[1] ?? "", "base64");
    expect(wav.byteLength).toBe(44 + 480);
  });

  it("refuses an answer with no audio", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "data: [DONE]\n\n" });
    await expect(
      generateGatewayOmniSpeech({
        baseUrl: BASE,
        apiKey: "sk-test",
        model: "qwen3.5-omni-flash",
        text: "x",
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/no audio/i) });
  });

  it("keeps the gateway's status and code on a refusal", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        error: { message: "no available channel for qwen3.5-omni-flash", code: "model_not_found" },
      }),
    });
    const error = await generateGatewayOmniSpeech({
      baseUrl: BASE,
      apiKey: "sk-test",
      model: "qwen3.5-omni-flash",
      text: "x",
      fetchImpl: fetchMock as unknown as typeof fetch,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GatewayRefusalError);
    const refusal = (error as GatewayRefusalError).refusal;
    expect(classifyGatewayRefusal(refusal)).toMatchObject({ status: "no_channel" });
  });
});

describe("speechGenerateTool", () => {
  it("drives an Omni id through the chat stream and a TTS id through /audio/speech", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => omniStream([new Uint8Array(100)]) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "audio/mpeg" }),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      });
    vi.stubGlobal("fetch", fetchMock);
    const secrets = { OPENAI_API_KEY: "sk-model", OPENAI_BASE_URL: "https://api.tokotokenai.com/v1" };
    const omni = await runWithToolSecrets({ secrets, backends: {} }, () =>
      invokeTool(speechGenerateTool, { text: "hi", model: "qwen3.5-omni-flash" }, tenant),
    );
    expect(omni).toMatchObject({ success: true, model: "qwen3.5-omni-flash" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.tokotokenai.com/v1/chat/completions");
    const tts = await runWithToolSecrets({ secrets, backends: {} }, () =>
      invokeTool(speechGenerateTool, { text: "hi", model: "tts-1" }, tenant),
    );
    expect(tts).toMatchObject({ success: true, model: "tts-1" });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://api.tokotokenai.com/v1/audio/speech");
  });
});

describe("the tools report what a real call came to", () => {
  it("reports a refusal with its status and code, and a success", async () => {
    const reports: ModelOutcomeReport[] = [];
    setModelOutcomeSink((report) => reports.push(report));
    const secrets = { OPENAI_API_KEY: "sk-model", OPENAI_BASE_URL: "https://api.tokotokenai.com/v1" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: { message: "x", code: "prepaid_async_requires_fixed_price" } }),
      }),
    );
    const refused = await runWithToolSecrets({ secrets, backends: {} }, () =>
      invokeTool(videoGenerateTool, { prompt: "rain", model: "grok-imagine-video" }, tenant),
    );
    expect(refused).toMatchObject({ success: false });
    expect(reports).toHaveLength(1);
    const first = reports[0] as Extract<ModelOutcomeReport, { ok: false }>;
    expect(first).toMatchObject({ model: "grok-imagine-video", kind: "video", ok: false, tenant });
    expect(classifyGatewayRefusal((first.error as GatewayRefusalError).refusal)).toMatchObject({
      status: "account_blocked",
    });
  });

  it("never lets a failing sink break the call", async () => {
    setModelOutcomeSink(() => {
      throw new Error("sink is broken");
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }));
    const result = await runWithToolSecrets(
      { secrets: { OPENAI_API_KEY: "sk-model", OPENAI_BASE_URL: "https://api.tokotokenai.com/v1" }, backends: {} },
      () => invokeTool(videoGenerateTool, { prompt: "rain", model: "kling-v3" }, tenant),
    );
    expect(result).toMatchObject({ success: false });
  });
});
