/**
 * An image attached in Chat reaches the model as pixels, or the person is told why it cannot.
 *
 * The owner's report (2026-10-06, live preview): a PNG sent on "GLM 5.3" came back as "the image isn't
 * reaching me. The attachment came through only as a note that a screenshot was added in the app."
 * The turn was built from the stored `/api/v1/media/<id>/file` URL, and a remote gateway cannot open
 * that, so the runtime swapped the image for a sentence. Nothing told the person.
 *
 * Real router-side code (`startModalityRun`, the media store, the thread store), the real AI SDK
 * runtime and the real wire body. The only stand-in is `fetch`, which records what the gateway would
 * have received and answers like one.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, ContentPart, TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";

vi.mock("@agentforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentforge/core")>();
  return {
    ...actual,
    createRuntime: (): AgentRuntime => {
      const runtime = new actual.AiSdkRuntime({ openai: "sk-test", openaiBaseUrl: "https://api.tokotokenai.com/v1" });
      // The same masking the real `createRuntime` applies to the outbound copy.
      return { execute: (input) => runtime.execute(actual.maskOutboundRunInput(input)) };
    },
  };
});

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;

type Captured = { url: string; body: Record<string, unknown> };
let seen: Captured[] = [];
/** What the stand-in gateway answers. Overridden per test. */
let answer: (request: Captured) => Response = () => okStream("It is a one pixel image.");

const encoder = new TextEncoder();

function okStream(text: string): Response {
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  const frames = [
    {
      id: "c1",
      object: "chat.completion.chunk",
      created: 1,
      model: "m",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    {
      id: "c1",
      object: "chat.completion.chunk",
      created: 1,
      model: "m",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage,
    },
  ];
  const body = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(encoder.encode(body), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function refused(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function drain(run: AsyncIterable<string>): Promise<string> {
  let raw = "";
  for await (const chunk of run) {
    raw += chunk;
  }
  return raw;
}

function framesOf(raw: string): Array<Record<string, unknown>> {
  return raw
    .split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
}

type WireMessage = { role: string; content: unknown };

/** The user messages of the one chat-completions request, content always as an array of parts. */
function userMessages(request: Captured): Array<Array<Record<string, unknown>>> {
  const messages = (request.body.messages ?? []) as WireMessage[];
  return messages
    .filter((message) => message.role === "user")
    .map((message) =>
      Array.isArray(message.content)
        ? (message.content as Array<Record<string, unknown>>)
        : [{ type: "text", text: String(message.content) }],
    );
}

function wireText(request: Captured): string {
  return JSON.stringify(request.body);
}

let tenant: TenantContext;
let agentId = "";

async function newThread(): Promise<string> {
  const { createThread } = await import("./threads");
  return (await createThread(tenant, agentId, "Image turn")).id;
}

async function storeImage(bytes: Buffer = PNG_BYTES): Promise<string> {
  const { saveMedia } = await import("./media");
  const row = await saveMedia(tenant, new File([new Uint8Array(bytes)], "screenshot.png", { type: "image/png" }));
  return row.url;
}

async function sendImage(threadId: string, model: string, url: string, caption = "What is in this image?") {
  const { startModalityRun } = await import("./runs");
  const content: ContentPart[] = [
    { type: "text", text: caption },
    { type: "image_url", image_url: { url, detail: "high" } },
  ];
  return drain(startModalityRun({ tenant, threadId, modality: "image", body: { content, model } }));
}

async function sendText(threadId: string, model: string, text: string) {
  const { startModalityRun } = await import("./runs");
  return drain(startModalityRun({ tenant, threadId, modality: "text", body: { content: text, model } }));
}

beforeAll(async () => {
  const { agentService, getTenant } = await import("./tenant");
  tenant = await getTenant();
  agentId = (await agentService.ensureDefaultChat(tenant)).agent.id;
  // Load the run path once, here, so the cases below are not charged for the import.
  await import("./runs");
  await import("./media");
  await import("./threads");
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(() => {
  seen = [];
  answer = () => okStream("It is a one pixel image.");
  vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
    const request: Captured = {
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    seen.push(request);
    return answer(request);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
});

describe("Chat image turn, as the gateway receives it", () => {
  it("sends the pixels of the attached image to a model that reads images", async () => {
    const thread = await newThread();
    const url = await storeImage();
    await sendImage(thread, "gpt-4o", url);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toContain("/chat/completions");
    const [turn] = userMessages(seen[0] as Captured);
    const image = turn?.find((part) => part.type === "image_url") as { image_url: { url: string } } | undefined;
    expect(image, `no image part reached the gateway: ${wireText(seen[0] as Captured)}`).toBeDefined();
    // Bytes, not a reference: the gateway cannot open /api/v1/media/... on this machine.
    expect(image?.image_url.url).toBe(PNG_DATA_URL);
    // The only media path on the wire is the reference line beside the pixels, never an image_url.
    expect(wireText(seen[0] as Captured).match(/\/api\/v1\/media\//g)).toHaveLength(1);
    expect(wireText(seen[0] as Captured)).toContain("pass it to image_generate to edit this image");
    expect(wireText(seen[0] as Captured)).not.toContain("Image attached in the local app");
  });

  it("keeps the text around the image masked and the image itself whole", async () => {
    const thread = await newThread();
    const url = await storeImage();
    await sendImage(thread, "gpt-4o", url, "Email the answer to jane.doe@example.com please");

    const [turn] = userMessages(seen[0] as Captured);
    const text = (turn ?? [])
      .filter((part) => part.type === "text")
      .map((part) => String(part.text))
      .join(" ");
    expect(text).not.toContain("jane.doe@example.com");
    const image = turn?.find((part) => part.type === "image_url") as { image_url: { url: string } } | undefined;
    expect(image?.image_url.url).toBe(PNG_DATA_URL);
  });

  it("refuses an image turn for a model known to be text-only, before any gateway call", async () => {
    const thread = await newThread();
    const url = await storeImage();
    // The owner's model: "GLM 5.3". The catalog says it reads no images.
    await expect(sendImage(thread, "glm-5.3", url)).rejects.toMatchObject({
      code: "model_missing_modality",
      status: 400,
    });
    expect(seen).toHaveLength(0);
  });

  it("sends an earlier image again on a later text turn, so the thread keeps its context", async () => {
    const thread = await newThread();
    const url = await storeImage();
    await sendImage(thread, "gpt-4o", url);
    seen = [];
    await sendText(thread, "gpt-4o", "And what colour is it?");

    expect(seen).toHaveLength(1);
    const earlier = userMessages(seen[0] as Captured)[0];
    const image = earlier?.find((part) => part.type === "image_url") as { image_url: { url: string } } | undefined;
    expect(image?.image_url.url).toBe(PNG_DATA_URL);
    expect(wireText(seen[0] as Captured)).not.toContain("Image attached in the local app");
  });

  it("tells a text-only model that an earlier image exists and cannot be seen, never that it is attached", async () => {
    const thread = await newThread();
    const url = await storeImage();
    await sendImage(thread, "gpt-4o", url);
    seen = [];
    await sendText(thread, "glm-5.3", "Summarise what we said.");

    expect(seen).toHaveLength(1);
    const wire = wireText(seen[0] as Captured);
    expect(wire).not.toContain("data:image/png");
    expect(wire).not.toContain("Image attached in the local app");
    expect(wire).toMatch(/cannot see/i);
  });

  it("shows the person a clear sentence when the gateway refuses the image", async () => {
    const thread = await newThread();
    const url = await storeImage();
    answer = () => refused(400, "image input is not supported for this model");
    const raw = await sendImage(thread, "gpt-4o", url);

    const failed = framesOf(raw).find((frame) => frame.type === "run.failed");
    expect(failed, raw).toBeDefined();
    const message = String(failed?.message);
    expect(message).toMatch(/image/i);
    expect(message).toContain("status_code=400");
    // The generic advice, "send again with a shorter prompt", is wrong for an image.
    expect(message).not.toMatch(/shorter prompt/i);
  });
});

/**
 * An image part is whatever a request says it is. The composer sends only the file it uploaded as an image,
 * but the route takes any `image_url` part, so each of these is what a hand-made request could send.
 */
describe("Chat image turn the host will not send", () => {
  async function storedMessages(threadId: string) {
    const { listMessages } = await import("./threads");
    return listMessages(tenant, threadId);
  }

  function failedMessage(raw: string): string {
    const failed = framesOf(raw).find((frame) => frame.type === "run.failed");
    expect(failed, raw).toBeDefined();
    return String(failed?.message);
  }

  async function storeVideo(): Promise<string> {
    const { saveMedia } = await import("./media");
    const row = await saveMedia(
      tenant,
      new File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], "clip.mp4", { type: "video/mp4" }),
    );
    return row.url;
  }

  it("refuses a stored video named as an image, without reading it and without storing the turn", async () => {
    const thread = await newThread();
    const raw = await sendImage(thread, "gpt-4o", await storeVideo());

    expect(failedMessage(raw)).toMatch(/could not be read/);
    expect(seen).toHaveLength(0);
    // Refused before the message is stored: no bubble is left in the thread with no answer.
    expect(await storedMessages(thread)).toHaveLength(0);
  });

  it("refuses an https link to an image in words, and fetches nothing", async () => {
    const thread = await newThread();
    const raw = await sendImage(thread, "gpt-4o", "https://169.254.169.254/latest/meta-data/x.png");

    expect(failedMessage(raw)).toBe("A web link to an image can't be sent to the model. Attach the image itself.");
    expect(seen).toHaveLength(0);
    expect(await storedMessages(thread)).toHaveLength(0);
  });

  it("refuses a picture over the request budget in words, before it is read or the turn is stored", async () => {
    const thread = await newThread();
    const url = await storeImage(Buffer.alloc(7 * 1024 * 1024, 1));
    const raw = await sendImage(thread, "gpt-4o", url);

    expect(failedMessage(raw)).toMatch(/too large to send together \(over 6 MB\)/);
    expect(seen).toHaveLength(0);
    expect(await storedMessages(thread)).toHaveLength(0);
  });

  it("sends a picture just under the budget", async () => {
    const thread = await newThread();
    const url = await storeImage(Buffer.alloc(5 * 1024 * 1024, 1));
    await sendImage(thread, "gpt-4o", url);

    expect(seen).toHaveLength(1);
    expect(wireText(seen[0] as Captured)).toContain("data:image/png;base64,");
    expect(await storedMessages(thread)).toHaveLength(2);
  });

  it("gives an earlier turn that names a stored video the note, never the video's bytes", async () => {
    const thread = await newThread();
    const { insertMessage } = await import("./threads");
    const videoUrl = await storeVideo();
    await insertMessage(tenant, thread, "user", [
      { type: "text", text: "look at this" },
      { type: "image_url", image_url: { url: videoUrl } },
    ]);
    await sendText(thread, "gpt-4o", "And now?");

    expect(seen).toHaveLength(1);
    const wire = wireText(seen[0] as Captured);
    expect(wire).not.toContain("data:video");
    expect(wire).not.toContain("data:image");
    expect(wire).toMatch(/cannot see/i);
  });

  it("refuses without storing the turn when the picture is gone from the store", async () => {
    const thread = await newThread();
    const raw = await sendImage(thread, "gpt-4o", "/api/v1/media/f66a438a-781a-478b-8e67-c19be7771c20/file");

    expect(failedMessage(raw)).toMatch(/could not be read/);
    expect(await storedMessages(thread)).toHaveLength(0);
  });
});
