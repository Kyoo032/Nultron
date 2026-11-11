import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool } from "../tools/define-tool";
import { invokeToolGuarded } from "./invoke-guarded";
import {
  createMediaPermission,
  isMediaPermissionRefusal,
  mediaGrantNote,
  mediaRequestArgs,
  mediaRequestKey,
  type MediaPermissionPolicy,
  type MediaRequest,
} from "./media-permission";
import { createToolBudget } from "./tool-budget";

const tenant = { tenantId: "t", workspaceId: "w", userId: "u" } as never;

const IMAGE: MediaRequest = { tool: "image_generate", args: { prompt: "a red fox", aspect_ratio: "square" } };
const VIDEO: MediaRequest = { tool: "video_generate", args: { prompt: "a fox runs", seconds: 5, resolution: "720p" } };

function policy(grants: MediaRequest[] = [], ask = true): MediaPermissionPolicy {
  return { ask, grants };
}

describe("mediaRequestArgs", () => {
  it("keeps only the fields that name the request, with whitespace collapsed", () => {
    expect(
      mediaRequestArgs("image_generate", { prompt: "  a red\n fox ", aspect_ratio: "square", unrelated: "x", style: "" }),
    ).toEqual({ prompt: "a red fox", aspect_ratio: "square" });
  });

  it("keeps finite numbers and drops the rest", () => {
    expect(mediaRequestArgs("video_generate", { prompt: "p", seconds: 5, resolution: Number.NaN })).toEqual({
      prompt: "p",
      seconds: 5,
    });
  });

  it("leaves out the placeholders a model fills in: a model of default, an example.com picture, a style of none", () => {
    expect(
      mediaRequestArgs("image_generate", {
        prompt: "a red fox",
        model: "default",
        image_url: "https://example.com/",
        style: "none",
        size: "auto",
        aspect_ratio: "square",
      }),
    ).toEqual({ prompt: "a red fox", aspect_ratio: "square" });
    expect(mediaRequestArgs("image_generate", { prompt: "p", image_url: "https://www.example.org/a.png" })).toEqual({ prompt: "p" });
    expect(mediaRequestArgs("video_generate", { prompt: "p", model: "null", image_url: "https://x.test/a.png" })).toEqual({ prompt: "p" });
  });

  it("keeps a real model, a real source picture and a prompt that happens to read like a placeholder", () => {
    expect(
      mediaRequestArgs("image_generate", {
        prompt: "default",
        model: "gpt-image-1-mini",
        image_url: "/api/v1/media/abc/file",
      }),
    ).toEqual({ prompt: "default", model: "gpt-image-1-mini", image_url: "/api/v1/media/abc/file" });
    expect(mediaRequestArgs("image_generate", { prompt: "p", image_url: "https://cdn.mysite.dev/a.png" })).toEqual({
      prompt: "p",
      image_url: "https://cdn.mysite.dev/a.png",
    });
  });

  it("reads a non-object as no fields", () => {
    expect(mediaRequestArgs("image_generate", "oops")).toEqual({});
    expect(mediaRequestArgs("image_generate", null)).toEqual({});
  });
});

describe("mediaRequestKey", () => {
  it("is the same for the same request, whatever the order or spacing", () => {
    const first = mediaRequestKey("image_generate", { prompt: "a red fox", aspect_ratio: "square" });
    const second = mediaRequestKey("image_generate", { aspect_ratio: "square", prompt: " a  red\nfox " });
    expect(first).toBe(second);
  });

  it("differs when the prompt, a setting or the tool differs", () => {
    const base = mediaRequestKey("image_generate", { prompt: "a red fox" });
    expect(mediaRequestKey("image_generate", { prompt: "a blue fox" })).not.toBe(base);
    expect(mediaRequestKey("image_generate", { prompt: "a red fox", aspect_ratio: "wide" })).not.toBe(base);
    expect(mediaRequestKey("video_generate", { prompt: "a red fox" })).not.toBe(base);
  });
});

describe("createMediaPermission", () => {
  it("is no gate for a policy that asks nothing, or no policy", () => {
    expect(createMediaPermission(undefined)).toBeUndefined();
    expect(createMediaPermission(policy([], false))).toBeUndefined();
  });

  it("lets every other tool through", () => {
    const gate = createMediaPermission(policy());
    expect(gate?.beforeCall("web_search", { query: "x" })).toBeNull();
    expect(gate?.beforeCall("calculator", { expression: "1+1" })).toBeNull();
  });

  it("refuses a picture or a clip nobody pressed Run on, and says what it would have made", () => {
    const gate = createMediaPermission(policy());
    const refusal = gate?.beforeCall("image_generate", { prompt: "a red fox", style: "" });
    expect(isMediaPermissionRefusal(refusal)).toBe(true);
    expect(refusal?.request).toEqual({ tool: "image_generate", args: { prompt: "a red fox" } });
    expect(refusal?.message).toMatch(/costs money/);
    expect(gate?.beforeCall("video_generate", { prompt: "a fox runs" })?.request.tool).toBe("video_generate");
  });

  it("lets one call through per grant, with the same arguments", () => {
    const gate = createMediaPermission(policy([IMAGE]));
    expect(gate?.beforeCall("image_generate", { prompt: "a red fox", aspect_ratio: "square" })).toBeNull();
    expect(gate?.beforeCall("image_generate", { prompt: "a red fox", aspect_ratio: "square" })).not.toBeNull();
  });

  it("counts two grants for the same request as two calls", () => {
    const gate = createMediaPermission(policy([IMAGE, IMAGE]));
    const call = { prompt: "a red fox", aspect_ratio: "square" };
    expect(gate?.beforeCall("image_generate", call)).toBeNull();
    expect(gate?.beforeCall("image_generate", call)).toBeNull();
    expect(gate?.beforeCall("image_generate", call)).not.toBeNull();
  });

  it("does not let a changed prompt, setting or tool use a grant meant for another request", () => {
    const gate = createMediaPermission(policy([IMAGE]));
    expect(gate?.beforeCall("image_generate", { prompt: "a red fox on a bike", aspect_ratio: "square" })).not.toBeNull();
    expect(gate?.beforeCall("image_generate", { prompt: "a red fox", aspect_ratio: "wide" })).not.toBeNull();
    expect(gate?.beforeCall("video_generate", { prompt: "a red fox", aspect_ratio: "square" })).not.toBeNull();
    expect(gate?.beforeCall("image_generate", { prompt: "a red fox", aspect_ratio: "square" })).toBeNull();
  });

  it("sees a call with the model's placeholders as the request the person pressed Run on", () => {
    const gate = createMediaPermission(policy([IMAGE]));
    const call = { prompt: "a red fox", aspect_ratio: "square", model: "default", image_url: "https://example.com/", style: "none" };
    expect(gate?.beforeCall("image_generate", call)).toBeNull();
  });

  it("still refuses a call that adds a real choice the card did not show", () => {
    const gate = createMediaPermission(policy([IMAGE]));
    expect(gate?.beforeCall("image_generate", { prompt: "a red fox", aspect_ratio: "square", model: "gpt-image-2" })).not.toBeNull();
    expect(gate?.beforeCall("image_generate", { prompt: "a red fox", aspect_ratio: "square", image_url: "/api/v1/media/x/file" })).not.toBeNull();
  });

  it("names the default model on a refusal that names none, and not on one that does", () => {
    const gate = createMediaPermission(policy());
    expect(gate?.beforeCall("image_generate", { prompt: "a red fox", model: "default" })?.defaultModel).toBe("gpt-image-2");
    // The built-in video fallback is the id proven on a prepaid key (2026-11-11), not Grok.
    expect(gate?.beforeCall("video_generate", { prompt: "a fox runs" })?.defaultModel).toBe("seedance-2.0-fast");
    expect(gate?.beforeCall("image_generate", { prompt: "a red fox", model: "gpt-image-1-mini" })?.defaultModel).toBeUndefined();
  });

  it("names the host's own default model when the host sets one, and the built-in one when it sets none", () => {
    const set = createMediaPermission(policy(), (tool) => (tool === "image_generate" ? "my-image-model" : undefined));
    expect(set?.beforeCall("image_generate", { prompt: "a red fox" })?.defaultModel).toBe("my-image-model");
    expect(set?.beforeCall("video_generate", { prompt: "a fox runs" })?.defaultModel).toBe("seedance-2.0-fast");
    expect(set?.beforeCall("image_generate", { prompt: "a red fox", model: "gpt-image-1-mini" })?.defaultModel).toBeUndefined();
  });

  it("hands a picture or clip its request's own fields to run with, and any other tool its args as they were", () => {
    const gate = createMediaPermission(policy());
    expect(gate?.argsToRun("image_generate", { prompt: " a  red\nfox ", model: "default", image_url: "https://example.com/", extra: 1 })).toEqual({
      prompt: "a red fox",
    });
    const web = { query: "x" };
    expect(gate?.argsToRun("web_search", web)).toBe(web);
  });

  it("keeps each grant to its own tool", () => {
    const gate = createMediaPermission(policy([VIDEO]));
    expect(gate?.beforeCall("video_generate", { prompt: "a fox runs", seconds: 5, resolution: "720p" })).toBeNull();
    expect(gate?.beforeCall("image_generate", { prompt: "a fox runs" })).not.toBeNull();
  });
});

describe("mediaGrantNote", () => {
  it("is empty without a grant", () => {
    expect(mediaGrantNote([])).toBe("");
  });

  it("names each call and its exact arguments", () => {
    const note = mediaGrantNote([IMAGE, VIDEO]);
    expect(note).toContain('image_generate with {"prompt":"a red fox","aspect_ratio":"square"}');
    expect(note).toContain('video_generate with {"prompt":"a fox runs","seconds":5,"resolution":"720p"}');
  });
});

describe("invokeToolGuarded with the gate", () => {
  let ran = 0;
  const fakeImage = defineTool({
    key: "image_generate",
    name: "fake",
    description: "fake",
    capability: "image_gen",
    schema: z.object({ prompt: z.string() }),
    execute: async () => {
      ran += 1;
      return { success: true };
    },
  } as never);

  it("answers a refusal and runs nothing, then runs once the request is granted", async () => {
    ran = 0;
    const blocked = await invokeToolGuarded(
      fakeImage,
      { prompt: "a red fox" },
      tenant,
      undefined,
      undefined,
      createMediaPermission(policy()),
    );
    expect(isMediaPermissionRefusal(blocked)).toBe(true);
    expect(ran).toBe(0);

    const allowed = await invokeToolGuarded(
      fakeImage,
      { prompt: "a red fox" },
      tenant,
      undefined,
      undefined,
      createMediaPermission(policy([{ tool: "image_generate", args: { prompt: "a red fox" } }])),
    );
    expect(allowed).toEqual({ success: true });
    expect(ran).toBe(1);
  });

  it("runs a granted call with the card's fields and none of the model's placeholders", async () => {
    let seen: unknown;
    const capture = defineTool({
      key: "image_generate",
      name: "fake",
      description: "fake",
      capability: "image_gen",
      schema: z.object({ prompt: z.string(), model: z.string().optional(), image_url: z.string().optional() }),
      execute: async (args: unknown) => {
        seen = args;
        return { success: true };
      },
    } as never);
    const gate = createMediaPermission(policy([{ tool: "image_generate", args: { prompt: "a red fox" } }]));
    const out = await invokeToolGuarded(
      capture,
      { prompt: "a  red fox", model: "default", image_url: "https://example.com/" },
      tenant,
      undefined,
      undefined,
      gate,
    );
    expect(out).toEqual({ success: true });
    expect(seen).toEqual({ prompt: "a red fox" });
  });

  it("spends a budget slot on a refused call, so a model cannot ask without end", async () => {
    const budget = createToolBudget({ maxSteps: 4, maxToolCalls: 1 });
    const gate = createMediaPermission(policy());
    const first = await invokeToolGuarded(fakeImage, { prompt: "a" }, tenant, budget, undefined, gate);
    const second = await invokeToolGuarded(fakeImage, { prompt: "b" }, tenant, budget, undefined, gate);
    expect(isMediaPermissionRefusal(first)).toBe(true);
    expect(second).toMatchObject({ ok: false, reason: "budget" });
  });

  it("runs as before with no gate", async () => {
    ran = 0;
    await invokeToolGuarded(fakeImage, { prompt: "a red fox" }, tenant);
    expect(ran).toBe(1);
  });
});
