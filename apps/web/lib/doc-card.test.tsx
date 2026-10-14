/**
 * The document card a Chat turn makes for the four document tools (`create_document`, `create_workbook`,
 * `revise_document`, `import_document`): what the result reader takes from each saved call, the card
 * under the answer, the Thinking label, and the one download every chat file card shares.
 *
 * The card is rebuilt from the tool call alone (its input holds the new file's parts, its output the
 * artifact id), so a thread reopened tomorrow draws the same card. The renderer's vitest has no DOM, so
 * the download is run against a stubbed fetch and anchor (as `download-clients.test.ts` does), and the
 * button press itself is read from the source.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatTurn } from "@/components/chat-turn";
import { DocCard, DocCards } from "@/components/chat-doc-card";
import { DOC_TOOL_KEYS, isDocTool, readDocResult, type DocCardModel } from "@/components/tool-rows/doc-result";
import { DesktopSaveError } from "@/lib/desktop-save";
import { saveChatFile } from "@/lib/chat-file-save";
import { applyLocale, resetLocaleForTests } from "@/lib/i18n";
import { jobEmbedsFromTools } from "@/lib/message-embeds";
import { toolActivityLabel, toolCallSummary, toolDoneLabel } from "@/lib/tool-labels";

const here = dirname(fileURLToPath(import.meta.url));
const source = (relative: string) => readFileSync(resolve(here, relative), "utf8").replace(/\r\n/g, "\n");

const DOCX_INPUT = {
  format: "docx",
  spec: {
    title: "Q3 report",
    sections: [
      { id: "intro", heading: "Intro", blocks: [{ type: "paragraph", text: "Hello." }] },
      { id: "risks", heading: "Risks", blocks: [] },
    ],
  },
};
const DOCX_OUTPUT = {
  ok: true,
  artifactId: "art-d",
  title: "Q3 report",
  format: "docx",
  filename: "q3-report.docx",
  summary: "Word with 2 sections.",
};

const SHEET_INPUT = { spec: { title: "Budget", sheets: [{ name: "Jan" }, { name: "Feb" }, { name: "Mar" }] } };
const SHEET_OUTPUT = {
  ok: true,
  artifactId: "art-x",
  title: "Budget",
  format: "xlsx",
  filename: "budget.xlsx",
  summary: "Excel workbook with 3 sheets.",
};

const REVISE_INPUT = { artifactId: "art-d", sectionId: "risks", section: { heading: "Risks", blocks: [] } };
const REVISE_OUTPUT = {
  ok: true,
  artifactId: "art-r",
  title: "Q3 report (revised)",
  format: "pdf",
  filename: "q3-report-revised.pdf",
  summary: "Saved a revised copy as pdf. The original file is unchanged.",
};

const IMPORT_INPUT = { artifactId: "art-x" };
const IMPORT_OUTPUT = {
  ok: true,
  artifactId: "art-i",
  title: "Budget (imported)",
  format: "xlsx",
  parts: [
    { id: "s1", heading: "Jan" },
    { id: "s2", heading: "Feb" },
  ],
  summary: "Imported 2 sheets. Revise one with its id.",
};

const REFUSAL = { ok: false, reason: "checks", message: "ERROR: a section has no heading." };

const count = (markup: string, testId: string) => markup.split(`data-testid="${testId}"`).length - 1;

function model(over: Partial<DocCardModel> = {}): DocCardModel {
  const read = readDocResult("create_document", DOCX_INPUT, DOCX_OUTPUT);
  if (!read) {
    throw new Error("fixture does not read");
  }
  return { ...read, ...over };
}

function card(props: { model?: DocCardModel } = {}): string {
  return renderToStaticMarkup(<DocCard model={props.model ?? model()} />);
}

function turn(content: unknown[]): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ChatTurn role="assistant" content={content} />
    </MemoryRouter>,
  );
}

function setHosted(on: boolean) {
  if (on) {
    vi.stubGlobal("__AGENTFORGE_SERVER__", "1");
  } else {
    vi.unstubAllGlobals();
  }
}

beforeEach(() => {
  applyLocale("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetLocaleForTests();
});

describe("reading a document tool call", () => {
  it("knows the four tools by their keys and no other", () => {
    expect([...DOC_TOOL_KEYS]).toEqual(["create_document", "create_workbook", "revise_document", "import_document"]);
    expect(isDocTool("create_document")).toBe(true);
    expect(isDocTool("build_deck")).toBe(false);
    expect(isDocTool("write_file")).toBe(false);
  });

  it("reads a Word file: the title, the file name from the host, and the sections from the input", () => {
    expect(readDocResult("create_document", DOCX_INPUT, DOCX_OUTPUT)).toEqual({
      artifactId: "art-d",
      format: "docx",
      title: "Q3 report",
      filename: "q3-report.docx",
      revised: false,
      parts: { kind: "section", count: 2 },
    });
  });

  it("reads a workbook: the sheets from the input, and a PDF with no count when it is a revision", () => {
    expect(readDocResult("create_workbook", SHEET_INPUT, SHEET_OUTPUT)).toMatchObject({
      artifactId: "art-x",
      format: "xlsx",
      parts: { kind: "sheet", count: 3 },
    });
    expect(readDocResult("revise_document", REVISE_INPUT, REVISE_OUTPUT)).toEqual({
      artifactId: "art-r",
      format: "pdf",
      title: "Q3 report (revised)",
      filename: "q3-report-revised.pdf",
      revised: true,
      parts: null,
    });
  });

  it("reads an import from its parts, and names the file the way the host would when it sends no name", () => {
    expect(readDocResult("import_document", IMPORT_INPUT, IMPORT_OUTPUT)).toEqual({
      artifactId: "art-i",
      format: "xlsx",
      title: "Budget (imported)",
      filename: "budget-imported.xlsx",
      revised: false,
      parts: { kind: "sheet", count: 2 },
    });
  });

  it("reads nothing from a refusal, a spent budget, or a call that has not finished", () => {
    for (const toolKey of DOC_TOOL_KEYS) {
      expect(readDocResult(toolKey, DOCX_INPUT, REFUSAL), toolKey).toBeNull();
      expect(readDocResult(toolKey, DOCX_INPUT, { ok: false, reason: "budget", message: "spent" }), toolKey).toBeNull();
      expect(readDocResult(toolKey, DOCX_INPUT, undefined), toolKey).toBeNull();
    }
  });

  it("reads nothing from a result without an id, without a known format, or without a title", () => {
    const bad = [
      { ...DOCX_OUTPUT, artifactId: "" },
      { ...DOCX_OUTPUT, artifactId: undefined },
      { ...DOCX_OUTPUT, format: "exe" },
      { ...DOCX_OUTPUT, format: undefined },
      { ...DOCX_OUTPUT, title: "" },
      { ...DOCX_OUTPUT, title: 7 },
    ];
    for (const output of bad) {
      expect(readDocResult("create_document", DOCX_INPUT, output)).toBeNull();
    }
    for (const garbage of ["not json", 42, null, [], "{bad"]) {
      expect(readDocResult("create_document", DOCX_INPUT, garbage)).toBeNull();
    }
  });

  it("reads output stored as JSON text, and keeps the card when the input cannot be counted", () => {
    expect(readDocResult("create_document", JSON.stringify(DOCX_INPUT), JSON.stringify(DOCX_OUTPUT))).toMatchObject({
      artifactId: "art-d",
      parts: { count: 2 },
    });
    expect(readDocResult("create_document", undefined, DOCX_OUTPUT)).toMatchObject({
      artifactId: "art-d",
      parts: null,
    });
    expect(readDocResult("import_document", IMPORT_INPUT, { ...IMPORT_OUTPUT, parts: "two" })).toMatchObject({
      artifactId: "art-i",
      parts: null,
    });
  });
});

describe("the card", () => {
  it("shows the file's format, its title, its section count and Download", () => {
    const html = card();
    expect(count(html, "chat-doc-card")).toBe(1);
    expect(html).toContain('data-artifact-id="art-d"');
    expect(html).toContain("Word document");
    expect(html).toContain("Q3 report");
    expect(html).toContain("2 sections");
    expect(count(html, "chat-doc-download")).toBe(1);
    expect(html).toContain('aria-label="Download Q3 report as q3-report.docx"');
  });

  it("says one section or one sheet in the singular, and the sheets of a workbook", () => {
    expect(card({ model: model({ parts: { kind: "section", count: 1 } }) })).toContain("1 section<");
    const workbook = readDocResult("create_workbook", SHEET_INPUT, SHEET_OUTPUT) as DocCardModel;
    const html = card({ model: workbook });
    expect(html).toContain("Excel workbook");
    expect(html).toContain("3 sheets");
    expect(card({ model: { ...workbook, parts: { kind: "sheet", count: 1 } } })).toContain("1 sheet<");
  });

  it("says the original is unchanged on a revised copy, and shows no count it does not know", () => {
    const revised = readDocResult("revise_document", REVISE_INPUT, REVISE_OUTPUT) as DocCardModel;
    const html = card({ model: revised });
    expect(html).toContain("PDF file");
    expect(html).toContain("The original file is unchanged.");
    expect(html).not.toContain("sections");
  });

  it("escapes a title that looks like markup", () => {
    const html = card({ model: model({ title: '<img src=x onerror="alert(1)">' }) });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("draws a file icon for the format", () => {
    const html = card({ model: model({ format: "pdf", filename: "plan.pdf" }) });
    expect(html).toContain('data-format="pdf"');
    expect(html).toContain("<svg");
    expect(count(html, "chat-doc-icon")).toBe(1);
  });

  it("shows the Add to Workspace control only on hosted, and nothing on Personal", () => {
    expect(card()).not.toContain('data-testid="add-to-workspace"');
    setHosted(true);
    expect(card()).toContain('data-testid="add-to-workspace-open"');
  });

  it("says the card in Indonesian from the id catalog", () => {
    applyLocale("id");
    const html = card({ model: model({ parts: { kind: "section", count: 2 } }) });
    expect(html).toContain("Dokumen Word");
    expect(html).toContain("2 bagian");
    expect(html).toContain(">Unduh</button>");
    expect(html).not.toContain(">Download</button>");
  });
});

describe("the download the card makes", () => {
  it("fetches the artifact file route and saves the bytes under the file name the host sent", async () => {
    const bytes = Uint8Array.from([0x50, 0x4b, 3, 4, 1]);
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(url);
      return new Response(bytes, {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": 'attachment; filename="q3-report.docx"',
        },
      });
    });
    const anchor = { href: "", download: "", click: vi.fn() };
    vi.stubGlobal("document", { createElement: () => anchor, cookie: "" });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:doc");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    const saved = await saveChatFile("art-d", "fallback.docx");

    expect(saved).toEqual({ ok: true });
    expect(asked).toEqual(["/api/v1/artifacts/art-d/file"]);
    expect(anchor.download).toBe("q3-report.docx");
    expect(anchor.click).toHaveBeenCalledTimes(1);
  });

  it("keeps the generic sentence when the host refuses, and saves nothing", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ error: { code: "not_found", message: "Artifact not found" } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(saveChatFile("missing", "a.docx")).resolves.toEqual({ ok: false, reason: null });
  });

  it("carries the shell's own reason when the native save failed", async () => {
    const save = async () => {
      throw new DesktopSaveError("write-failed", "The disk refused the file.");
    };
    await expect(saveChatFile("art-d", "a.docx", save)).resolves.toEqual({
      ok: false,
      reason: "The disk refused the file.",
    });
  });

  it("is the same call the deck card makes: the card keeps only its busy and failed state", () => {
    const text = source("../components/chat-doc-card.tsx");
    expect(text).toContain('from "@/lib/chat-file-save"');
    expect(text).toContain("saveChatFile(");
    expect(text).toMatch(/disabled=\{state === "busy"\}/);
    expect(text).not.toContain("downloadArtifactFile");
    expect(source("../lib/chat-file-save.ts")).toContain("downloadArtifactFile");
  });
});

describe("the Thinking label for a document tool", () => {
  it("names the file a create call is making while it runs, and says a plain thing when it cannot name it", () => {
    expect(toolActivityLabel("create_document", DOCX_INPUT)).toBe("Making “Q3 report”…");
    expect(toolActivityLabel("create_workbook", SHEET_INPUT)).toBe("Making “Budget”…");
    expect(toolActivityLabel("revise_document", REVISE_INPUT)).toBe("Working on a file…");
    expect(toolActivityLabel("import_document", IMPORT_INPUT)).toBe("Working on a file…");
  });

  it("says what was made when the call is done, and why it failed when it did not", () => {
    expect(toolCallSummary("create_document", DOCX_INPUT, DOCX_OUTPUT)).toBe("Made “Q3 report”");
    expect(toolCallSummary("create_workbook", SHEET_INPUT, SHEET_OUTPUT)).toBe("Made “Budget”");
    expect(toolCallSummary("revise_document", REVISE_INPUT, REVISE_OUTPUT)).toBe(
      "Revised a copy: “Q3 report (revised)”",
    );
    expect(toolCallSummary("import_document", IMPORT_INPUT, IMPORT_OUTPUT)).toBe("Imported “Budget (imported)”");
    expect(toolCallSummary("create_document", DOCX_INPUT, REFUSAL)).toBe("Could not make the document");
    expect(toolCallSummary("create_workbook", SHEET_INPUT, REFUSAL)).toBe("Could not make the workbook");
    expect(toolCallSummary("revise_document", REVISE_INPUT, REFUSAL)).toBe("Could not revise the document");
    expect(toolCallSummary("import_document", IMPORT_INPUT, REFUSAL)).toBe("Could not import the file");
  });

  it("never prints the raw key or the host's field count", () => {
    const summary = toolCallSummary("create_document", DOCX_INPUT, DOCX_OUTPUT);
    expect(summary).not.toContain("create_document");
    expect(summary).not.toContain("fields");
    expect(toolDoneLabel("create_document")).toBe("Make a document");
    expect(toolDoneLabel("import_document")).toBe("Import a document");
  });

  it("is written in Indonesian in the id catalog", () => {
    applyLocale("id");
    expect(toolCallSummary("create_document", DOCX_INPUT, DOCX_OUTPUT)).toBe("Dibuat “Q3 report”");
    expect(toolCallSummary("import_document", IMPORT_INPUT, REFUSAL)).toBe("Berkas tidak bisa diimpor");
  });
});

describe("the cards under a Chat answer", () => {
  const call = (toolKey: string, input: unknown, output: unknown) => ({
    type: "tool_call" as const,
    toolKey,
    status: "completed" as const,
    input,
    output,
  });
  const answer = { type: "text" as const, text: "Your file is ready." };

  it("draws one card for each ok result, after the Thinking disclosure, and none for a refusal", () => {
    const html = turn([
      call("create_document", DOCX_INPUT, REFUSAL),
      call("create_document", DOCX_INPUT, DOCX_OUTPUT),
      call("create_workbook", SHEET_INPUT, SHEET_OUTPUT),
      answer,
    ]);
    expect(count(html, "chat-doc-card")).toBe(2);
    const thinkingEnd = html.indexOf("</details>");
    expect(thinkingEnd).toBeGreaterThan(-1);
    expect(html.indexOf('data-testid="chat-doc-card"')).toBeGreaterThan(thinkingEnd);
    expect(html).toContain("Your file is ready.");
  });

  it("shows no card while the call runs, and one once it has finished", () => {
    const running = renderToStaticMarkup(
      <DocCards tools={[{ key: "create_document", status: "started", input: DOCX_INPUT }]} />,
    );
    expect(running).toBe("");
    const finished = renderToStaticMarkup(
      <DocCards tools={[{ key: "create_document", status: "completed", input: DOCX_INPUT, output: DOCX_OUTPUT }]} />,
    );
    expect(count(finished, "chat-doc-card")).toBe(1);
  });

  it("is not read as a job card by the generic embeds", () => {
    const tools = [{ key: "import_document", status: "completed", output: IMPORT_OUTPUT }];
    expect(jobEmbedsFromTools(tools)).toEqual([]);
    expect(turn([call("import_document", IMPORT_INPUT, IMPORT_OUTPUT), answer])).not.toContain("message-embed");
  });
});
