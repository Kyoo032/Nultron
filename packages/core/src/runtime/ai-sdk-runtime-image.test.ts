import { afterEach, describe, expect, it, vi } from "vitest";
import { AiSdkRuntime } from "./ai-sdk-runtime";
import { EARLIER_IMAGE_NOT_VISIBLE_NOTE, VIDEO_NOT_VISIBLE_NOTE } from "../content/image-copy";
import type { AgentVersionRecord } from "../agents/service";
import type { ContentPart } from "../content/types";
import type { AppLocale } from "../locale";
import type { TenantContext } from "../tenancy/types";
import type { RuntimeEvent } from "./types";

/**
 * What the gateway receives for a turn that carries an image, on each wire the runtime speaks.
 * `fetch` is replaced, so nothing leaves the machine, but the request goes through the real AI SDK
 * and the real wire builders: what these tests read is the body the gateway would have been sent.
 */

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org",
  workspaceId: "ws",
  userId: "user",
  role: "owner",
};

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BASE64 = PNG.slice("data:image/png;base64,".length);

function versionFor(model: string): AgentVersionRecord {
  return {
    id: `v-${model}`,
    agentId: "chat",
    organizationId: "org",
    version: 1,
    systemPrompt: "You are helpful.",
    model,
    inputModalities: ["text", "image"],
    config: {},
    createdAt: new Date(),
  };
}

type Captured = { url: string; body: Record<string, unknown> };

/** Records every request and answers each with `status` and `message`, which ends the run at once. */
function gateway(status = 400, message = "stop here"): Captured[] {
  const seen: Captured[] = [];
  vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } }), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return seen;
}

async function run(options: {
  model: string;
  parts: ContentPart[];
  locale?: AppLocale;
  /** Earlier turns, before the one `parts` makes. */
  before?: Array<{ role: "user" | "assistant"; parts: ContentPart[] }>;
}): Promise<{ events: RuntimeEvent[]; thrown: unknown }> {
  const events: RuntimeEvent[] = [];
  let thrown: unknown;
  try {
    await new AiSdkRuntime({ openai: "sk-test", openaiBaseUrl: "https://gateway.test/v1" }).execute({
      tenant,
      runId: "run-image",
      modality: "image",
      version: versionFor(options.model),
      bindings: [],
      history: [...(options.before ?? []), { role: "user", parts: options.parts }],
      ...(options.locale ? { locale: options.locale } : {}),
      onEvent: (event) => {
        events.push(event);
      },
    });
  } catch (error) {
    thrown = error;
  }
  return { events, thrown };
}

const lookAtIt: ContentPart[] = [
  { type: "text", text: "What is in this image?" },
  { type: "image_url", image_url: { url: PNG } },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("an image in the person's turn", () => {
  it("goes out on the chat-completions wire as an image_url part carrying the bytes", async () => {
    const seen = gateway();
    await run({ model: "gpt-4o", parts: lookAtIt });
    expect(seen[0]?.url).toContain("/chat/completions");
    const user = ((seen[0]?.body.messages ?? []) as Array<{ role: string; content: unknown }>).find(
      (m) => m.role === "user",
    );
    expect(user?.content).toEqual([
      { type: "text", text: "What is in this image?" },
      { type: "image_url", image_url: { url: PNG } },
    ]);
  });

  it("goes out on the Responses wire as an input_image part", async () => {
    const seen = gateway();
    await run({ model: "gpt-6-luna", parts: lookAtIt });
    expect(seen[0]?.url).toContain("/responses");
    const input = seen[0]?.body.input as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const user = input.find((item) => item.role === "user");
    expect(user?.content).toEqual([
      { type: "input_text", text: "What is in this image?" },
      { type: "input_image", image_url: PNG },
    ]);
  });

  it("goes out on the Anthropic Messages wire as a base64 image source", async () => {
    const seen = gateway();
    await run({ model: "claude-sonnet-5-5", parts: lookAtIt });
    expect(seen[0]?.url).toContain("/messages");
    const messages = seen[0]?.body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const user = messages.find((message) => message.role === "user");
    expect(user?.content).toEqual([
      { type: "text", text: "What is in this image?" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } },
    ]);
  });

  it("is never replaced by a sentence that says an image is attached", async () => {
    for (const model of ["gpt-4o", "gpt-6-luna", "claude-sonnet-5-5", "glm-5.3-flash"]) {
      const seen = gateway();
      await run({ model, parts: lookAtIt });
      const wire = JSON.stringify(seen[0]?.body);
      expect(wire, model).not.toContain("Image attached in the local app");
      expect(wire, model).toContain(PNG_BASE64);
    }
  });

  it("refuses to build the request when the image is a reference only this machine can open", async () => {
    const seen = gateway();
    const { thrown } = await run({
      model: "gpt-4o",
      parts: [
        { type: "text", text: "What is in this image?" },
        { type: "image_url", image_url: { url: "/api/v1/media/f66a438a-781a-478b-8e67-c19be7771c20/file" } },
      ],
    });
    expect(String((thrown as Error)?.message)).toMatch(/could not be read/);
    expect(seen).toHaveLength(0);
  });

  it("says that in the desk's language", async () => {
    gateway();
    const { thrown } = await run({
      model: "gpt-4o",
      locale: "id",
      parts: [{ type: "image_url", image_url: { url: "/api/v1/media/f66a438a-781a-478b-8e67-c19be7771c20/file" } }],
    });
    expect(String((thrown as Error)?.message)).toMatch(/tidak bisa dibaca/);
  });
});

describe("a video in the person's turn", () => {
  it("tells the model it cannot see the video, and never that one is attached", async () => {
    const seen = gateway();
    await run({
      model: "gemini-3.5-flash",
      parts: [
        { type: "text", text: "Summarize this video." },
        { type: "video_url", video_url: { url: "/api/v1/media/f66a438a-781a-478b-8e67-c19be7771c20/file" } },
      ],
    });
    const wire = JSON.stringify(seen[0]?.body);
    expect(wire).not.toContain("Video attached in the local app");
    expect(wire).not.toContain("already shown to the user");
    expect(VIDEO_NOT_VISIBLE_NOTE).toMatch(/cannot see it/);
    expect(wire).toContain("cannot see it");
  });

  it("holds the note for an earlier image to the same standard", () => {
    expect(EARLIER_IMAGE_NOT_VISIBLE_NOTE).toMatch(/cannot see it/);
    expect(EARLIER_IMAGE_NOT_VISIBLE_NOTE).not.toMatch(/attached/i);
  });
});

describe("a gateway that refuses a request carrying an image", () => {
  function failedMessage(events: RuntimeEvent[]): string {
    const failed = events.find((event) => event.type === "run.failed");
    return failed && failed.type === "run.failed" ? failed.message : "";
  }

  it("is reported as a problem with the image, with the status kept", async () => {
    gateway(400, "image input is not supported for this model");
    const { events } = await run({ model: "gpt-4o", parts: lookAtIt });
    const message = failedMessage(events);
    expect(message).toContain("could not accept the image");
    expect(message).toContain("status_code=400");
    expect(message).not.toMatch(/shorter prompt/);
  });

  it("is reported in Bahasa Indonesia on an Indonesian desk", async () => {
    gateway(400, "image input is not supported for this model");
    const { events } = await run({ model: "gpt-4o", parts: lookAtIt, locale: "id" });
    expect(failedMessage(events)).toContain("tidak bisa menerima gambar");
  });

  it("treats a payload that is too large as the image's problem too", async () => {
    gateway(413, "request entity too large");
    const { events } = await run({ model: "gpt-4o", parts: lookAtIt });
    expect(failedMessage(events)).toContain("status_code=413");
    expect(failedMessage(events)).toContain("smaller image");
  });

  it("keeps the usual sentence for a 400 that is not about the image", async () => {
    gateway(400, "temperature is not allowed for this model");
    const { events } = await run({ model: "gpt-4o", parts: lookAtIt });
    expect(failedMessage(events)).toContain("The gateway rejected this request");
  });

  it("does not claim the image when the request had none", async () => {
    gateway(400, "image input is not supported for this model");
    const { events } = await run({ model: "gpt-4o", parts: [{ type: "text", text: "hello" }] });
    expect(failedMessage(events)).not.toContain("could not accept the image");
  });

  it("does not blame an image the person never attached: a picture the assistant made is not sent", async () => {
    const seen = gateway(400, "payload too large for this model");
    const { events } = await run({
      model: "gpt-4o",
      before: [
        { role: "user", parts: [{ type: "text", text: "Draw a lantern." }] },
        {
          role: "assistant",
          parts: [
            { type: "text", text: "Here it is." },
            { type: "image_url", image_url: { url: "/api/v1/media/f66a438a-781a-478b-8e67-c19be7771c20/file" } },
          ],
        },
      ],
      parts: [{ type: "text", text: "Now write a poem about it." }],
    });
    // Nothing of the assistant's picture is on the wire, and the refusal is not put down to it.
    expect(JSON.stringify(seen[0]?.body)).not.toContain("f66a438a");
    expect(failedMessage(events)).not.toContain("could not accept the image");
    expect(failedMessage(events)).toContain("status_code=400");
  });
});
