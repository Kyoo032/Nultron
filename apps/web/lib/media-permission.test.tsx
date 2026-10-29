import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMediaPermission, type MediaRequest } from "@agentforge/core/media-permission";
import { DEFAULT_GATEWAY_IMAGE_MODEL, DEFAULT_GATEWAY_VIDEO_MODEL } from "@agentforge/core/media-kind";
import { MEDIA_PRICE_ENTRIES } from "@agentforge/core/media-pricing";
import { ChatTurn } from "@/components/chat-turn";
import { MediaPermissionCards } from "@/components/chat-media-permission-card";
import { applyLocale, resetLocaleForTests } from "@/lib/i18n";
import { buildChatRunBody } from "@/lib/chat-tier-body";
import {
  grantOf,
  permissionRequestOf,
  permissionRequestsOf,
  requestDetails,
  requestPriceLine,
  requestPrompt,
} from "@/lib/media-permission";
import { toolCallSummary } from "@/lib/tool-labels";

const here = dirname(fileURLToPath(import.meta.url));
const source = (relative: string) => readFileSync(resolve(here, relative), "utf8").replace(/\r\n/g, "\n");

const IMAGE_MODEL = MEDIA_PRICE_ENTRIES.find((entry) => entry.price.unit === "image")?.ids[0] ?? "";
const VIDEO_MODEL = MEDIA_PRICE_ENTRIES.find((entry) => entry.price.unit === "second")?.ids[0] ?? "";

/** What the tool really returns when the gate holds a call back, not a hand-written copy of it. */
function refusal(tool: "image_generate" | "video_generate", args: Record<string, unknown>) {
  const gate = createMediaPermission({ ask: true, grants: [] });
  const held = gate?.beforeCall(tool, args);
  if (!held) {
    throw new Error("the gate let the call through");
  }
  return held;
}

function call(tool: string, output: unknown, status: "started" | "completed" = "completed") {
  return { key: tool, status, output };
}

const count = (markup: string, testId: string) => markup.split(`data-testid="${testId}"`).length - 1;

beforeEach(() => {
  applyLocale("en");
});

afterEach(() => {
  resetLocaleForTests();
});

describe("the fixtures", () => {
  it("name models the price table lists", () => {
    expect(IMAGE_MODEL).not.toBe("");
    expect(VIDEO_MODEL).not.toBe("");
  });
});

describe("permissionRequestOf", () => {
  it("reads the request off a held back picture or clip", () => {
    const image = permissionRequestOf(call("image_generate", refusal("image_generate", { prompt: "a red fox", aspect_ratio: "1:1" })));
    expect(image).toMatchObject({ tool: "image_generate", args: { prompt: "a red fox", aspect_ratio: "1:1" } });
    const clip = permissionRequestOf(call("video_generate", refusal("video_generate", { prompt: "waves", seconds: 5 })));
    expect(clip).toMatchObject({ tool: "video_generate", args: { prompt: "waves", seconds: 5 } });
  });

  it("carries the model the tool falls back to when the request names none, and none when it does", () => {
    const bare = permissionRequestOf(call("image_generate", refusal("image_generate", { prompt: "a red fox" })));
    expect(bare?.defaultModel).toBe(DEFAULT_GATEWAY_IMAGE_MODEL);
    const named = permissionRequestOf(call("image_generate", refusal("image_generate", { prompt: "a red fox", model: IMAGE_MODEL })));
    expect(named?.defaultModel).toBeUndefined();
    const clip = permissionRequestOf(call("video_generate", refusal("video_generate", { prompt: "waves" })));
    expect(clip?.defaultModel).toBe(DEFAULT_GATEWAY_VIDEO_MODEL);
  });

  it("is null for a call that ran, one still running, or any other tool", () => {
    expect(permissionRequestOf(call("image_generate", { ok: true, url: "/media/a.png" }))).toBeNull();
    expect(permissionRequestOf(call("image_generate", refusal("image_generate", { prompt: "x" }), "started"))).toBeNull();
    expect(permissionRequestOf(call("web_search", refusal("image_generate", { prompt: "x" })))).toBeNull();
    expect(permissionRequestOf(call("image_generate", undefined))).toBeNull();
  });

  it("is null for a refusal that only looks like one", () => {
    const forged = { ok: false, reason: "permission", message: "x", request: { tool: "delete_everything", args: {} } };
    expect(permissionRequestOf(call("image_generate", forged))).toBeNull();
  });
});

describe("permissionRequestsOf", () => {
  it("keeps the order the model asked in and shows the same request once", () => {
    const fox = refusal("image_generate", { prompt: "a red fox" });
    const waves = refusal("video_generate", { prompt: "waves", seconds: 5 });
    const found = permissionRequestsOf([
      call("image_generate", fox),
      call("video_generate", waves),
      call("image_generate", refusal("image_generate", { prompt: "a  red\nfox" })),
    ]);
    expect(found.map((request) => request.tool)).toEqual(["image_generate", "video_generate"]);
  });

  it("is empty when nothing was held back", () => {
    expect(permissionRequestsOf([call("web_search", { ok: true })])).toEqual([]);
  });
});

describe("requestPriceLine", () => {
  it("prices a picture from the table when a listed model is named", () => {
    const line = requestPriceLine({ tool: "image_generate", args: { prompt: "x", model: IMAGE_MODEL } });
    expect(line).toMatch(/^About \$\d/);
    expect(line).toContain("a list price, not a quote");
  });

  it("prices a clip by its seconds", () => {
    const line = requestPriceLine({ tool: "video_generate", args: { prompt: "x", model: VIDEO_MODEL, seconds: 5 } });
    expect(line).toMatch(/^About \$\d/);
    expect(line).toContain("5 s");
  });

  it("says no price is known rather than guessing, for no model, an unlisted model, or a clip with no length", () => {
    const unknown = "No price is known for this one before it runs.";
    expect(requestPriceLine({ tool: "image_generate", args: { prompt: "x" } })).toBe(unknown);
    expect(requestPriceLine({ tool: "image_generate", args: { prompt: "x", model: "not-a-model" } })).toBe(unknown);
    expect(requestPriceLine({ tool: "video_generate", args: { prompt: "x", model: VIDEO_MODEL } })).toBe(unknown);
  });

  it("prices the model the tool falls back to when the request names none", () => {
    const line = requestPriceLine({ tool: "image_generate", args: { prompt: "x" }, defaultModel: IMAGE_MODEL });
    expect(line).toMatch(/^About \$\d/);
    const clip = requestPriceLine({ tool: "video_generate", args: { prompt: "x", seconds: 5 }, defaultModel: VIDEO_MODEL });
    expect(clip).toMatch(/^About \$\d/);
  });

  it("prefers the model the request names over the default, and admits an unlisted default", () => {
    const named = requestPriceLine({ tool: "image_generate", args: { prompt: "x", model: "not-a-model" }, defaultModel: IMAGE_MODEL });
    expect(named).toBe("No price is known for this one before it runs.");
    const unlisted = requestPriceLine({ tool: "image_generate", args: { prompt: "x" }, defaultModel: "not-a-model" });
    expect(unlisted).toBe("No price is known for this one before it runs.");
  });

  it("does not price a clip as a picture or a picture as a clip", () => {
    expect(requestPriceLine({ tool: "image_generate", args: { prompt: "x", model: VIDEO_MODEL } })).toBe(
      "No price is known for this one before it runs.",
    );
    expect(requestPriceLine({ tool: "video_generate", args: { prompt: "x", model: IMAGE_MODEL, seconds: 5 } })).toBe(
      "No price is known for this one before it runs.",
    );
  });
});

describe("requestPrompt and requestDetails", () => {
  it("quote the prompt and list the model, shape and length", () => {
    const request: MediaRequest = {
      tool: "video_generate",
      args: { prompt: "waves", model: "some-model", aspect_ratio: "16:9", seconds: 8, resolution: "720p" },
    };
    expect(requestPrompt(request)).toBe("waves");
    expect(requestDetails(request)).toEqual(["Model: some-model", "16:9", "8 s", "720p"]);
  });

  it("names the default model when the request names none, and only then", () => {
    expect(requestDetails({ tool: "image_generate", args: { prompt: "x" }, defaultModel: "gpt-image-2" })).toEqual([
      "Model: gpt-image-2 (the default)",
    ]);
    expect(requestDetails({ tool: "image_generate", args: { prompt: "x", model: "mine" }, defaultModel: "gpt-image-2" })).toEqual([
      "Model: mine",
    ]);
  });

  it("prefers an image size over its aspect ratio and shows nothing for a bare prompt", () => {
    expect(requestDetails({ tool: "image_generate", args: { prompt: "x", size: "1024x1024", aspect_ratio: "1:1" } })).toEqual([
      "1024x1024",
    ]);
    expect(requestDetails({ tool: "image_generate", args: { prompt: "x" } })).toEqual([]);
  });
});

describe("grantOf", () => {
  it("keeps the request and leaves out the default the card priced it by", () => {
    const shown = { tool: "image_generate" as const, args: { prompt: "a red fox" }, defaultModel: "gpt-image-2" };
    expect(grantOf(shown)).toEqual({ tool: "image_generate", args: { prompt: "a red fox" } });
  });
});

describe("the card", () => {
  const fox: MediaRequest = { tool: "image_generate", args: { prompt: "a red fox", model: IMAGE_MODEL } };
  const waves: MediaRequest = { tool: "video_generate", args: { prompt: "waves", model: VIDEO_MODEL, seconds: 5 } };

  function render(props: Parameters<typeof MediaPermissionCards>[0]): string {
    return renderToStaticMarkup(<MediaPermissionCards {...props} />);
  }

  it("draws nothing without a request", () => {
    expect(render({ requests: [] })).toBe("");
  });

  it("shows what would be made and its price, with Run and Not now, when it can act", () => {
    const html = render({ requests: [fox], onRun: () => undefined });
    expect(html).toContain('data-actionable="true"');
    expect(html).toContain("Make a picture");
    expect(html).toMatch(/data-testid="chat-media-prompt"[^>]*>a red fox</);
    expect(html).toContain("About $");
    expect(html).toContain("Nothing starts until you press Run.");
    expect(html).toMatch(/data-testid="chat-media-run"[^>]*>Run</);
    expect(count(html, "chat-media-dismiss")).toBe(1);
  });

  it("shows the default model and its price for a request that names none", () => {
    const bare = { tool: "image_generate" as const, args: { prompt: "a red fox" }, defaultModel: IMAGE_MODEL };
    const html = render({ requests: [bare], onRun: () => undefined });
    expect(html).toContain(`Model: ${IMAGE_MODEL} (the default)`);
    expect(html).toContain("About $");
  });

  it("runs several requests with one press, and says how many", () => {
    const html = render({ requests: [fox, waves], onRun: () => undefined });
    expect(count(html, "chat-media-request")).toBe(2);
    expect(html).toContain("Run all 2");
    expect(html).toContain("Make a clip");
  });

  it("only records the request once the turn was followed up: no buttons, no pending label", () => {
    const html = render({ requests: [fox] });
    expect(html).toContain('data-actionable="false"');
    expect(html).toContain("a red fox");
    expect(html).not.toContain("chat-media-run");
    expect(html).not.toContain("chat-media-dismiss");
    expect(html).not.toContain("Needs your OK");
  });

  it("holds Run while a run is going", () => {
    const html = render({ requests: [fox], onRun: () => undefined, disabled: true });
    expect(html).toMatch(/<button[^>]*data-testid="chat-media-run"[^>]*disabled/);
  });

  it("speaks Indonesian when the desk does", () => {
    applyLocale("id");
    const html = render({ requests: [fox], onRun: () => undefined });
    expect(html).toContain("Buat gambar");
    expect(html).toContain("Jalankan");
    expect(html).toContain("Nanti saja");
    expect(html).not.toContain("Make a picture");
  });
});

describe("a Chat turn that was held back", () => {
  const held = refusal("image_generate", { prompt: "a red fox", model: IMAGE_MODEL });
  const saved = [
    { type: "tool_call" as const, toolKey: "image_generate", status: "completed" as const, input: { prompt: "a red fox" }, output: held },
    { type: "text" as const, text: "I can make that fox once you press Run." },
  ];

  function turn(onRunMedia?: (requests: MediaRequest[]) => void): string {
    return renderToStaticMarkup(
      <MemoryRouter>
        <ChatTurn role="assistant" content={saved} {...(onRunMedia ? { onRunMedia } : {})} />
      </MemoryRouter>,
    );
  }

  it("rebuilds the card from the saved turn, with Run on the newest reply", () => {
    const html = turn(() => undefined);
    expect(count(html, "chat-media-permission")).toBe(1);
    expect(count(html, "chat-media-run")).toBe(1);
  });

  it("keeps the card without Run on an older reply", () => {
    const html = turn();
    expect(count(html, "chat-media-permission")).toBe(1);
    expect(count(html, "chat-media-run")).toBe(0);
  });

  it("labels the tool row as waiting, not as a finished picture", () => {
    expect(toolCallSummary("image_generate", { prompt: "a red fox" }, held)).toBe("Picture waiting for your OK");
    expect(toolCallSummary("video_generate", {}, refusal("video_generate", { prompt: "waves" }))).toBe("Clip waiting for your OK");
  });
});

describe("the grants on a run body", () => {
  const grant: MediaRequest = { tool: "image_generate", args: { prompt: "a red fox" } };

  it("are absent on an ordinary send", () => {
    expect(Object.keys(buildChatRunBody("hi", "daily")).sort()).toEqual(["content", "tier"]);
    expect(Object.keys(buildChatRunBody("hi", "daily", false, [])).sort()).toEqual(["content", "tier"]);
  });

  it("ride in paidMedia after a Run press, and never turn the gate off", () => {
    const body = buildChatRunBody("Run it", "daily", false, [grant]);
    expect(body).toEqual({ content: "Run it", tier: "daily", paidMedia: { grants: [grant] } });
    expect(JSON.stringify(body)).not.toContain("ask");
  });
});

describe("the wiring", () => {
  const session = source("../components/chat-session.tsx");
  const composer = source("../components/chat-composer.tsx");
  const turn = source("../components/chat-turn.tsx");
  const card = source("../components/chat-media-permission-card.tsx");

  it("sends the request alone on Run, never the default model the card priced it by", () => {
    expect(card).toContain("onRun?.(requests.map(grantOf))");
  });

  it("offers Run only on the newest reply and sends the grants with the word the person pressed", () => {
    expect(session).toContain("onRunMedia={");
    expect(session).toContain('continueSendRef.current?.(t("chat.media.runPrompt"), false, requests)');
    expect(session.indexOf("onRunMedia={")).toBeGreaterThan(session.indexOf("mayOfferContinue(index, shown.length, message.role)"));
    expect(turn).toContain("permissionRequestsOf(visibleTools)");
  });

  it("lets the grants reach only the text run, not the image or video run", () => {
    expect(composer).toContain("buildChatRunBody(outgoing, tier, retrying, grants)");
    expect(composer).toContain("buildChatRunBody(parts, tier)");
  });
});
