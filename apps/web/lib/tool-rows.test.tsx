/**
 * The Chat tool rows for the file, Knowledge and code tools (components/tool-rows). The renderer's
 * vitest only collects `lib/**`, so the rows are tested here, rendered to static markup.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { ChatTurn } from "@/components/chat-turn";
import { codeFailureText } from "@/components/tool-rows/code-row";
import { toolDetail } from "@/components/tool-rows/details";
import { FOLDER_PROPOSALS_TESTID, revealFolderProposals } from "@/components/tool-rows/focus-proposals";
import {
  asRecord,
  classifyOutcome,
  isRichTool,
  knowledgeFileHref,
  readCodeResult,
  savedDeskPath,
} from "@/components/tool-rows/results";
import { ToolRowBody, type RowTool } from "@/components/tool-rows/tool-row";
import { applyLocale, resetLocaleForTests } from "@/lib/i18n";

afterEach(() => {
  resetLocaleForTests();
});

function render(tool: RowTool): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ToolRowBody tool={tool} />
    </MemoryRouter>,
  );
}

/** The element carrying a testid, opening tag and content, so a test can read one row part. */
function part(html: string, testId: string): string {
  const open = html.indexOf(`data-testid="${testId}"`);
  if (open < 0) {
    return "";
  }
  const start = html.lastIndexOf("<", open);
  const tag = /^<([a-z0-9]+)/.exec(html.slice(start))?.[1] ?? "div";
  const close = html.indexOf(`</${tag}>`, open);
  return html.slice(start, close + tag.length + 3);
}

const done = (key: string, input: unknown, output: unknown): RowTool => ({ key, status: "completed", input, output });

describe("which tools get a rich row", () => {
  it("is exactly the nine new tools", () => {
    for (const key of [
      "list_files",
      "read_file",
      "write_file",
      "edit_file",
      "search_files",
      "delete_file",
      "knowledge_search",
      "run_code",
      "build_deck",
    ]) {
      expect(isRichTool(key)).toBe(true);
    }
    for (const key of ["web_search", "calculator", "datetime", "image_generate", "past_sessions", "custom_pack_tool"]) {
      expect(isRichTool(key)).toBe(false);
    }
  });
});

describe("file tool rows", () => {
  it("shows a read as one sentence with the lines it covered", () => {
    const html = render(
      done(
        "read_file",
        { path: "notes/plan.md" },
        {
          ok: true,
          root: "desk",
          path: "notes/plan.md",
          bytes: 4000,
          totalLines: 340,
          firstLine: 1,
          lastLine: 120,
          truncated: true,
          content: "1\tsecret body that must not be shown",
        },
      ),
    );
    expect(html).toContain('data-testid="tool-row-file"');
    expect(html).toContain('data-tool="read_file"');
    expect(html).toContain('data-state="done"');
    expect(html).toContain(">Read notes/plan.md</span>");
    expect(html).toContain("Lines 1–120 of 340");
    expect(html).not.toContain("secret body");
    expect(html).not.toContain("tool-row-refusal");
    expect(html).not.toContain("tool-row-file-chip");
  });

  it("truncates a long path on one line and keeps the whole path in the title", () => {
    const path = `${"deeply/nested/".repeat(12)}final-report-2026.md`;
    const html = render(done("read_file", { path }, { ok: true, totalLines: 1, firstLine: 1, lastLine: 1 }));
    expect(html).toContain(`title="Read ${path}"`);
    expect(html).toMatch(/class="min-w-0 max-w-full truncate" title="Read deeply/);
  });

  it("gives a saved desk write a chip that opens it in the Knowledge Base", () => {
    const html = render(
      done(
        "write_file",
        { path: "notes/plan.md", content: "x" },
        {
          ok: true,
          root: "desk",
          status: "saved",
          path: "notes/plan.md",
          version: 3,
        },
      ),
    );
    const chip = part(html, "tool-row-file-chip");
    expect(chip).toContain('href="/knowledge?file=notes%2Fplan.md"');
    expect(chip).toContain('title="notes/plan.md"');
    expect(chip).toContain('aria-label="Open notes/plan.md in the Knowledge Base"');
    expect(chip).toContain(">Open</span>");
    expect(html).toContain("Wrote notes/plan.md");
    expect(html).toContain("Version 3");
  });

  it("puts a Download button beside the chip of a saved desk write, named for the path", () => {
    const html = render(
      done(
        "write_file",
        { path: "notes/plan.md", content: "x" },
        { ok: true, root: "desk", status: "saved", path: "notes/plan.md", version: 3 },
      ),
    );
    const button = part(html, "tool-row-file-download");
    expect(button).toContain("<button");
    expect(button).toContain('aria-label="Download notes/plan.md to your computer"');
    expect(button).toContain('title="notes/plan.md"');
    expect(button).toContain(">Download</button>");
    expect(html.match(/data-testid="tool-row-file-download"/g)).toHaveLength(1);
  });

  it("offers no Download for a read, a delete, a refusal or a folder write that waits", () => {
    const reads = render(done("read_file", { path: "a.md" }, { ok: true, totalLines: 1, firstLine: 1, lastLine: 1 }));
    const deleted = render(
      done("delete_file", { path: "a.md" }, { ok: true, root: "desk", status: "saved", path: "a.md", version: 5 }),
    );
    const refused = render(done("write_file", { path: "a.md" }, { ok: false, code: "quota", message: "full" }));
    const waiting = render(
      done(
        "write_file",
        { path: "a.md" },
        { ok: true, root: "folder", status: "pending_approval", path: "a.md", proposalId: "p1" },
      ),
    );
    for (const html of [reads, deleted, refused, waiting]) {
      expect(html).not.toContain("tool-row-file-download");
    }
  });

  it("says Unduh in Indonesian", () => {
    applyLocale("id");
    const html = render(
      done("write_file", { path: "a.md" }, { ok: true, root: "desk", status: "saved", path: "a.md", version: 1 }),
    );
    expect(part(html, "tool-row-file-download")).toContain(">Unduh</button>");
  });

  it("encodes an awkward path once in the chip link", () => {
    const html = render(
      done(
        "edit_file",
        { path: "my notes/q&a #1.md" },
        {
          ok: true,
          root: "desk",
          status: "saved",
          path: "my notes/q&a #1.md",
          version: 2,
          replacements: 1,
        },
      ),
    );
    expect(part(html, "tool-row-file-chip")).toContain('href="/knowledge?file=my%20notes%2Fq%26a%20%231.md"');
  });

  it("draws the chip as a plain anchor when there is no router", () => {
    const html = renderToStaticMarkup(
      <ToolRowBody
        tool={done(
          "edit_file",
          { path: "src/app.ts" },
          { ok: true, root: "desk", status: "saved", path: "src/app.ts", version: 4 },
        )}
      />,
    );
    expect(part(html, "tool-row-file-chip")).toContain('href="/knowledge?file=src%2Fapp.ts"');
    expect(html).toContain("Edited src/app.ts");
  });

  it("gives a delete and a folder write no chip", () => {
    const deleted = render(
      done(
        "delete_file",
        { path: "old.txt" },
        { ok: true, root: "desk", status: "saved", path: "old.txt", version: 5 },
      ),
    );
    expect(deleted).toContain("Deleted old.txt");
    expect(deleted).not.toContain("tool-row-file-chip");
    expect(
      savedDeskPath("write_file", { ok: true, root: "folder", status: "saved", path: "a.md", version: 1 }),
    ).toBeNull();
    expect(savedDeskPath("write_file", { ok: true, root: "desk", status: "saved", path: "a.md", version: 1 })).toEqual({
      path: "a.md",
      version: 1,
    });
  });

  it("shows a refusal as the tool's own sentence, muted, with no alarm role", () => {
    const html = render(
      done("read_file", { path: "gone.md" }, { ok: false, code: "not_found", message: "No file at gone.md." }),
    );
    expect(html).toContain('data-state="refused"');
    expect(html).toContain("Could not read gone.md");
    const refusal = part(html, "tool-row-refusal");
    expect(refusal).toContain("No file at gone.md.");
    expect(refusal).toContain("text-[var(--text-3)]");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("tool-row-budget");
  });

  it("shows a spent budget with its title and message", () => {
    const html = render(
      done(
        "search_files",
        { pattern: "total" },
        {
          ok: false,
          reason: "budget",
          message: "Tool budget spent: this run allows 2 calls in all and they have run.",
        },
      ),
    );
    expect(html).toContain('data-state="budget"');
    const budget = part(html, "tool-row-budget");
    expect(budget).toContain("Tool budget spent");
    expect(budget).toContain("this run allows 2 calls in all and they have run.");
    expect(html).not.toContain("tool-row-refusal");
  });

  it("shows a folder change that waits for approval, with the path and a review button", () => {
    const html = render(
      done(
        "write_file",
        { path: "reports/q3.md", root: "folder", content: "x" },
        {
          ok: true,
          root: "folder",
          status: "pending_approval",
          path: "reports/q3.md",
          proposalId: "prop-1",
          message: "Not applied yet.",
        },
      ),
    );
    expect(html).toContain('data-state="pending"');
    expect(html).toContain("Proposed writing a file");
    const pending = part(html, "tool-row-pending-approval");
    expect(pending).toContain("Waiting for your approval");
    expect(pending).toContain('title="reports/q3.md"');
    expect(pending).toContain(">reports/q3.md</span>");
    expect(pending).toContain('data-testid="tool-row-pending-review"');
    expect(pending).toContain('type="button"');
    expect(pending).toContain(">Review</button>");
    expect(html).not.toContain("tool-row-file-chip");
    expect(html).not.toContain("Not applied yet.");
  });

  it("shows counts for a listing and a search, and says when there is more", () => {
    const listed = render(done("list_files", { dir: "notes" }, { ok: true, total: 612, truncated: true, entries: [] }));
    expect(listed).toContain("Listed files in notes");
    expect(listed).toContain("612 files · more not shown");
    const one = render(done("list_files", {}, { ok: true, total: 1, truncated: false, entries: [{ path: "a.md" }] }));
    expect(one).toContain("Listed your files");
    expect(one).toContain("1 file<");
    const empty = render(
      done("search_files", { pattern: "zzz" }, { ok: true, mode: "text", truncated: false, hits: [] }),
    );
    expect(empty).toContain("Searched files for “zzz”");
    expect(empty).toContain("Nothing found");
    const hits = render(
      done(
        "search_files",
        { pattern: "total" },
        { ok: true, truncated: false, hits: [{ path: "a.md", line: 1, text: "total" }] },
      ),
    );
    expect(hits).toContain("1 match<");
  });

  it("shows a running call with its activity sentence and no ending", () => {
    const html = render({ key: "read_file", status: "started", input: { path: "notes/plan.md" } });
    expect(html).toContain('data-state="running"');
    expect(html).toContain("Reading notes/plan.md…");
  });

  it("escapes a path that looks like markup", () => {
    const html = render(done("read_file", { path: "<img src=x onerror=alert(1)>.md" }, { ok: true }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;.md");
  });
});

describe("knowledge search rows", () => {
  it("names the query, the number of excerpts and the sources", () => {
    const html = render(
      done(
        "knowledge_search",
        { query: "refund policy" },
        {
          results: [
            { title: "Handbook.pdf", source_id: "s1", snippet: "Refunds within 30 days." },
            { title: "Notes", source_id: "s2", snippet: "Ask finance." },
          ],
        },
      ),
    );
    expect(html).toContain('data-testid="tool-row-knowledge"');
    expect(html).toContain("Searched your knowledge for “refund policy”");
    expect(html).toContain("2 excerpts");
    const sources = part(html, "tool-row-knowledge-sources");
    expect(sources).toContain("Handbook.pdf · Notes");
    expect(html).not.toContain("Refunds within 30 days.");
  });

  it("says nothing matched without showing the host's note for the model", () => {
    const html = render(
      done(
        "knowledge_search",
        { query: "tax" },
        { results: [], note: "No excerpt in the Knowledge Base matched that query." },
      ),
    );
    expect(html).toContain("Nothing found");
    expect(html).not.toContain("No excerpt in the Knowledge Base");
  });

  it("shows an unavailable search as a muted refusal", () => {
    const html = render(
      done(
        "knowledge_search",
        { query: "tax" },
        {
          ok: false,
          reason: "unavailable",
          message: "The Knowledge Base cannot be searched right now.",
        },
      ),
    );
    expect(html).toContain("Could not search your knowledge");
    expect(part(html, "tool-row-refusal")).toContain("The Knowledge Base cannot be searched right now.");
  });
});

describe("run_code rows", () => {
  const ranOk = {
    ok: true,
    stdout: "total = 42\n",
    stderr: "",
    filesWritten: [],
  };

  it("shows the language badge, folds the code away and prints the output", () => {
    const html = render(done("run_code", { language: "python", code: "print('total =', 42)" }, ranOk));
    expect(html).toContain('data-testid="tool-row-code"');
    expect(html).toContain('data-state="done"');
    expect(html).toContain(">Ran Python</span>");
    expect(part(html, "tool-row-code-language")).toContain(">Python</span>");
    const details = part(html, "tool-row-code-source");
    expect(details).toContain("<details");
    expect(details).not.toMatch(/<details[^>]*\bopen\b/);
    expect(details).toContain("Show code");
    expect(part(html, "tool-row-code-text")).toContain("print(&#x27;total =&#x27;, 42)");
    expect(part(html, "tool-row-code-text")).toContain("whitespace-pre");
    expect(part(html, "tool-row-code-text")).toContain("overflow-auto");
    expect(part(html, "tool-row-code-stdout")).toContain("total = 42");
    expect(html).not.toContain("tool-row-code-stderr");
    expect(html).not.toContain("tool-row-code-reason");
  });

  it("mutes stderr and keeps it apart from the output", () => {
    const html = render(
      done(
        "run_code",
        { language: "python", code: "import sys" },
        {
          ok: true,
          stdout: "fine\n",
          stderr: "DeprecationWarning: old call\n",
          filesWritten: [],
        },
      ),
    );
    expect(part(html, "tool-row-code-stdout")).toContain("fine");
    expect(part(html, "tool-row-code-stdout")).not.toContain("DeprecationWarning");
    const stderr = part(html, "tool-row-code-stderr");
    expect(stderr).toContain("DeprecationWarning: old call");
    expect(stderr).toContain("text-[var(--text-3)]");
    expect(stderr).not.toContain("text-[var(--text-2)]");
    expect(html).toContain(">Errors</p>");
  });

  it("never renders program output as HTML", () => {
    const html = render(
      done(
        "run_code",
        { language: "javascript", code: "console.log('<b>x</b>')" },
        {
          ok: true,
          stdout: '<img src=x onerror="alert(1)"><script>alert(2)</script>',
          stderr: "<b>bold</b>",
          filesWritten: [],
        },
      ),
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    expect(part(html, "tool-row-code-stdout")).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(part(html, "tool-row-code-stdout")).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
    expect(part(html, "tool-row-code-stderr")).toContain("&lt;b&gt;bold&lt;/b&gt;");
  });

  it("says a clean run that printed nothing printed nothing", () => {
    const html = render(
      done("run_code", { language: "python", code: "x = 1" }, { ok: true, stdout: "", stderr: "", filesWritten: [] }),
    );
    expect(html).toContain("It ran and printed nothing.");
  });

  it.each([
    ["timeout", "It ran too long and was stopped."],
    ["memory", "It needed more memory than it is allowed and was stopped."],
    ["syntax", "The code has a syntax error, so it did not run."],
    ["runtime", "The code stopped with an error while running."],
    ["too_large", "The code or its output was too large."],
    ["busy", "Another run is in progress. Try again in a moment."],
    ["unavailable", "Running code is not available right now."],
  ])("explains a %s failure in words", (reason, sentence) => {
    const html = render(
      done(
        "run_code",
        { language: "python", code: "1/0" },
        { ok: false, stdout: "", stderr: "Traceback", filesWritten: [], reason },
      ),
    );
    expect(html).toContain('data-state="failed"');
    expect(html).toContain(">Python run failed</span>");
    expect(part(html, "tool-row-code-reason")).toContain(sentence);
    expect(part(html, "tool-row-code-stderr")).toContain("Traceback");
    expect(codeFailureText(reason)).toBe(sentence);
  });

  it("says a failure it does not know did not finish", () => {
    expect(codeFailureText("cosmic_ray")).toBe("The run did not finish.");
    expect(codeFailureText(undefined)).toBe("The run did not finish.");
  });

  it("shows the files a run saved as chips into the Knowledge Base", () => {
    const html = render(
      done(
        "run_code",
        { language: "python", code: "open('out/a.csv','w')" },
        {
          ok: true,
          stdout: "",
          stderr: "",
          filesWritten: [
            { path: "out/a.csv", version: 1 },
            { path: "out/summary report.md", version: 2 },
          ],
        },
      ),
    );
    const files = part(html, "tool-row-code-files");
    expect(files).toContain("Files saved");
    expect(files).toContain('href="/knowledge?file=out%2Fa.csv"');
    expect(files).toContain('href="/knowledge?file=out%2Fsummary%20report.md"');
    expect(files).toContain(">out/summary report.md</span>");
    expect(html.match(/data-testid="tool-row-file-chip"/g)).toHaveLength(2);
    // Each saved file can be taken off the desk, not only opened in the Knowledge Base.
    expect(html.match(/data-testid="tool-row-file-download"/g)).toHaveLength(2);
    expect(files).toContain('aria-label="Download out/a.csv to your computer"');
    expect(html).not.toContain("It ran and printed nothing.");
  });

  it("shows a run that is still going with its code available", () => {
    const html = render({ key: "run_code", status: "started", input: { language: "python", code: "sleep(5)" } });
    expect(html).toContain('data-state="running"');
    expect(html).toContain("Running Python…");
    expect(part(html, "tool-row-code-text")).toContain("sleep(5)");
    expect(html).not.toContain("tool-row-code-stdout");
  });

  it("shows a spent budget on run_code, not a run failure", () => {
    const html = render(
      done(
        "run_code",
        { language: "python", code: "1" },
        {
          ok: false,
          reason: "budget",
          message: "Tool budget spent for run_code: this run allows 1 call to it and they have run.",
        },
      ),
    );
    expect(html).toContain('data-state="budget"');
    expect(part(html, "tool-row-budget")).toContain("Tool budget spent");
    expect(html).not.toContain("tool-row-code-reason");
  });

  it("cuts a very long output for the screen and says so", () => {
    const html = render(
      done(
        "run_code",
        { language: "python", code: "x" },
        { ok: true, stdout: "a".repeat(25_000), stderr: "", filesWritten: [] },
      ),
    );
    expect(part(html, "tool-row-code-stdout").length).toBeLessThan(21_000);
    expect(html).toContain("Shortened here.");
  });
});

describe("the rows in Indonesian", () => {
  it("renders labels, states and reasons in Indonesian", () => {
    applyLocale("id");
    const pending = render(
      done(
        "write_file",
        { path: "laporan/q3.md" },
        { ok: true, root: "folder", status: "pending_approval", path: "laporan/q3.md", proposalId: "p" },
      ),
    );
    expect(pending).toContain("Mengusulkan penulisan berkas");
    expect(part(pending, "tool-row-pending-approval")).toContain("Menunggu persetujuan Anda");
    expect(part(pending, "tool-row-pending-review")).toContain(">Tinjau</button>");

    const budget = render(done("read_file", { path: "a.md" }, { ok: false, reason: "budget", message: "Habis." }));
    expect(part(budget, "tool-row-budget")).toContain("Jatah alat habis");

    const run = render(
      done(
        "run_code",
        { language: "python", code: "1/0" },
        { ok: false, stdout: "", stderr: "x", filesWritten: [], reason: "timeout" },
      ),
    );
    expect(run).toContain("Gagal menjalankan Python");
    expect(part(run, "tool-row-code-reason")).toContain("Berjalan terlalu lama, jadi dihentikan.");
    expect(run).toContain("Tampilkan kode");
    expect(run).toContain(">Kesalahan</p>");

    const saved = render(
      done("edit_file", { path: "a.md" }, { ok: true, root: "desk", status: "saved", path: "a.md", version: 7 }),
    );
    expect(saved).toContain("Mengubah a.md");
    expect(saved).toContain("Versi 7");
    expect(part(saved, "tool-row-file-chip")).toContain('aria-label="Buka a.md di Basis Pengetahuan"');
    expect(part(saved, "tool-row-file-chip")).toContain(">Buka</span>");

    const listed = render(done("list_files", {}, { ok: true, total: 3, truncated: false, entries: [] }));
    expect(listed).toContain("Daftar berkas Anda");
    expect(listed).toContain("3 berkas");
  });
});

describe("reading tool results", () => {
  it("classifies each ending", () => {
    expect(classifyOutcome("read_file", "started", undefined)).toEqual({ state: "running" });
    expect(classifyOutcome("read_file", "completed", { ok: true })).toEqual({ state: "done" });
    expect(classifyOutcome("read_file", "completed", null)).toEqual({ state: "done" });
    expect(classifyOutcome("read_file", "completed", "plain text")).toEqual({ state: "done" });
    expect(classifyOutcome("read_file", "completed", { ok: false, code: "denied", message: "No." })).toEqual({
      state: "refused",
      message: "No.",
    });
    expect(
      classifyOutcome("read_file", "completed", {
        success: false,
        error: "Tool read_file is disabled on this machine.",
      }),
    ).toEqual({
      state: "refused",
      message: "Tool read_file is disabled on this machine.",
    });
    expect(classifyOutcome("run_code", "completed", { ok: false, reason: "budget", message: "Spent." })).toEqual({
      state: "budget",
      message: "Spent.",
    });
    expect(
      classifyOutcome("edit_file", "completed", {
        ok: true,
        status: "pending_approval",
        path: "a.md",
        proposalId: "p",
      }),
    ).toEqual({ state: "pending", path: "a.md" });
    expect(classifyOutcome("run_code", "completed", { ok: false, stdout: "", stderr: "x", reason: "runtime" })).toEqual(
      {
        state: "done",
      },
    );
  });

  it("reads a code result and refuses to read anything else as one", () => {
    expect(
      readCodeResult({ ok: true, stdout: "a", stderr: "", filesWritten: [{ path: "out/x", version: 1 }, { nope: 1 }] }),
    ).toEqual({
      ok: true,
      stdout: "a",
      stderr: "",
      filesWritten: [{ path: "out/x", version: 1 }],
    });
    expect(readCodeResult({ ok: false, reason: "timeout" })?.reason).toBe("timeout");
    expect(readCodeResult({ ok: false, code: "bad_path", message: "x" })).toBeNull();
    expect(readCodeResult({ ok: false, reason: "budget", message: "x" })).toBeNull();
    expect(readCodeResult("nothing")).toBeNull();
  });

  it("reads a JSON string once and never throws on bad text", () => {
    expect(asRecord('{"a":1}')).toEqual({ a: 1 });
    expect(asRecord("{not json")).toBeNull();
    expect(asRecord("[1,2]")).toBeNull();
    expect(asRecord('"{\\"a\\":1}"')).toBeNull();
    expect(asRecord(null)).toBeNull();
    expect(asRecord([1])).toBeNull();
  });

  it("builds the Knowledge Base link", () => {
    expect(knowledgeFileHref("notes/plan.md")).toBe("/knowledge?file=notes%2Fplan.md");
    expect(knowledgeFileHref("a b.md")).toBe("/knowledge?file=a%20b.md");
  });

  it("gives details only for a finished, successful call", () => {
    expect(toolDetail("read_file", { ok: false, code: "x", message: "x" })).toBeNull();
    expect(toolDetail("read_file", { ok: true, firstLine: 1, lastLine: 1, totalLines: 0 })).toBeNull();
    expect(toolDetail("web_search", { ok: true })).toBeNull();
    expect(toolDetail("write_file", { ok: true, status: "saved", version: 9 })).toBe("Version 9");
    expect(toolDetail("write_file", { ok: true, status: "pending_approval" })).toBeNull();
  });
});

describe("revealing the folder changes panel", () => {
  function fakePanel() {
    const calls: string[] = [];
    const attributes = new Map<string, string>();
    return {
      calls,
      attributes,
      panel: {
        scrollIntoView: (options?: ScrollIntoViewOptions) =>
          calls.push(`scroll:${options?.behavior}:${options?.block}`),
        focus: (options?: FocusOptions) => calls.push(`focus:${options?.preventScroll}`),
        hasAttribute: (name: string) => attributes.has(name),
        setAttribute: (name: string, value: string) => attributes.set(name, value),
      },
    };
  }

  it("looks for the panel by its testid, scrolls to it and focuses it", () => {
    const { calls, attributes, panel } = fakePanel();
    const selectors: string[] = [];
    const found = revealFolderProposals(
      {
        querySelector: (selector) => {
          selectors.push(selector);
          return panel;
        },
      },
      false,
    );
    expect(found).toBe(true);
    expect(FOLDER_PROPOSALS_TESTID).toBe("folder-proposals");
    expect(selectors).toEqual(['[data-testid="folder-proposals"]']);
    expect(calls).toEqual(["scroll:smooth:center", "focus:true"]);
    expect(attributes.get("tabindex")).toBe("-1");
  });

  it("scrolls without animation for a person who asked for less motion, and keeps a tabindex it finds", () => {
    const { calls, attributes, panel } = fakePanel();
    attributes.set("tabindex", "0");
    expect(revealFolderProposals({ querySelector: () => panel }, true)).toBe(true);
    expect(calls[0]).toBe("scroll:auto:center");
    expect(attributes.get("tabindex")).toBe("0");
  });

  it("reports that the panel is not on the page", () => {
    expect(revealFolderProposals({ querySelector: () => null }, false)).toBe(false);
  });
});

describe("the rows inside a chat turn", () => {
  const content = [
    {
      type: "tool_call",
      toolKey: "calculator",
      status: "completed",
      input: { expression: "2 + 3" },
      output: { result: 5 },
    },
    {
      type: "tool_call",
      toolKey: "read_file",
      status: "completed",
      input: { path: "notes/plan.md" },
      output: { ok: true, totalLines: 10, firstLine: 1, lastLine: 10, truncated: false },
    },
    {
      type: "tool_call",
      toolKey: "run_code",
      status: "completed",
      input: { language: "python", code: "print(1)" },
      output: { ok: true, stdout: "1\n", stderr: "", filesWritten: [] },
    },
    { type: "text", text: "Done." },
  ];

  it("keeps the one-line summary for old tools and gives the new ones their rows", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ChatTurn role="assistant" content={content} />
      </MemoryRouter>,
    );
    expect(html.match(/data-testid="message-tool"/g)).toHaveLength(3);
    expect(html).toContain('data-tool="calculator"');
    expect(html).toContain("Calculator · 2 + 3 → 5");
    expect(part(html, "tool-row-file")).toContain("Read notes/plan.md");
    expect(part(html, "tool-row-code")).toContain("Ran Python");
    expect(html).toContain("Lines 1–10 of 10");
  });

  it("shows the activity sentence for a rich tool that is still running", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ChatTurn
          role="assistant"
          live={{
            thinking: "",
            streaming: "",
            running: true,
            tools: [{ key: "search_files", status: "started", input: { pattern: "total" } }],
          }}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Searching files for “total”…");
    expect(html).toContain('data-state="running"');
  });
});
