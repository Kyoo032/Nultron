/**
 * The deck a Chat turn made: what the result reader takes from a `build_deck` call, the card that shows
 * it under the answer, and the one slide preview it reuses from the Presentation mode.
 *
 * The card is rebuilt from the tool call alone (its input holds the outline, its output the artifact
 * id), so a thread reopened tomorrow draws the same card: the saved-turn cases below pass only what the
 * host stored. The renderer's vitest has no DOM, so presses are covered by the pure pieces and the
 * wiring is read from the source, as the other render tests here do; the real click is
 * `download-clients.test.ts` (the client call) and `apps/web/server/deck-download.test.ts` (the host).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatTurn } from "@/components/chat-turn";
import { DeckCard } from "@/components/chat-deck-card";
import { isDeckTool, readDeckResult, type DeckCardModel } from "@/components/tool-rows/deck-result";
import { applyLocale, resetLocaleForTests } from "@/lib/i18n";

const here = dirname(fileURLToPath(import.meta.url));
const source = (relative: string) => readFileSync(resolve(here, relative), "utf8").replace(/\r\n/g, "\n");

const INPUT = {
  title: "Warung expansion plan",
  slides: [
    {
      kind: "section",
      heading: "Why a second shop now",
      subhead: "Demand outgrew one counter",
      bullets: [],
      notes: "Open.",
    },
    { kind: "bullets", heading: "Sales grew for six months", bullets: ["Lunch orders doubled", "Delivery is a third"] },
    { kind: "close", heading: "Decision needed this month", bullets: ["Approve the lease"] },
  ],
};
const OUTPUT = { ok: true, artifactId: "art-1", filename: "warung-expansion-plan.pptx", slideCount: 4 };

const count = (markup: string, testId: string) => markup.split(`data-testid="${testId}"`).length - 1;

function model(over: Partial<DeckCardModel> = {}): DeckCardModel {
  const read = readDeckResult(INPUT, OUTPUT);
  if (!read) {
    throw new Error("fixture does not read");
  }
  return { ...read, ...over };
}

function card(props: { model?: DeckCardModel; defaultOpen?: boolean } = {}): string {
  return renderToStaticMarkup(<DeckCard model={props.model ?? model()} defaultOpen={props.defaultOpen} />);
}

beforeEach(() => {
  applyLocale("en");
});

afterEach(() => {
  resetLocaleForTests();
});

describe("reading a build_deck call", () => {
  it("takes the artifact, file name and slide count from the output and the outline from the input", () => {
    const read = readDeckResult(INPUT, OUTPUT);
    expect(read).toMatchObject({
      artifactId: "art-1",
      filename: "warung-expansion-plan.pptx",
      slideCount: 4,
      title: "Warung expansion plan",
    });
    expect(read?.outline?.slides).toHaveLength(3);
    // The renderer's own parse fills the parts the model left out, as the host's does.
    expect(read?.outline?.slides[1]).toMatchObject({ kind: "bullets", subhead: "", aside: "", notes: "", shapes: [] });
  });

  it("reads input and output that were stored as JSON text", () => {
    expect(readDeckResult(JSON.stringify(INPUT), JSON.stringify(OUTPUT))?.artifactId).toBe("art-1");
  });

  it("reads nothing from a refusal, a missing id, or a call that has not finished", () => {
    expect(readDeckResult(INPUT, { ok: false, reason: "checks", message: "ERROR: ..." })).toBeNull();
    expect(readDeckResult(INPUT, { ok: false, reason: "budget", message: "spent" })).toBeNull();
    expect(readDeckResult(INPUT, { ok: true, filename: "a.pptx", slideCount: 2 })).toBeNull();
    expect(readDeckResult(INPUT, { ok: true, artifactId: "", filename: "a.pptx", slideCount: 2 })).toBeNull();
    expect(readDeckResult(INPUT, undefined)).toBeNull();
    expect(readDeckResult(INPUT, "not json")).toBeNull();
  });

  it("keeps the card when the outline cannot be read, and shows the title it can find", () => {
    const read = readDeckResult({ title: "Only a title", slides: "nope" }, OUTPUT);
    expect(read).toMatchObject({ outline: null, title: "Only a title", artifactId: "art-1" });
    expect(readDeckResult(undefined, OUTPUT)).toMatchObject({ outline: null, title: "warung-expansion-plan.pptx" });
  });

  it("counts the file's slides from the output, never from the input", () => {
    expect(readDeckResult(INPUT, { ...OUTPUT, slideCount: 9 })?.slideCount).toBe(9);
    expect(readDeckResult(INPUT, { ...OUTPUT, slideCount: "4" })?.slideCount).toBe(4);
  });

  it("knows the tool by its key", () => {
    expect(isDeckTool("build_deck")).toBe(true);
    expect(isDeckTool("write_file")).toBe(false);
  });
});

describe("the card, collapsed", () => {
  it("shows the title, the slide count, the file name and the first slides, and no preview", () => {
    const html = card();
    expect(count(html, "chat-deck-card")).toBe(1);
    expect(html).toContain('data-artifact-id="art-1"');
    expect(html).toContain("Warung expansion plan");
    expect(html).toContain("4 slides");
    expect(html).toContain("warung-expansion-plan.pptx");
    expect(html).toContain("Why a second shop now");
    expect(count(html, "chat-deck-outline")).toBe(1);
    expect(count(html, "presentations-preview")).toBe(0);
  });

  it("has an Open control that is closed, and a Download button", () => {
    const html = card();
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*data-testid="chat-deck-open"[^>]*>Open<\/button>/);
    expect(html).toMatch(/<button[^>]*data-testid="chat-deck-download"[^>]*>Download<\/button>/);
    expect(html).toContain('aria-label="Download Warung expansion plan as warung-expansion-plan.pptx"');
  });

  it("says one slide in the singular", () => {
    expect(card({ model: model({ slideCount: 1 }) })).toContain("1 slide");
    expect(card({ model: model({ slideCount: 1 }) })).not.toContain("1 slides");
  });

  it("lists at most four slide headings", () => {
    const many = {
      title: "Long deck",
      slides: Array.from({ length: 8 }, (_, i) => ({ heading: `Claim number ${i + 1}`, bullets: ["x"] })),
    };
    const read = readDeckResult(many, { ...OUTPUT, slideCount: 9 });
    const html = card({ model: read as DeckCardModel });
    expect(html).toContain("Claim number 4");
    expect(html).not.toContain("Claim number 5");
  });

  it("escapes a title that looks like markup", () => {
    const html = card({ model: model({ title: '<img src=x onerror="alert(1)">' }) });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});

describe("the card, open", () => {
  it("shows the Presentation mode's own preview, read only, in place", () => {
    const html = card({ defaultOpen: true });
    expect(count(html, "chat-deck-preview")).toBe(1);
    expect(count(html, "presentations-preview")).toBe(1);
    expect(count(html, "presentations-filmstrip")).toBe(1);
    // One slide per outline item plus the title slide, as the Presentation studio draws them.
    expect(count(html, "presentations-filmstrip-slide")).toBe(4);
    expect(count(html, "presentations-slide-title")).toBe(1);
    expect(html).toContain("Warung expansion plan");
    expect(html).toMatch(/<button[^>]*aria-expanded="true"[^>]*data-testid="chat-deck-open"[^>]*>Close<\/button>/);
  });

  it("offers no editing: nothing is contenteditable and there are no shape or rewrite controls", () => {
    const html = card({ defaultOpen: true });
    expect(html).not.toContain("contenteditable");
    for (const editing of [
      "presentations-shape-toolbar",
      "presentations-regen",
      "presentations-edit-notes",
      "presentations-properties",
      "presentations-selection-toolbar",
    ]) {
      expect(count(html, editing), editing).toBe(0);
    }
  });

  it("does not build a second slide renderer: the stage comes from the shared preview component", () => {
    const text = source("../components/chat-deck-card.tsx");
    expect(text).toContain('from "@/components/presentation-preview"');
    expect(text).toContain("<PresentationPreview");
    expect(text).not.toMatch(/aspect-video|contentEditable|ShapeGlyph/);
  });
});

describe("a card with no outline to show", () => {
  const bare = () => model({ outline: null });

  it("drops Open, says why, and keeps Download", () => {
    const html = card({ model: bare(), defaultOpen: true });
    expect(count(html, "chat-deck-open")).toBe(0);
    expect(count(html, "presentations-preview")).toBe(0);
    expect(html).toContain("The slides cannot be shown here, but the file is ready to download.");
    expect(count(html, "chat-deck-download")).toBe(1);
  });
});

describe("the card in Indonesian", () => {
  it("is written from the id catalog", () => {
    applyLocale("id");
    const html = card();
    expect(html).toContain("4 slide");
    expect(html).toContain(">Buka</button>");
    expect(html).toContain(">Unduh</button>");
    expect(html).toContain("Deck PowerPoint");
    expect(html).not.toContain("Download");
  });
});

describe("the wiring the card relies on", () => {
  it("downloads through the shared chat file save, which calls the artifact client the Documents and Legal buttons use", () => {
    const text = source("../components/chat-deck-card.tsx");
    expect(text).toContain('from "@/lib/chat-file-save"');
    expect(text).toContain("saveChatFile(");
    const shared = source("../lib/chat-file-save.ts");
    expect(shared).toContain('from "@/lib/artifacts-client"');
    expect(shared).toContain("downloadArtifactFile");
  });

  it("says why a save failed when the shell refused it, and keeps its generic sentence for everything else", () => {
    const shared = source("../lib/chat-file-save.ts");
    expect(shared).toContain('from "@/lib/desktop-save"');
    expect(shared).toContain("saveFailureMessage(");
    expect(source("../components/chat-deck-card.tsx")).toContain("chat.deck.downloadFailed");
  });

  it("toggles the preview with the Open control and guards a second click while a download runs", () => {
    const text = source("../components/chat-deck-card.tsx");
    expect(text).toMatch(/setOpen\(\(current\) => !current\)/);
    expect(text).toMatch(/disabled=\{state === "busy"\}/);
  });
});

describe("the card inside a Chat turn", () => {
  const call = (input: unknown, output: unknown) => ({
    type: "tool_call" as const,
    toolKey: "build_deck",
    status: "completed" as const,
    input,
    output,
  });
  const answer = { type: "text" as const, text: "Your deck is ready." };

  function turn(content: unknown[], live?: Parameters<typeof ChatTurn>[0]["live"]): string {
    return renderToStaticMarkup(
      <MemoryRouter>
        <ChatTurn role="assistant" content={content} live={live} />
      </MemoryRouter>,
    );
  }

  it("rebuilds the card from a saved turn, outside the Thinking disclosure", () => {
    const html = turn([call(INPUT, OUTPUT), answer]);
    expect(count(html, "chat-deck-card")).toBe(1);
    const thinkingEnd = html.indexOf("</details>");
    expect(thinkingEnd).toBeGreaterThan(-1);
    expect(html.indexOf('data-testid="chat-deck-card"')).toBeGreaterThan(thinkingEnd);
    expect(html).toContain("Your deck is ready.");
  });

  it("gives the Thinking row a label and the slide count, and no card of its own", () => {
    const html = turn([call(INPUT, OUTPUT), answer]);
    const row = html.slice(html.indexOf('data-testid="message-tool"'), html.indexOf("</details>"));
    expect(row).toContain("Built “Warung expansion plan”");
    expect(row).toContain("4 slides");
    expect(row).not.toContain("chat-deck-card");
  });

  it("shows a refused build as a muted refusal and no card", () => {
    const html = turn([
      call(INPUT, { ok: false, reason: "checks", message: "ERROR: Slides share a heading." }),
      answer,
    ]);
    expect(count(html, "chat-deck-card")).toBe(0);
    expect(html).toContain("Could not build the deck");
    expect(html).toContain("ERROR: Slides share a heading.");
  });

  it("shows one card for a refused build followed by a good one", () => {
    const html = turn([
      call(INPUT, { ok: false, reason: "checks", message: "ERROR: too long" }),
      call(INPUT, OUTPUT),
      answer,
    ]);
    expect(count(html, "chat-deck-card")).toBe(1);
  });

  it("shows the card on a live turn once the call has finished, and nothing while it runs", () => {
    const running = turn([], {
      thinking: "",
      streaming: "",
      running: true,
      tools: [{ key: "build_deck", status: "started", input: INPUT }],
    });
    expect(count(running, "chat-deck-card")).toBe(0);
    const finished = turn([], {
      thinking: "",
      streaming: "Done.",
      running: false,
      tools: [{ key: "build_deck", status: "completed", input: INPUT, output: OUTPUT }],
    });
    expect(count(finished, "chat-deck-card")).toBe(1);
  });

  it("is not read as a search hit or a job card by the generic embeds", () => {
    const html = turn([call(INPUT, OUTPUT), answer]);
    expect(html).not.toContain("message-embed");
  });
});
