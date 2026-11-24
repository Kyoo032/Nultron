/**
 * The HTTP talker against a stand-in gateway. Nothing here leaves the machine: `fetch` is injected,
 * except the abort test, which listens on 127.0.0.1. The sentinel key must not appear in an error
 * or a log line.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgementWords,
  createOmniHttpTalker,
  resetTalkerCachesForTests,
  whenAcknowledgementSettled,
  type OmniHttpTalkerOptions,
} from "./talker-omni-http";
import {
  ACK_INSTRUCTIONS,
  ACK_SENTENCE,
  HEAR_SHORT_INSTRUCTIONS,
  OFFER_KEEP_LISTENING,
  TALKER_INSTRUCTIONS,
} from "./talker-prompt";
import { TalkerError, type TalkerEvent, type TalkerSession } from "./talker";
import { wavFromPcm } from "./talker-wav";

const KEY = "voice-sentinel-DO-NOT-LEAK-9f3a2c";
const MODEL = "qwen3.5-omni-flash";
const VOICE = "Tina";
const PCM = Buffer.from([10, 20, 30, 40]);
const USAGE = {
  prompt_tokens: 11,
  completion_tokens: 7,
  prompt_tokens_details: { audio_tokens: 4, text_tokens: 7 },
  completion_tokens_details: { audio_tokens: 5, text_tokens: 2 },
};

type Json = Record<string, unknown>;
type Call = { url: string; init: RequestInit; json: Json | null };

let savedOffer = OFFER_KEEP_LISTENING.on;

beforeEach(() => {
  savedOffer = OFFER_KEEP_LISTENING.on;
  OFFER_KEEP_LISTENING.on = true;
  resetTalkerCachesForTests();
});

afterEach(() => {
  OFFER_KEEP_LISTENING.on = savedOffer;
  vi.restoreAllMocks();
});

function sse(frames: unknown[], status = 200): Response {
  const body = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

function chunk(delta: unknown, finish: string | null = null, usage?: unknown) {
  return {
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  };
}

function isAck(json: Json | null): boolean {
  const messages = (json?.messages ?? []) as Array<{ role?: string; content?: unknown }>;
  const system = messages.find((message) => message.role === "system");
  return system?.content === ACK_INSTRUCTIONS.en || system?.content === ACK_INSTRUCTIONS.id;
}

function ackResponse(json: Json): Response {
  const messages = json.messages as Array<{ role?: string; content?: unknown }>;
  const sentence = String(messages.find((message) => message.role === "user")?.content ?? "");
  return sse([
    chunk({ content: sentence }),
    chunk({ audio: { data: Buffer.from([1, 2]).toString("base64") } }),
    chunk({}, "stop"),
  ]);
}

function install(
  reply: (call: Call) => Response | Promise<Response>,
  options: { ack?: "auto" | "script" } = {},
): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const raw = typeof init?.body === "string" ? (JSON.parse(init.body) as Json) : null;
    const call: Call = { url: String(input), init: init ?? {}, json: raw };
    calls.push(call);
    if (raw && isAck(raw) && options.ack !== "script") {
      return ackResponse(raw);
    }
    return reply(call);
  };
  return { calls, fetchImpl };
}

function talker(fetchImpl: typeof fetch, extra: Partial<OmniHttpTalkerOptions> = {}) {
  return createOmniHttpTalker({
    baseUrl: "http://127.0.0.1:9/v1/",
    apiKey: KEY,
    model: MODEL,
    voice: VOICE,
    fetch: fetchImpl,
    ...extra,
  });
}

function session(fetchImpl: typeof fetch, extra: Partial<OmniHttpTalkerOptions> = {}): TalkerSession {
  return talker(fetchImpl, extra).open({ locale: "id", history: [] });
}

async function collect(source: AsyncIterable<TalkerEvent>): Promise<TalkerEvent[]> {
  const events: TalkerEvent[] = [];
  for await (const event of source) {
    events.push(event);
  }
  return events;
}

function chatCalls(calls: Call[]): Call[] {
  return calls.filter((call) => !isAck(call.json));
}

function messagesOf(call: Call): Array<{ role?: string; content?: unknown }> {
  return (call.json?.messages ?? []) as Array<{ role?: string; content?: unknown }>;
}

function toolNames(call: Call): string[] {
  const tools = (call.json?.tools ?? []) as Array<{ function?: { name?: string } }>;
  return tools.map((tool) => tool.function?.name ?? "");
}

function wavOf(call: Call): Buffer {
  const user = messagesOf(call).find((message) => Array.isArray(message.content));
  const content = user?.content;
  if (!Array.isArray(content)) {
    throw new Error("wav part missing");
  }
  const part = content[0] as { input_audio: { data: string } };
  return Buffer.from(part.input_audio.data.slice("data:audio/wav;base64,".length), "base64");
}

function spyLogs(): string[] {
  const lines: string[] = [];
  const write = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg ?? "")).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(write);
  vi.spyOn(console, "info").mockImplementation(write);
  vi.spyOn(console, "warn").mockImplementation(write);
  vi.spyOn(console, "error").mockImplementation(write);
  vi.spyOn(console, "debug").mockImplementation(write);
  return lines;
}

describe("createOmniHttpTalker reply", () => {
  it("sends speech as a wav, history as text, and tools with tool_choice auto", async () => {
    const history = [
      { role: "user" as const, text: "halo" },
      { role: "assistant" as const, text: "hai" },
    ];
    const { calls, fetchImpl } = install(() => sse([chunk({ content: "baik" }), chunk({}, "stop", USAGE)]));
    const open = talker(fetchImpl).open({ locale: "id", history });
    const events = await collect(open.reply(PCM, { signal: new AbortController().signal }));
    const call = chatCalls(calls)[0];
    expect(call).toBeDefined();
    const sent = call as Call;
    expect(sent.url).toBe("http://127.0.0.1:9/v1/chat/completions");
    expect(sent.init.method).toBe("POST");
    expect((sent.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(sent.json).toMatchObject({
      model: MODEL,
      stream: true,
      stream_options: { include_usage: true },
      modalities: ["text", "audio"],
      audio: { voice: VOICE, format: "wav" },
      tool_choice: "auto",
    });
    expect(toolNames(sent)).toEqual(["ask_nultron", "keep_listening"]);
    const messages = messagesOf(sent);
    expect(messages[0]).toEqual({ role: "system", content: TALKER_INSTRUCTIONS.id });
    expect(messages[1]).toEqual({ role: "user", content: "halo" });
    expect(messages[2]).toEqual({ role: "assistant", content: "hai" });
    expect(wavOf(sent).subarray(0, 44)).toEqual(wavFromPcm(PCM).subarray(0, 44));
    expect(wavOf(sent).subarray(44)).toEqual(PCM);
    expect(events.map((event) => event.type)).toEqual(["text", "usage", "done"]);
    expect(events[1]).toEqual({
      type: "usage",
      usage: { inputTokens: 11, outputTokens: 7, inputAudioTokens: 4, outputAudioTokens: 5 },
    });
  });

  it("omits keep_listening when mustAnswer is set or the switch is off", async () => {
    const { calls, fetchImpl } = install(() => sse([chunk({ content: "ok" }), chunk({}, "stop")]));
    const open = session(fetchImpl);
    await collect(open.reply(PCM, { signal: new AbortController().signal, mustAnswer: true }));
    expect(toolNames(chatCalls(calls)[0] as Call)).toEqual(["ask_nultron"]);
    OFFER_KEEP_LISTENING.on = false;
    await collect(open.reply(PCM, { signal: new AbortController().signal }));
    expect(toolNames(chatCalls(calls)[1] as Call)).toEqual(["ask_nultron"]);
  });

  it("yields whole samples when audio deltas split a sample", async () => {
    const { fetchImpl } = install(() =>
      sse([
        chunk({ audio: { data: Buffer.from([1, 2, 3]).toString("base64") } }),
        chunk({ audio: { data: Buffer.from([4]).toString("base64") } }),
        chunk({ audio: { data: Buffer.from([5, 6]).toString("base64") } }),
        chunk({}, "stop"),
      ]),
    );
    const events = await collect(session(fetchImpl).reply(PCM, { signal: new AbortController().signal }));
    const audio = events.filter((event) => event.type === "audio");
    expect(audio.every((event) => event.type === "audio" && event.pcm.length % 2 === 0)).toBe(true);
    const joined = Buffer.concat(audio.map((event) => (event.type === "audio" ? event.pcm : Buffer.alloc(0))));
    expect(joined).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
  });

  it("reads words from content, and from audio.transcript when content is absent", async () => {
    const { fetchImpl } = install(() =>
      sse([
        chunk({ content: "from-content", audio: { transcript: "from-transcript" } }),
        chunk({ audio: { transcript: " only" } }),
        chunk({}, "stop"),
      ]),
    );
    const events = await collect(session(fetchImpl).reply(PCM, { signal: new AbortController().signal }));
    const words = events.filter((event) => event.type === "text").map((event) => (event.type === "text" ? event.delta : ""));
    expect(words).toEqual(["from-content", " only"]);
  });

  it("assembles a tool call split across chunks into ask", async () => {
    const { fetchImpl } = install(() =>
      sse([
        chunk({
          tool_calls: [{ index: 0, id: "call_abc", function: { name: "ask_nultron", arguments: '{"question":' } }],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"Berapa?"}' } }] }),
        chunk({}, "tool_calls", { prompt_tokens: 3, completion_tokens: 1 }),
      ]),
    );
    const events = await collect(session(fetchImpl).reply(PCM, { signal: new AbortController().signal }));
    expect(events.map((event) => event.type)).toEqual(["usage", "ask", "done"]);
    expect(events[1]).toEqual({ type: "ask", callId: "call_abc", question: "Berapa?" });
    expect(events[0]).toEqual({
      type: "usage",
      usage: { inputTokens: 3, outputTokens: 1, inputAudioTokens: 0, outputAudioTokens: 0 },
    });
  });

  it("yields wait when the model calls keep_listening", async () => {
    const { fetchImpl } = install(() =>
      sse([
        chunk({ tool_calls: [{ index: 0, id: "call_w", function: { name: "keep_listening", arguments: "{}" } }] }),
        chunk({}, "tool_calls"),
      ]),
    );
    const events = await collect(session(fetchImpl).reply(PCM, { signal: new AbortController().signal }));
    expect(events.map((event) => event.type)).toEqual(["wait", "done"]);
  });

  it("fails a tool call that has no usable question, and the message carries no words", async () => {
    const lines = spyLogs();
    const { fetchImpl } = install(() =>
      sse([
        chunk({
          tool_calls: [
            { index: 0, id: "call_x", function: { name: "ask_nultron", arguments: `not-json ${KEY} RAHASIA-KATA` } },
          ],
        }),
        chunk({}, "tool_calls"),
      ]),
    );
    const error = await collect(session(fetchImpl).reply(PCM, { signal: new AbortController().signal })).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(TalkerError);
    expect((error as TalkerError).code).toBe("failed");
    expect((error as TalkerError).message).not.toContain(KEY);
    expect((error as TalkerError).message).not.toContain("RAHASIA");
    expect(lines.join("\n")).not.toContain(KEY);
    expect(lines.join("\n")).not.toContain("RAHASIA");
  });
});

describe("createOmniHttpTalker answer", () => {
  it("sends the question as text and does not send the audio again", async () => {
    const { calls, fetchImpl } = install((call) => {
      const messages = call.json?.messages;
      if (chatCalls([call]).length === 1 && Array.isArray(messages) && messages.length === 2) {
        return sse([
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                function: { name: "ask_nultron", arguments: '{"question":"Berapa total?"}' },
              },
            ],
          }),
          chunk({}, "tool_calls"),
        ]);
      }
      return sse([chunk({ content: "dua belas" }), chunk({}, "stop", USAGE)]);
    });
    const open = session(fetchImpl);
    const signal = new AbortController().signal;
    await collect(open.reply(PCM, { signal }));
    const events = await collect(open.answer("call_1", "Rp 12", { signal }));
    const second = chatCalls(calls)[1];
    expect(second?.json?.tools).toBeUndefined();
    expect(second?.json?.tool_choice).toBeUndefined();
    expect(JSON.stringify(second?.json)).not.toContain("input_audio");
    const messages = messagesOf(second as Call);
    expect(messages[1]).toEqual({ role: "user", content: "Berapa total?" });
    expect(messages[2]).toMatchObject({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "ask_nultron", arguments: '{"question":"Berapa total?"}' },
        },
      ],
    });
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "Rp 12" });
    expect(events.some((event) => event.type === "text")).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("fails before any request when the call id is unknown", async () => {
    const { calls, fetchImpl } = install(() => sse([chunk({}, "stop")]));
    const open = session(fetchImpl);
    const error = await collect(open.answer("missing", "x", { signal: new AbortController().signal })).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "failed" });
    expect(chatCalls(calls)).toHaveLength(0);
  });

  it("masks PII in prior history turns before sending reply requests to the gateway", async () => {
    const { calls, fetchImpl } = install(() => sse([chunk({ content: "Noted." }), chunk({}, "stop", USAGE)]));
    const open = talker(fetchImpl).open({
      locale: "id",
      history: [
        { role: "user", text: "Kirim ringkasan ke Rina Wijaya di rina@contoh.id" },
        { role: "assistant", text: "Baik, dikirim ke Rekening BCA 1234567890" },
      ],
    });
    await collect(open.reply(PCM, { signal: new AbortController().signal }));
    const first = chatCalls(calls)[0];
    const serialized = JSON.stringify(first?.json?.messages);
    expect(serialized).not.toContain("Rina Wijaya");
    expect(serialized).not.toContain("rina@contoh.id");
    expect(serialized).not.toContain("1234567890");
    expect(serialized).toContain("[name]");
    expect(serialized).toContain("[email]");
    expect(serialized).toContain("[account]");
  });

  it("masks PII in answer text, pending question, and arguments before sending to the gateway", async () => {
    const { calls, fetchImpl } = install((call) => {
      const messages = call.json?.messages;
      if (chatCalls([call]).length === 1 && Array.isArray(messages) && messages.length === 2) {
        return sse([
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "call_pii",
                function: {
                  name: "ask_nultron",
                  arguments: '{"question":"Email rina@example.com for Kirim ke Rina Wijaya"}',
                },
              },
            ],
          }),
          chunk({}, "tool_calls"),
        ]);
      }
      return sse([chunk({ content: "Done." }), chunk({}, "stop", USAGE)]);
    });
    const open = session(fetchImpl);
    const signal = new AbortController().signal;
    await collect(open.reply(PCM, { signal }));
    await collect(open.answer("call_pii", "Send to rina@example.com or 081234567890", { signal }));
    const second = chatCalls(calls)[1];
    const serialized = JSON.stringify(second?.json);
    expect(serialized).not.toContain("rina@example.com");
    expect(serialized).not.toContain("Rina Wijaya");
    expect(serialized).not.toContain("081234567890");
    expect(serialized).toContain("[email]");
    expect(serialized).toContain("[name]");
    expect(serialized).toContain("[phone]");
  });
});

describe("createOmniHttpTalker remember", () => {
  it("keeps the last twelve turns and skips a null user", async () => {
    const { calls, fetchImpl } = install(() => sse([chunk({ content: "ok" }), chunk({}, "stop")]));
    const history = Array.from({ length: 15 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `h${index}`,
    }));
    const open = talker(fetchImpl).open({ locale: "en", history });
    open.remember({ user: null, assistant: "heard", interrupted: true });
    open.remember({ user: "   ", assistant: "", interrupted: false });
    for (let index = 0; index < 8; index += 1) {
      open.remember({ user: `u${index}`, assistant: `a${index}`, interrupted: false });
    }
    await collect(open.reply(PCM, { signal: new AbortController().signal }));
    const stored = messagesOf(chatCalls(calls)[0] as Call).slice(1, -1);
    expect(stored).toHaveLength(12);
    expect(stored[0]).toEqual({ role: "user", content: "u2" });
    expect(stored.at(-1)).toEqual({ role: "assistant", content: "a7" });
    expect(stored.some((message) => message.content === "heard")).toBe(false);
    expect(JSON.stringify(stored)).not.toContain("h0");
  });
});

describe("createOmniHttpTalker errors", () => {
  const cases: Array<{ status: number; body: string; code: TalkerError["code"] }> = [
    { status: 401, body: `bad ${KEY}`, code: "refused" },
    { status: 403, body: "forbidden", code: "refused" },
    { status: 402, body: "insufficient balance", code: "refused" },
    { status: 400, body: "quota exceeded", code: "refused" },
    { status: 429, body: "rate limit", code: "unavailable" },
    { status: 500, body: "boom", code: "unavailable" },
    { status: 400, body: "invalid voice", code: "failed" },
  ];

  it.each(cases)("maps HTTP $status ($body) to $code without the key", async ({ status, body, code }) => {
    const lines = spyLogs();
    const { fetchImpl } = install(
      () => new Response(JSON.stringify({ error: { message: body } }), { status, headers: { "content-type": "application/json" } }),
    );
    const error = await collect(session(fetchImpl).reply(PCM, { signal: new AbortController().signal })).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ name: "TalkerError", code });
    expect((error as Error).message).not.toContain(KEY);
    expect((error as Error).message).not.toContain(body);
    expect(lines.join("\n")).not.toContain(KEY);
  });

  it("maps a network failure to unavailable and does not copy the thrown text", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError(`connect ${KEY} failed`);
    };
    const error = await collect(session(fetchImpl).reply(PCM, { signal: new AbortController().signal })).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "unavailable" });
    expect((error as Error).message).toBe("The gateway could not be reached.");
    expect((error as Error).message).not.toContain(KEY);
  });

  it("maps no first byte within the budget to unavailable", async () => {
    let aborted = false;
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    const started = Date.now();
    const error = await collect(
      session(fetchImpl, { limits: { firstByteMs: 40, silenceMs: 5_000 } }).reply(PCM, {
        signal: new AbortController().signal,
      }),
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "unavailable", message: "The gateway did not answer in time." });
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("maps a stream that goes silent to unavailable", async () => {
    const encoder = new TextEncoder();
    const fetchImpl: typeof fetch = (_input, init) => {
      const stream = new ReadableStream({
        start(controller) {
          const frame = chunk({ audio: { data: Buffer.from([1, 2]).toString("base64") } });
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
          init?.signal?.addEventListener("abort", () => {
            try {
              controller.close();
            } catch {
              // Already closed.
            }
          });
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    };
    const events: TalkerEvent[] = [];
    const error = await (async () => {
      try {
        for await (const event of session(fetchImpl, { limits: { firstByteMs: 5_000, silenceMs: 40 } }).reply(PCM, {
          signal: new AbortController().signal,
        })) {
          events.push(event);
        }
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toMatchObject({ code: "unavailable" });
    expect(events.some((event) => event.type === "audio")).toBe(true);
    expect(events.some((event) => event.type === "done")).toBe(false);
  });
});

describe("createOmniHttpTalker abort", () => {
  it("yields nothing and throws nothing when the signal is already aborted", async () => {
    const { calls, fetchImpl } = install(() => sse([chunk({ content: "no" })]));
    const controller = new AbortController();
    controller.abort();
    const events = await collect(session(fetchImpl).reply(PCM, { signal: controller.signal }));
    expect(events).toEqual([]);
    expect(chatCalls(calls)).toHaveLength(0);
  });

  it("stops when the caller aborts, and the loopback gateway sees the connection close", async () => {
    let sawClose = false;
    const server: Server = createServer((req, res) => {
      req.on("data", () => undefined);
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const frame = chunk({ audio: { data: Buffer.from([9, 8]).toString("base64") } });
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
      });
      res.on("close", () => {
        sawClose = true;
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const open = createOmniHttpTalker({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: KEY,
        model: MODEL,
        voice: "AbortVoice",
        limits: { firstByteMs: 2_000, silenceMs: 2_000 },
      }).open({ locale: "id", history: [] });
      const controller = new AbortController();
      const iterator = open.reply(PCM, { signal: controller.signal })[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.value).toMatchObject({ type: "audio" });
      controller.abort();
      const rest: TalkerEvent[] = [];
      for (;;) {
        const step = await iterator.next();
        if (step.done) {
          break;
        }
        rest.push(step.value);
      }
      expect(rest).toEqual([]);
      await vi.waitFor(() => expect(sawClose).toBe(true));
      open.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("close aborts a reply that is still reading", async () => {
    let started = false;
    let aborted = false;
    const fetchImpl: typeof fetch = (_input, init) => {
      const raw = String(init?.body ?? "");
      if (raw.includes("Ucapkan persis kalimat pengguna")) {
        return Promise.resolve(sse([chunk({ content: ACK_SENTENCE.id }), chunk({}, "stop")]));
      }
      started = true;
      return new Promise((_resolve, reject) => {
        const fail = () => {
          aborted = true;
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        };
        if (init?.signal?.aborted) {
          fail();
          return;
        }
        init?.signal?.addEventListener("abort", fail, { once: true });
      });
    };
    const open = session(fetchImpl, { limits: { firstByteMs: 5_000, silenceMs: 5_000 } });
    const pending = collect(open.reply(PCM, { signal: new AbortController().signal }));
    await vi.waitFor(() => expect(started).toBe(true));
    open.close();
    await expect(pending).resolves.toEqual([]);
    expect(aborted).toBe(true);
  });
});

describe("hearShort", () => {
  it("asks for text only and returns the words", async () => {
    const { calls, fetchImpl } = install(() => sse([chunk({ content: "Iya" }), chunk({}, "stop")]));
    const heard = await session(fetchImpl).hearShort(PCM, new AbortController().signal);
    expect(heard).toBe("Iya");
    const call = chatCalls(calls)[0];
    expect(call?.json).toMatchObject({ modalities: ["text"], model: MODEL, stream: true });
    expect(call?.json?.audio).toBeUndefined();
    expect(call?.json?.tools).toBeUndefined();
    expect(messagesOf(call as Call)[0]?.content).toBe(HEAR_SHORT_INSTRUCTIONS.id);
  });

  it("returns null on failure, empty text and timeout, and never throws", async () => {
    const failed = install(() => new Response("no", { status: 500 }));
    await expect(session(failed.fetchImpl).hearShort(PCM, new AbortController().signal)).resolves.toBeNull();

    const empty = install(() => sse([chunk({ content: "  " }), chunk({}, "stop")]));
    await expect(session(empty.fetchImpl).hearShort(PCM, new AbortController().signal)).resolves.toBeNull();

    const hanging: typeof fetch = (_input, init) => {
      const raw = String(init?.body ?? "");
      if (raw.includes("Ucapkan persis kalimat pengguna")) {
        return Promise.resolve(sse([chunk({ content: ACK_SENTENCE.id }), chunk({}, "stop")]));
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    };
    const started = Date.now();
    await expect(
      session(hanging, { limits: { hearShortMs: 40, firstByteMs: 5_000, silenceMs: 5_000 } }).hearShort(
        PCM,
        new AbortController().signal,
      ),
    ).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("acknowledgement", () => {
  it("is null until the words match, then cached, and a second open does not fetch again", async () => {
    let release: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let ackCalls = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      const json = JSON.parse(String(init?.body)) as Json;
      if (isAck(json)) {
        ackCalls += 1;
        return pending;
      }
      return sse([chunk({}, "stop")]);
    };
    const made = talker(fetchImpl, { voice: "AckVoice" });
    const open = made.open({ locale: "id", history: [] });
    expect(open.acknowledgement()).toBeNull();
    expect(acknowledgementWords({ model: MODEL, voice: "AckVoice", locale: "id" })).toBeNull();
    release(ackResponse({ messages: [{ role: "user", content: ACK_SENTENCE.id }] }));
    await whenAcknowledgementSettled({ model: MODEL, voice: "AckVoice", locale: "id" });
    expect(open.acknowledgement()).toEqual({ pcm: Buffer.from([1, 2]), text: ACK_SENTENCE.id });
    made.open({ locale: "id", history: [] });
    await whenAcknowledgementSettled({ model: MODEL, voice: "AckVoice", locale: "id" });
    expect(ackCalls).toBe(1);
  });

  it("does not cache a mismatch and does not try again", async () => {
    const { calls, fetchImpl } = install(() => sse([chunk({ content: "bukan kalimatnya" }), chunk({}, "stop")]), {
      ack: "script",
    });
    const made = talker(fetchImpl, { voice: "MismatchVoice" });
    const open = made.open({ locale: "en", history: [] });
    await whenAcknowledgementSettled({ model: MODEL, voice: "MismatchVoice", locale: "en" });
    expect(open.acknowledgement()).toBeNull();
    expect(acknowledgementWords({ model: MODEL, voice: "MismatchVoice", locale: "en" })).toBe("bukan kalimatnya");
    made.open({ locale: "en", history: [] });
    expect(calls.filter((call) => isAck(call.json))).toHaveLength(1);
  });
});
