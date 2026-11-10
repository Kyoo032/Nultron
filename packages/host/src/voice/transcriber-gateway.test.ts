/**
 * The gateway transcriber against an injected fetch. The sentinel key must not appear in a log line.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayTranscriber } from "./transcriber-gateway";
import { wavFromPcm } from "./talker-wav";

const KEY = "voice-sentinel-DO-NOT-LEAK-9f3a2c";
const PCM = Buffer.from([1, 2, 3, 4]);

type Call = { url: string; init: RequestInit; form: FormData };

afterEach(() => {
  vi.restoreAllMocks();
});

function install(reply: (call: Call) => Response | Promise<Response>): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const form = init?.body instanceof FormData ? init.body : new FormData();
    const call = { url: String(input), init: init ?? {}, form };
    calls.push(call);
    return reply(call);
  };
  return { calls, fetchImpl };
}

function transcriber(fetchImpl: typeof fetch, timeoutMs?: number) {
  return createGatewayTranscriber({
    baseUrl: "http://127.0.0.1:9/v1/",
    apiKey: KEY,
    fetch: fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

describe("createGatewayTranscriber", () => {
  it("posts a wav multipart body and returns the text with seconds from the PCM", async () => {
    const { calls, fetchImpl } = install(
      () => new Response(JSON.stringify({ text: "  Berapa total?  " }), { status: 200 }),
    );
    const result = await transcriber(fetchImpl).transcribe(PCM, { locale: "id", signal: new AbortController().signal });
    const call = calls[0] as Call;
    expect(call.url).toBe("http://127.0.0.1:9/v1/audio/transcriptions");
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(call.init.headers).not.toHaveProperty("Content-Type");
    expect(call.form.get("model")).toBe("muse-voice-transcribe-1.0");
    expect(call.form.get("language")).toBe("id");
    const file = call.form.get("file");
    expect(file).toBeInstanceOf(Blob);
    const bytes = Buffer.from(await (file as Blob).arrayBuffer());
    expect(bytes.subarray(0, 44)).toEqual(wavFromPcm(PCM).subarray(0, 44));
    expect(bytes.subarray(44)).toEqual(PCM);
    expect(result).toEqual({ text: "Berapa total?", seconds: 0 });
  });

  it("returns null on a failure and on empty text, and the log line has no key", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "info").mockImplementation((line?: unknown) => {
      lines.push(String(line ?? ""));
    });
    const failed = install(() => new Response(JSON.stringify({ error: KEY }), { status: 500 }));
    await expect(
      transcriber(failed.fetchImpl).transcribe(PCM, { locale: "en", signal: new AbortController().signal }),
    ).resolves.toBeNull();
    const empty = install(() => new Response(JSON.stringify({ text: "   " }), { status: 200 }));
    await expect(
      transcriber(empty.fetchImpl).transcribe(PCM, { locale: "en", signal: new AbortController().signal }),
    ).resolves.toBeNull();
    expect(lines.join("\n")).not.toContain(KEY);
  });

  it("returns null when the budget runs out and never throws", async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error(`aborted ${KEY}`), { name: "AbortError" }));
        });
      });
    const started = Date.now();
    await expect(
      transcriber(fetchImpl, 40).transcribe(PCM, { locale: "id", signal: new AbortController().signal }),
    ).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
