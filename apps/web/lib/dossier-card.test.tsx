/**
 * The dossier the Research agent's worker wrote: what the result reader takes from a `research_dossier`
 * call, the card that shows it under the answer, and the live progress line of the running worker.
 *
 * The card is rebuilt from the saved tool call alone, so the turn cases pass only what the host stored.
 * The renderer's vitest has no DOM, so presses are read from the source, as `deck-card.test.tsx` does.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatTurn } from "@/components/chat-turn";
import { DossierCard, DossierCards } from "@/components/chat-dossier-card";
import { DOSSIER_TOOL_KEY, readDossierResult, type DossierCardModel } from "@/components/tool-rows/dossier-result";
import { applyLocale, resetLocaleForTests } from "@/lib/i18n";
import { jobEmbedsFromTools } from "@/lib/message-embeds";
import { toolActivityLabel, toolCallSummary } from "@/lib/tool-labels";

const here = dirname(fileURLToPath(import.meta.url));
const source = (relative: string) => readFileSync(resolve(here, relative), "utf8").replace(/\r\n/g, "\n");

const INPUT = { question: "How are small shops in Jakarta adopting QRIS?" };
const OUTPUT = {
  ok: true,
  artifact: { id: "art-7", kind: "research", title: "QRIS adoption in Jakarta" },
  summary: "Adoption is wide but shallow.",
  sections: ["Adoption today", "Why shops hold back", "Fees", "What changed in 2025", "Outlook"],
  sourceCount: 12,
  checks: { passed: true, rounds: 1, failed: [] },
};

const count = (markup: string, testId: string) => markup.split(`data-testid="${testId}"`).length - 1;

function model(over: Partial<DossierCardModel> = {}): DossierCardModel {
  const read = readDossierResult(INPUT, OUTPUT);
  if (!read) {
    throw new Error("fixture does not read");
  }
  return { ...read, ...over };
}

function card(props: Partial<Parameters<typeof DossierCard>[0]> = {}): string {
  return renderToStaticMarkup(<DossierCard model={props.model ?? model()} {...props} />);
}

beforeEach(() => {
  applyLocale("en");
});

afterEach(() => {
  resetLocaleForTests();
});

describe("reading a research_dossier call", () => {
  it("takes the artifact, title, summary, sections, sources and checks from the output", () => {
    expect(readDossierResult(INPUT, OUTPUT)).toEqual({
      artifactId: "art-7",
      title: "QRIS adoption in Jakarta",
      summary: "Adoption is wide but shallow.",
      sections: ["Adoption today", "Why shops hold back", "Fees", "What changed in 2025", "Outlook"],
      sourceCount: 12,
      checksPassed: true,
      failedChecks: 0,
    });
  });

  it("reads an answer that was stored as JSON text", () => {
    expect(readDossierResult(undefined, JSON.stringify(OUTPUT))?.artifactId).toBe("art-7");
  });

  it("counts the failed checks and does not call the dossier passed", () => {
    const failed = [
      { check: "citations", error: "a finding has no source" },
      { check: "coverage", error: "a section is empty" },
    ];
    const read = readDossierResult(INPUT, { ...OUTPUT, checks: { passed: false, rounds: 2, failed } });
    expect(read).toMatchObject({ checksPassed: false, failedChecks: 2 });
  });

  it("does not report passed checks it was never told about", () => {
    const { checks: _checks, ...bare } = OUTPUT;
    expect(readDossierResult(INPUT, bare)).toMatchObject({ checksPassed: false, failedChecks: 1 });
  });

  it("keeps the card with no artifact id when the dossier was not saved", () => {
    const read = readDossierResult(INPUT, { ...OUTPUT, artifact: { id: null, kind: "research", title: "Unsaved" } });
    expect(read).toMatchObject({ artifactId: null, title: "Unsaved" });
  });

  it("reads nothing from a refusal, a missing title, or a call that has not finished", () => {
    expect(readDossierResult(INPUT, { ok: false, reason: "failed", code: "x", message: "no" })).toBeNull();
    expect(readDossierResult(INPUT, { ...OUTPUT, artifact: { id: "a" } })).toBeNull();
    expect(readDossierResult(INPUT, { ...OUTPUT, artifact: { id: "a", title: 4 } })).toBeNull();
    expect(readDossierResult(INPUT, { ...OUTPUT, artifact: null })).toBeNull();
    expect(readDossierResult(INPUT, undefined)).toBeNull();
  });

  it("never throws on garbage", () => {
    for (const garbage of ["not json", 42, null, [], { ok: true }, { ok: true, artifact: "x" }, "{bad"]) {
      expect(() => readDossierResult(garbage, garbage)).not.toThrow();
      expect(readDossierResult(garbage, garbage)).toBeNull();
    }
    const odd = readDossierResult(INPUT, { ...OUTPUT, sections: [1, "", "Real"], sourceCount: "many", checks: 3 });
    expect(odd).toMatchObject({ sections: ["Real"], sourceCount: 0, checksPassed: false });
  });

  it("is not read as a job card by the generic embeds", () => {
    expect(jobEmbedsFromTools([{ key: DOSSIER_TOOL_KEY, status: "completed", output: OUTPUT }])).toEqual([]);
  });
});

describe("the card, with passed checks", () => {
  it("shows the label, the title, the counts, the passed line and the first four sections", () => {
    const html = card();
    expect(count(html, "chat-dossier-card")).toBe(1);
    expect(html).toContain('data-artifact-id="art-7"');
    expect(html).toContain("Research dossier");
    expect(html).toContain("QRIS adoption in Jakarta");
    expect(html).toContain("12 sources · 5 sections");
    expect(html).toContain("Every finding cites a source");
    expect(html).not.toContain('data-failed="true"');
    expect(html).toContain('aria-label="Sections of the dossier"');
    expect(html).toContain("What changed in 2025");
    expect(html).not.toContain("Outlook");
  });

  it("has an Open control that is closed and shows no dossier yet", () => {
    const html = card();
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*data-testid="chat-dossier-open"[^>]*>Open<\/button>/);
    expect(html).toContain('aria-label="Open the dossier QRIS adoption in Jakarta"');
    expect(count(html, "chat-dossier-view")).toBe(0);
  });

  it("says one source and one section in the singular", () => {
    const html = card({ model: model({ sourceCount: 1, sections: ["Only one"] }) });
    expect(html).toContain("1 source · 1 section");
    expect(html).not.toContain("1 sources");
  });

  it("escapes a title that looks like markup", () => {
    const html = card({ model: model({ title: '<img src=x onerror="alert(1)">' }) });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});

describe("the card, with failed checks", () => {
  it("shows the danger line with the count and never the passed line", () => {
    const html = card({ model: model({ checksPassed: false, failedChecks: 2 }) });
    expect(html).toMatch(
      /<p[^>]*text-\[var\(--danger\)\][^>]*data-testid="chat-dossier-checks"[^>]*>2 checks did not pass<\/p>/,
    );
    expect(html).not.toContain("Every finding cites a source");
  });

  it("says one failed check in the singular", () => {
    const html = card({ model: model({ checksPassed: false, failedChecks: 1 }) });
    expect(html).toContain("1 check did not pass");
    expect(html).not.toContain("1 checks");
  });
});

describe("the card, open", () => {
  it("shows the loading line until the dossier text arrives", () => {
    const html = card({ defaultOpen: true });
    expect(count(html, "chat-dossier-view")).toBe(1);
    expect(html).toContain('aria-label="The dossier QRIS adoption in Jakarta"');
    expect(html).toContain("Opening the dossier");
    expect(html).toMatch(/<button[^>]*aria-expanded="true"[^>]*data-testid="chat-dossier-open"[^>]*>Close<\/button>/);
  });

  it("renders the saved markdown in place", () => {
    const html = card({ defaultOpen: true, initialMarkdown: "## Adoption today\n\nShops take **QRIS** first." });
    expect(count(html, "chat-dossier-text")).toBe(1);
    expect(html).toContain("<h2>Adoption today</h2>");
    expect(html).toContain("<strong>QRIS</strong>");
    expect(html).not.toContain("Opening the dossier");
  });

  it("reads the dossier once: a second Open reuses it and a failed read is tried again", () => {
    const text = source("../components/chat-dossier-card.tsx");
    expect(text).toContain("getArtifact(id)");
    expect(text).toMatch(/body\.status === "idle" \|\| body\.status === "failed"/);
    expect(text).toContain('role="alert"');
    expect(text).toContain("agents.dossier.loadFailed");
  });
});

describe("a card with nothing to open", () => {
  it("says so and offers no Open control", () => {
    const html = card({ model: model({ artifactId: null }), defaultOpen: true });
    expect(count(html, "chat-dossier-open")).toBe(0);
    expect(count(html, "chat-dossier-view")).toBe(0);
    expect(html).toContain("The dossier was written but could not be saved, so it cannot be opened here.");
    expect(html).not.toContain("data-artifact-id");
  });
});

describe("the card in Indonesian", () => {
  it("is written from the id catalog", () => {
    applyLocale("id");
    const html = card();
    expect(html).toContain("Dosir riset");
    expect(html).toContain("12 sumber · 5 bagian");
    expect(html).toContain(">Buka</button>");
    expect(html).toContain("Setiap temuan menyebut sumber");
    expect(html).not.toContain("Every finding cites a source");
  });
});

describe("the cards of a turn", () => {
  const call = (status: "started" | "completed", key = DOSSIER_TOOL_KEY, output: unknown = OUTPUT) => ({
    key,
    status,
    input: INPUT,
    output: status === "completed" ? output : undefined,
  });

  it("draws one card for a finished call", () => {
    expect(count(renderToStaticMarkup(<DossierCards tools={[call("completed")]} />), "chat-dossier-card")).toBe(1);
  });

  it("draws nothing for a call that is still running, another tool, or a refusal", () => {
    expect(renderToStaticMarkup(<DossierCards tools={[call("started")]} />)).toBe("");
    expect(renderToStaticMarkup(<DossierCards tools={[call("completed", "build_deck")]} />)).toBe("");
    const refused = { ok: false, reason: "failed", code: "x", message: "no" };
    expect(renderToStaticMarkup(<DossierCards tools={[call("completed", DOSSIER_TOOL_KEY, refused)]} />)).toBe("");
  });
});

describe("the dossier inside a Chat turn", () => {
  const saved = [
    {
      type: "tool_call" as const,
      toolKey: DOSSIER_TOOL_KEY,
      status: "completed" as const,
      input: INPUT,
      output: OUTPUT,
    },
    { type: "text" as const, text: "The dossier is ready." },
  ];

  function turn(content: unknown, live?: Parameters<typeof ChatTurn>[0]["live"]): string {
    return renderToStaticMarkup(
      <MemoryRouter>
        <ChatTurn role="assistant" content={content} live={live} />
      </MemoryRouter>,
    );
  }

  it("rebuilds the card from a saved turn, outside the Thinking disclosure", () => {
    const html = turn(saved);
    expect(count(html, "chat-dossier-card")).toBe(1);
    expect(html.indexOf('data-testid="chat-dossier-card"')).toBeGreaterThan(html.indexOf("</details>"));
    expect(html).toContain("The dossier is ready.");
    expect(html).not.toContain("message-embed");
  });

  it("labels the Thinking row with the title, not the question and a field count", () => {
    const html = turn(saved);
    const row = html.slice(html.indexOf('data-testid="message-tool"'), html.indexOf("</details>"));
    expect(row).toContain("Research dossier · QRIS adoption in Jakarta");
    expect(row).not.toContain("fields");
  });

  it("shows the worker's progress line in the live row while it runs", () => {
    const html = turn([], {
      thinking: "",
      streaming: "",
      running: true,
      tools: [{ key: DOSSIER_TOOL_KEY, status: "started", input: INPUT, progress: "Reading 6 pages" }],
    });
    expect(html).toContain('data-testid="message-tool-progress"');
    expect(html).toContain("Reading 6 pages");
    expect(count(html, "chat-dossier-card")).toBe(0);
  });

  it("falls back to the activity label before the first progress line", () => {
    const html = turn([], {
      thinking: "",
      streaming: "",
      running: true,
      tools: [{ key: DOSSIER_TOOL_KEY, status: "started", input: INPUT }],
    });
    expect(count(html, "message-tool-progress")).toBe(0);
    expect(html).toContain(toolActivityLabel(DOSSIER_TOOL_KEY, INPUT));
    expect(toolActivityLabel(DOSSIER_TOOL_KEY)).toBe("Working");
  });

  it("shows the card on a live turn once the call has finished", () => {
    const html = turn([], {
      thinking: "",
      streaming: "Done.",
      running: false,
      tools: [{ key: DOSSIER_TOOL_KEY, status: "completed", input: INPUT, output: OUTPUT }],
    });
    expect(count(html, "chat-dossier-card")).toBe(1);
  });

  it("summarises a failed worker with its message", () => {
    const refused = { ok: false, reason: "failed", code: "x", message: "The search was unreachable." };
    expect(toolCallSummary(DOSSIER_TOOL_KEY, INPUT, refused)).toBe("Research dossier · The search was unreachable.");
  });
});

describe("the message bubbles", () => {
  function turn(role: string, content: unknown): string {
    return renderToStaticMarkup(
      <MemoryRouter>
        <ChatTurn role={role} content={content} />
      </MemoryRouter>,
    );
  }

  it("puts the person's message in the accent bubble class and the answer text in a soft bubble", () => {
    const user = turn("user", "Hello there");
    expect(user).toMatch(/<article class="enter-rise chat-turn--user"[^>]*data-testid="message"/);
    expect(user).not.toContain("chat-turn-bubble");
    const agent = turn("assistant", [{ type: "text", text: "Hi." }]);
    expect(agent).toMatch(/<article class="enter-rise chat-turn--assistant"[^>]*data-testid="message"/);
    expect(agent).toMatch(
      /<div class="chat-turn-bubble"><div class="formatted-md text-sm" data-testid="message-output">/,
    );
  });

  it("keeps a picture outside the bubble and draws no empty bubble", () => {
    const agent = turn("assistant", [
      { type: "text", text: "Here it is." },
      { type: "image_url", image_url: { url: "/api/v1/media/pic.png" } },
    ]);
    expect(count(agent, "message-image")).toBe(1);
    expect(agent.indexOf("message-image")).toBeGreaterThan(agent.indexOf("</div></div>"));
    expect(turn("assistant", [{ type: "tool_call", toolKey: "calculator", status: "completed" }])).not.toContain(
      "chat-turn-bubble",
    );
  });

  it("styles both bubbles from their own stylesheet, with the radii and the accent the design asks for", () => {
    const css = source("../components/chat-turn-bubbles.css");
    expect(css).toMatch(/\.chat-turn--user \{[^}]*border-radius: 20px 20px 6px 20px;[^}]*background: var\(--accent\)/s);
    expect(css).toMatch(/\.chat-turn-bubble \{[^}]*border-radius: 20px 20px 20px 6px;/s);
    expect(css).toContain("color-mix(in srgb, var(--text) 6%, var(--surface))");
    expect(css).toContain("max-width: min(80%, 46rem)");
    expect(css).toMatch(/\.chat-turn--user \.chat-embed \{[^}]*color: var\(--text\)/s);
    expect(source("../components/chat-turn.tsx")).toContain('import "@/components/chat-turn-bubbles.css"');
  });
});
