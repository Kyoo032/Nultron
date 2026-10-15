import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutoAllowedNotes, MediaApprovalCardView, MediaApprovalCards } from "@/components/chat-media-approval-card";
import { ChatTurn } from "@/components/chat-turn";
import {
  formatMediaUsd,
  readAutoAllowed,
  readPendingMedia,
  type PendingMedia,
} from "@/components/tool-rows/media-result";
import { applyLocale, resetLocaleForTests, t } from "@/lib/i18n";
import type { MediaFailure } from "@/lib/media-approval-client";
import { CHECKING, type MediaCardState } from "@/lib/media-approval-flow";
import { toolCallSummary } from "@/lib/tool-labels";

const here = dirname(fileURLToPath(import.meta.url));
const source = (relative: string) => readFileSync(resolve(here, relative), "utf8").replace(/\r\n/g, "\n");

const IMAGE: PendingMedia = { proposalId: "p1", kind: "image", prompt: "a red boat", amountMicros: 40000 };
const VIDEO: PendingMedia = { proposalId: "p2", kind: "video", prompt: "waves on a beach", amountMicros: null };
const PENDING_OUTPUT = {
  ok: true,
  status: "pending_approval",
  kind: "image",
  proposalId: "p1",
  prompt: "a red boat",
  estimate: { amountMicros: 40000, currency: "USD" },
};
const DONE_OUTPUT = {
  success: true,
  backend: "gateway",
  image: "/api/v1/media/m1/file",
  model: "gpt-image",
  prompt: "a cat",
};
const NOOP = () => undefined;

function state(over: Partial<MediaCardState>): MediaCardState {
  return { phase: "asking", action: null, status: null, result: null, failure: null, ...over };
}

function failure(over: Partial<MediaFailure>): MediaFailure {
  return { ok: false, code: "unknown", status: 500, message: null, ...over };
}

function card(cardState: MediaCardState, pending: PendingMedia = IMAGE): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <MediaApprovalCardView pending={pending} state={cardState} onGenerate={NOOP} onAlways={NOOP} onSkip={NOOP} />
    </MemoryRouter>,
  );
}

function turn(
  tools: readonly { key: string; status: "started" | "completed"; input?: unknown; output?: unknown }[],
): string {
  const content = tools.map((tool) => ({
    type: "tool_call",
    toolKey: tool.key,
    status: tool.status,
    input: tool.input,
    output: tool.output,
  }));
  return renderToStaticMarkup(
    <MemoryRouter>
      <ChatTurn role="assistant" content={content} />
    </MemoryRouter>,
  );
}

const count = (markup: string, needle: string) => markup.split(needle).length - 1;
const disabledAttributes = (markup: string) => count(markup, ' disabled=""');

beforeEach(() => {
  applyLocale("en");
});

afterEach(() => {
  resetLocaleForTests();
});

describe("reading a media call that waits for approval", () => {
  it("takes the proposal, kind, prompt and estimate from a pending output", () => {
    expect(readPendingMedia("image_generate", PENDING_OUTPUT)).toEqual({
      proposalId: "p1",
      kind: "image",
      prompt: "a red boat",
      amountMicros: 40000,
    });
  });

  it("reads an output that was stored as JSON text", () => {
    expect(readPendingMedia("video_generate", JSON.stringify({ ...PENDING_OUTPUT, kind: "video" }))?.kind).toBe(
      "video",
    );
  });

  it("reads a missing or negative estimate as an unknown price", () => {
    expect(readPendingMedia("image_generate", { ...PENDING_OUTPUT, estimate: undefined })?.amountMicros).toBeNull();
    expect(
      readPendingMedia("image_generate", { ...PENDING_OUTPUT, estimate: { amountMicros: -1 } })?.amountMicros,
    ).toBeNull();
    expect(
      readPendingMedia("image_generate", { ...PENDING_OUTPUT, estimate: { amountMicros: null } })?.amountMicros,
    ).toBeNull();
  });

  it("reads nothing from another tool, a finished result, or a malformed approval", () => {
    expect(readPendingMedia("build_deck", PENDING_OUTPUT)).toBeNull();
    expect(readPendingMedia("image_generate", DONE_OUTPUT)).toBeNull();
    expect(readPendingMedia("image_generate", { ...PENDING_OUTPUT, proposalId: "" })).toBeNull();
    expect(readPendingMedia("image_generate", { ...PENDING_OUTPUT, kind: "audio" })).toBeNull();
    expect(readPendingMedia("image_generate", { ok: false, status: "pending_approval" })).toBeNull();
    expect(readPendingMedia("image_generate", "not json")).toBeNull();
  });

  it("reads the autoAllowed flag only on a media tool", () => {
    expect(readAutoAllowed("image_generate", { ...DONE_OUTPUT, autoAllowed: true })).toBe(true);
    expect(readAutoAllowed("image_generate", DONE_OUTPUT)).toBe(false);
    expect(readAutoAllowed("build_deck", { autoAllowed: true })).toBe(false);
  });
});

describe("the estimate", () => {
  it("shows dollars with two to four decimals", () => {
    expect(formatMediaUsd(40000, "en")).toBe("$0.04");
    expect(formatMediaUsd(12300, "en")).toBe("$0.0123");
    expect(formatMediaUsd(2_000_000, "en")).toBe("$2.00");
    expect(formatMediaUsd(1_234_560, "en")).toBe("$1.2346");
  });

  it("uses the Indonesian decimal comma", () => {
    expect(formatMediaUsd(40000, "id")).toContain("0,04");
  });
});

describe("the approval card in each state", () => {
  it("asks for an image, with the prompt, the estimate and the three choices", () => {
    const html = card(state({ phase: "asking" }));
    expect(html).toContain("Generate this image?");
    expect(html).toContain("a red boat");
    expect(html).toContain("Estimated cost $0.04");
    expect(html).toContain("Generate");
    expect(html).toContain("Skip");
    expect(html).toContain("Always allow images");
    expect(disabledAttributes(html)).toBe(0);
  });

  it("asks for a video with no known price, and says so", () => {
    const html = card(state({ phase: "asking" }), VIDEO);
    expect(html).toContain("Generate this video?");
    expect(html).toContain("Price not known");
    expect(html).toContain("Always allow videos");
  });

  it("holds the buttons while the proposal is being read", () => {
    const html = card(CHECKING);
    expect(html).toContain('data-testid="media-approval-generate"');
    expect(disabledAttributes(html)).toBe(3);
  });

  it("shows the action that is running and holds the others", () => {
    const html = card(state({ phase: "working", action: "always" }));
    expect(html).toContain("Working…");
    expect(disabledAttributes(html)).toBe(3);
  });

  it("shows the generated picture with the same embed the chat uses for a result", () => {
    const html = card(state({ phase: "result", status: "generated", result: DONE_OUTPUT }));
    expect(html).toContain('data-testid="media-approval-result"');
    expect(html).toContain('data-testid="message-image"');
    expect(html).toContain("/api/v1/media/m1/file");
    expect(html).not.toContain("media-approval-generate");
  });

  it.each([
    ["generated", "Generated"],
    ["skipped", "Skipped"],
    ["expired", "Expired"],
    ["failed", "Failed"],
  ] as const)("shows a decided proposal as %s, with no buttons", (status, word) => {
    const html = card(state({ phase: "ended", status }));
    expect(html).toContain(`data-status="${status}"`);
    expect(html).toContain(word);
    expect(html).not.toContain("media-approval-generate");
  });

  it("is read-only for someone who did not ask", () => {
    const html = card(state({ phase: "readonly" }));
    expect(html).toContain("This can no longer be decided here.");
    expect(html).not.toContain("media-approval-generate");
  });

  it("names the models-off refusal and links to Settings", () => {
    const html = card(
      state({ phase: "asking", failure: failure({ code: "gateway_blocked", status: 403, message: "No key." }) }),
    );
    expect(html).toContain("Models are off until a key is added.");
    expect(html).toContain('data-testid="media-approval-settings"');
    expect(html).toContain('href="/settings"');
    expect(html).toContain('data-reason="gateway_blocked"');
  });

  it("says a quota refusal in the file-storage words", () => {
    const html = card(state({ failure: failure({ code: "storage_quota_exceeded", status: 403, message: "x" }) }));
    expect(html).toContain("There is no storage left for this, so it was not made.");
  });

  it("passes the host's own message through for any other refusal", () => {
    const html = card(
      state({ failure: failure({ code: "budget", status: 403, message: "The cap for this turn is used." }) }),
    );
    expect(html).toContain("The cap for this turn is used.");
  });

  it("says a dropped connection plainly, and a refusal with no message as a failure", () => {
    expect(card(state({ failure: failure({ code: "network", status: 0 }) }))).toContain("Could not reach the server.");
    expect(card(state({ failure: failure({ code: "unknown" }) }))).toContain("This did not work. Try again.");
  });

  it("never shows the word of the product's mascot or its name", () => {
    const every = [
      card(CHECKING),
      card(state({ phase: "asking" })),
      card(state({ phase: "working", action: "generate" })),
      card(state({ phase: "result", status: "generated", result: DONE_OUTPUT })),
      card(state({ phase: "ended", status: "failed" })),
      card(state({ phase: "readonly" })),
      card(state({ phase: "asking", failure: failure({ code: "gateway_blocked" }) })),
      card(state({ phase: "asking" }), VIDEO),
    ];
    for (const html of every) {
      expect(html.toLowerCase()).not.toContain("nultron");
    }
  });
});

describe("the cards in a chat turn", () => {
  it("draws nothing when no call is waiting for approval", () => {
    expect(renderToStaticMarkup(<MediaApprovalCards tools={[]} />)).toBe("");
    expect(
      renderToStaticMarkup(
        <MediaApprovalCards tools={[{ key: "image_generate", status: "completed", output: DONE_OUTPUT }]} />,
      ),
    ).toBe("");
  });

  it("draws one card per completed call that is waiting, and none for a call still running", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <MediaApprovalCards
          tools={[
            { key: "image_generate", status: "completed", output: PENDING_OUTPUT },
            { key: "video_generate", status: "started", output: undefined },
          ]}
        />
      </MemoryRouter>,
    );
    expect(count(html, 'data-testid="media-approval-card"')).toBe(1);
    expect(html).toContain("Generate this image?");
  });

  it("notes an auto-allowed result under its media, and only when there is media", () => {
    const withMedia = renderToStaticMarkup(
      <AutoAllowedNotes
        tools={[{ key: "image_generate", status: "completed", output: { ...DONE_OUTPUT, autoAllowed: true } }]}
      />,
    );
    expect(withMedia).toContain("Generated automatically (always allow is on)");
    expect(
      renderToStaticMarkup(
        <AutoAllowedNotes
          tools={[{ key: "image_generate", status: "completed", output: { success: false, autoAllowed: true } }]}
        />,
      ),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        <AutoAllowedNotes tools={[{ key: "image_generate", status: "completed", output: DONE_OUTPUT }]} />,
      ),
    ).toBe("");
  });

  it("puts the card in the turn, and leaves a turn without media exactly as it was", () => {
    const waiting = turn([
      { key: "image_generate", status: "completed", input: { prompt: "a red boat" }, output: PENDING_OUTPUT },
    ]);
    expect(waiting).toContain('data-testid="chat-media-approval-cards"');
    expect(waiting).toContain("Generate this image?");

    const plain = turn([
      { key: "image_generate", status: "completed", input: { prompt: "a cat" }, output: DONE_OUTPUT },
    ]);
    expect(plain).not.toContain("media-approval");
    expect(plain).not.toContain("chat-media-auto-allowed");
    expect(plain).not.toContain("Waiting for your OK");
  });
});

describe("the tool row in the Thinking disclosure", () => {
  it("says a call is waiting for the person's OK instead of listing the approval's fields", () => {
    expect(toolCallSummary("image_generate", { prompt: "a red boat" }, PENDING_OUTPUT)).toBe(
      `${t("chat.tool.image")} · Waiting for your OK`,
    );
  });

  it("keeps the one-line summary of a finished media call as it was", () => {
    expect(toolCallSummary("image_generate", { prompt: "a cat" }, DONE_OUTPUT)).toBe(
      `${t("chat.tool.image")} · a cat → ok`,
    );
  });
});

describe("the chat media wiring", () => {
  it("mounts both lists under the answer, beside the deck cards", () => {
    const chatTurn = source("../components/chat-turn.tsx");
    expect(chatTurn).toContain(
      'import { AutoAllowedNotes, MediaApprovalCards } from "@/components/chat-media-approval-card";',
    );
    expect(chatTurn).toContain("<AutoAllowedNotes tools={visibleTools} />");
    expect(chatTurn).toContain("<MediaApprovalCards tools={visibleTools} />");
    expect(chatTurn.indexOf("<MediaApprovalCards")).toBeLessThan(chatTurn.indexOf("<DeckCards"));
  });

  it("reuses the folder row's chip and row head classes", () => {
    const parts = source("../components/tool-rows/parts.tsx");
    expect(parts).toContain("export const CHIP =");
    expect(source("../components/chat-media-approval-card.tsx")).toContain(
      'import { CHIP, ROW_HEAD } from "@/components/tool-rows/parts";',
    );
  });

  it("keeps the media catalog in both locales", () => {
    const keys = [
      "chat.media.askImage",
      "chat.media.askVideo",
      "chat.media.estimate",
      "chat.media.priceUnknown",
      "chat.media.generate",
      "chat.media.skip",
      "chat.media.alwaysImage",
      "chat.media.alwaysVideo",
      "chat.media.working",
      "chat.media.notYours",
      "chat.media.gatewayBlocked",
      "chat.media.quota",
      "chat.media.network",
      "chat.media.failed",
      "chat.media.waitingRow",
      "chat.media.autoAllowed",
      "chat.media.status.generated",
      "chat.media.status.skipped",
      "chat.media.status.expired",
      "chat.media.status.failed",
    ];
    for (const locale of ["en", "id"] as const) {
      applyLocale(locale);
      for (const key of keys) {
        expect(t(key, { usd: "$1", settings: "Settings" }), `${locale} ${key}`).not.toBe(key);
      }
    }
  });
});
