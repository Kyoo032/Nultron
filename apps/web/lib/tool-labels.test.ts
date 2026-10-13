import { afterEach, describe, expect, it } from "vitest";
import { classifyOutcome } from "@/components/tool-rows/results";
import { applyLocale, resetLocaleForTests, t } from "./i18n";
import {
  codeLanguageName,
  showsToolActivity,
  showsToolSpinner,
  toolActivityLabel,
  toolCallSummary,
  toolDoneLabel,
  toolRowLabel,
} from "./tool-labels";

afterEach(() => {
  resetLocaleForTests();
});

describe("tool-labels", () => {
  it("shows every tool in the transcript, with a compact spinner for calculator", () => {
    expect(showsToolActivity("calculator")).toBe(true);
    expect(showsToolSpinner("calculator")).toBe(false);
    expect(showsToolSpinner("web_search")).toBe(true);
    expect(showsToolSpinner("read_file")).toBe(true);
  });

  it("uses plain-language activity labels", () => {
    expect(toolActivityLabel("web_search")).toBe("Searching…");
    expect(toolActivityLabel("image_generate")).toBe("Creating image…");
    expect(toolActivityLabel("video_generate")).toBe("Creating video…");
    expect(toolActivityLabel("past_sessions")).toBe("Looking up past chats…");
    expect(toolActivityLabel("custom_pack_tool")).toBe("Working…");
  });

  it("summarizes calculator input and output", () => {
    expect(toolCallSummary("calculator", { expression: "2 + 3" }, { result: 5 })).toBe("Calculator · 2 + 3 → 5");
  });

  it("names the self check in plain words, in both languages", () => {
    expect(toolActivityLabel("self_check")).toBe("Checking this desk…");
    expect(toolDoneLabel("self_check")).toBe("Desk check");
    applyLocale("id");
    expect(toolActivityLabel("self_check")).toBe("Memeriksa meja ini…");
    expect(toolDoneLabel("self_check")).toBe("Pemeriksaan meja");
  });

  it("shows a tool that threw as a refusal, with the words the model was given", () => {
    const failed = { ok: false, reason: "tool_error", message: "The web_search tool failed: timed out." };
    expect(classifyOutcome("web_search", "completed", failed)).toEqual({
      state: "refused",
      message: "The web_search tool failed: timed out.",
    });
  });
});

describe("file, Knowledge and code tool labels (en)", () => {
  const saved = { ok: true, root: "desk", status: "saved", path: "notes/plan.md", version: 2 };

  it("says what happened, with the key argument", () => {
    expect(toolRowLabel("read_file", { path: "notes/plan.md" }, { ok: true, path: "notes/plan.md" })).toBe(
      "Read notes/plan.md",
    );
    expect(toolRowLabel("write_file", { path: "notes/plan.md", content: "x" }, saved)).toBe("Wrote notes/plan.md");
    expect(toolRowLabel("edit_file", { path: "src/app.ts" }, { ...saved, path: "src/app.ts" })).toBe(
      "Edited src/app.ts",
    );
    expect(toolRowLabel("delete_file", { path: "old.txt" }, { ...saved, path: "old.txt" })).toBe("Deleted old.txt");
    expect(toolRowLabel("list_files", { dir: "notes" }, { ok: true, entries: [] })).toBe("Listed files in notes");
    expect(toolRowLabel("list_files", {}, { ok: true, entries: [] })).toBe("Listed your files");
    expect(toolRowLabel("search_files", { pattern: "total" }, { ok: true, hits: [] })).toBe(
      "Searched files for “total”",
    );
    expect(toolRowLabel("knowledge_search", { query: "refund policy" }, { results: [] })).toBe(
      "Searched your knowledge for “refund policy”",
    );
    expect(
      toolRowLabel(
        "run_code",
        { language: "python", code: "print(1)" },
        { ok: true, stdout: "1\n", stderr: "", filesWritten: [] },
      ),
    ).toBe("Ran Python");
    expect(
      toolRowLabel(
        "run_code",
        { language: "javascript", code: "1" },
        { ok: true, stdout: "", stderr: "", filesWritten: [] },
      ),
    ).toBe("Ran JavaScript");
  });

  it("names the deck a build_deck call made, and says so when it could not", () => {
    const input = { title: "Warung expansion plan", slides: [{ heading: "One" }] };
    const made = { ok: true, artifactId: "a", filename: "warung-expansion-plan.pptx", slideCount: 2 };
    expect(toolRowLabel("build_deck", input, made)).toBe("Built “Warung expansion plan”");
    expect(toolRowLabel("build_deck", input, { ok: false, reason: "checks", message: "x" })).toBe(
      "Could not build the deck",
    );
    expect(toolActivityLabel("build_deck", input)).toBe("Building “Warung expansion plan”…");
    expect(toolRowLabel("build_deck", {}, made)).toBe("Build deck");
    expect(toolDoneLabel("build_deck")).toBe("Build deck");
  });

  it("uses the activity wording while the call is still running", () => {
    expect(toolActivityLabel("read_file", { path: "notes/plan.md" })).toBe("Reading notes/plan.md…");
    expect(toolActivityLabel("write_file", { path: "a.md" })).toBe("Writing a.md…");
    expect(toolActivityLabel("edit_file", { path: "a.md" })).toBe("Editing a.md…");
    expect(toolActivityLabel("delete_file", { path: "a.md" })).toBe("Deleting a.md…");
    expect(toolActivityLabel("list_files", { dir: "notes" })).toBe("Listing files in notes…");
    expect(toolActivityLabel("list_files", {})).toBe("Listing your files…");
    expect(toolActivityLabel("search_files", { pattern: "total" })).toBe("Searching files for “total”…");
    expect(toolActivityLabel("knowledge_search", { query: "tax" })).toBe("Searching your knowledge for “tax”…");
    expect(toolActivityLabel("run_code", { language: "python" })).toBe("Running Python…");
  });

  it("falls back to the tool's name when its argument is missing", () => {
    expect(toolRowLabel("read_file", {}, { ok: true })).toBe("Read file");
    expect(toolRowLabel("search_files", undefined, { ok: true, hits: [] })).toBe("Search files");
    expect(toolRowLabel("run_code", { language: "ruby" }, { ok: true, stdout: "" })).toBe("Run code");
    expect(toolActivityLabel("read_file")).toBe("Working…");
    expect(toolDoneLabel("run_code")).toBe("Run code");
    expect(toolDoneLabel("knowledge_search")).toBe("Knowledge search");
  });

  it("says a refusal did not happen", () => {
    const refusal = { ok: false, code: "not_found", message: "No such file." };
    expect(toolRowLabel("read_file", { path: "gone.md" }, refusal)).toBe("Could not read gone.md");
    expect(toolRowLabel("write_file", { path: "a.md" }, refusal)).toBe("Could not write a.md");
    expect(toolRowLabel("edit_file", { path: "a.md" }, refusal)).toBe("Could not edit a.md");
    expect(toolRowLabel("delete_file", { path: "a.md" }, refusal)).toBe("Could not delete a.md");
    expect(toolRowLabel("list_files", { dir: "nope" }, refusal)).toBe("Could not list files");
    expect(toolRowLabel("search_files", { pattern: "(" }, refusal)).toBe("Could not search files for “(”");
    expect(
      toolRowLabel("knowledge_search", { query: "tax" }, { ok: false, reason: "unavailable", message: "Down." }),
    ).toBe("Could not search your knowledge");
    expect(toolRowLabel("knowledge_search", undefined, { ok: false, reason: "unavailable", message: "Down." })).toBe(
      "Could not search your knowledge",
    );
  });

  it("labels a spent budget as not done, and a failed run as a failed run", () => {
    const budget = { ok: false, reason: "budget", message: "Tool budget spent." };
    expect(toolRowLabel("run_code", { language: "python" }, budget)).toBe("Python run failed");
    expect(toolRowLabel("read_file", { path: "a.md" }, budget)).toBe("Could not read a.md");
    expect(
      toolRowLabel(
        "run_code",
        { language: "python" },
        { ok: false, stdout: "", stderr: "boom", filesWritten: [], reason: "timeout" },
      ),
    ).toBe("Python run failed");
  });

  it("says a folder change was proposed, not made", () => {
    const pending = { ok: true, root: "folder", status: "pending_approval", path: "a.md", proposalId: "p1" };
    expect(toolRowLabel("write_file", { path: "a.md" }, pending)).toBe("Proposed writing a file");
    expect(toolRowLabel("edit_file", { path: "a.md" }, pending)).toBe("Proposed editing a file");
    expect(toolRowLabel("delete_file", { path: "a.md" }, pending)).toBe("Proposed deleting a file");
  });

  it("cuts a very long query and keeps the rest of the label whole", () => {
    const long = "x".repeat(200);
    const label = toolRowLabel("search_files", { pattern: long }, { ok: true, hits: [] });
    expect(label).toBe(`Searched files for “${"x".repeat(79)}…”`);
  });

  it("reads arguments and results that arrive as JSON text", () => {
    expect(toolRowLabel("read_file", '{"path":"notes/plan.md"}', '{"ok":true}')).toBe("Read notes/plan.md");
  });

  it("uses the summary line for a rich tool when only the summary is asked for", () => {
    expect(toolCallSummary("read_file", { path: "notes/plan.md" }, { ok: true })).toBe("Read notes/plan.md");
  });

  it("knows the two languages run_code has", () => {
    expect(codeLanguageName("python")).toBe("Python");
    expect(codeLanguageName("JavaScript")).toBe("JavaScript");
    expect(codeLanguageName("ruby")).toBeUndefined();
    expect(codeLanguageName(undefined)).toBeUndefined();
  });
});

describe("file, Knowledge and code tool labels (id)", () => {
  const saved = { ok: true, root: "desk", status: "saved", path: "catatan/rencana.md", version: 1 };

  it("says what happened in Indonesian", () => {
    applyLocale("id");
    expect(toolRowLabel("read_file", { path: "catatan/rencana.md" }, { ok: true })).toBe("Membaca catatan/rencana.md");
    expect(toolRowLabel("write_file", { path: "catatan/rencana.md" }, saved)).toBe("Menulis catatan/rencana.md");
    expect(toolRowLabel("edit_file", { path: "src/app.ts" }, saved)).toBe("Mengubah src/app.ts");
    expect(toolRowLabel("delete_file", { path: "lama.txt" }, saved)).toBe("Menghapus lama.txt");
    expect(toolRowLabel("list_files", { dir: "catatan" }, { ok: true })).toBe("Daftar berkas di catatan");
    expect(toolRowLabel("list_files", {}, { ok: true })).toBe("Daftar berkas Anda");
    expect(toolRowLabel("search_files", { pattern: "total" }, { ok: true, hits: [] })).toBe(
      "Pencarian “total” di berkas",
    );
    expect(toolRowLabel("knowledge_search", { query: "pajak" }, { results: [] })).toBe(
      "Pencarian “pajak” di basis pengetahuan Anda",
    );
    expect(toolRowLabel("run_code", { language: "python" }, { ok: true, stdout: "" })).toBe("Menjalankan Python");
  });

  it("uses the activity wording while running", () => {
    applyLocale("id");
    expect(toolActivityLabel("read_file", { path: "a.md" })).toBe("Sedang membaca a.md…");
    expect(toolActivityLabel("write_file", { path: "a.md" })).toBe("Sedang menulis a.md…");
    expect(toolActivityLabel("edit_file", { path: "a.md" })).toBe("Sedang mengubah a.md…");
    expect(toolActivityLabel("delete_file", { path: "a.md" })).toBe("Sedang menghapus a.md…");
    expect(toolActivityLabel("list_files", { dir: "catatan" })).toBe("Menampilkan daftar berkas di catatan…");
    expect(toolActivityLabel("list_files", {})).toBe("Menampilkan daftar berkas Anda…");
    expect(toolActivityLabel("search_files", { pattern: "total" })).toBe("Mencari “total” di berkas…");
    expect(toolActivityLabel("knowledge_search", { query: "pajak" })).toBe(
      "Mencari “pajak” di basis pengetahuan Anda…",
    );
    expect(toolActivityLabel("run_code", { language: "javascript" })).toBe("Sedang menjalankan JavaScript…");
  });

  it("says a refusal, a proposal and a failed run in Indonesian", () => {
    applyLocale("id");
    const refusal = { ok: false, code: "not_found", message: "Tidak ada." };
    expect(toolRowLabel("read_file", { path: "a.md" }, refusal)).toBe("Tidak dapat membaca a.md");
    expect(toolRowLabel("write_file", { path: "a.md" }, refusal)).toBe("Tidak dapat menulis a.md");
    expect(toolRowLabel("edit_file", { path: "a.md" }, refusal)).toBe("Tidak dapat mengubah a.md");
    expect(toolRowLabel("delete_file", { path: "a.md" }, refusal)).toBe("Tidak dapat menghapus a.md");
    expect(toolRowLabel("list_files", {}, refusal)).toBe("Tidak dapat menampilkan daftar berkas");
    expect(toolRowLabel("search_files", { pattern: "x" }, refusal)).toBe("Tidak dapat mencari “x” di berkas");
    expect(toolRowLabel("knowledge_search", { query: "x" }, { ok: false, reason: "unavailable", message: "." })).toBe(
      "Tidak dapat mencari di basis pengetahuan Anda",
    );
    expect(
      toolRowLabel("run_code", { language: "python" }, { ok: false, stdout: "", stderr: "x", reason: "syntax" }),
    ).toBe("Menjalankan Python gagal");
    const pending = { ok: true, status: "pending_approval", path: "a.md", proposalId: "p" };
    expect(toolRowLabel("write_file", { path: "a.md" }, pending)).toBe("Mengusulkan penulisan berkas");
    expect(toolRowLabel("edit_file", { path: "a.md" }, pending)).toBe("Mengusulkan perubahan berkas");
    expect(toolRowLabel("delete_file", { path: "a.md" }, pending)).toBe("Mengusulkan penghapusan berkas");
  });

  it("falls back to the Indonesian tool name", () => {
    applyLocale("id");
    expect(toolDoneLabel("read_file")).toBe("Baca berkas");
    expect(toolDoneLabel("knowledge_search")).toBe("Pencarian pengetahuan");
    expect(toolRowLabel("run_code", {}, { ok: true, stdout: "" })).toBe("Jalankan kode");
  });
});

describe("the tools catalog resolves every key the rows build at run time", () => {
  const tools = [
    "list_files",
    "read_file",
    "write_file",
    "edit_file",
    "search_files",
    "delete_file",
    "knowledge_search",
    "run_code",
    "build_deck",
  ];
  const keys = [
    ...[
      "label",
      "open",
      "close",
      "openAria",
      "closeAria",
      "download",
      "downloading",
      "downloadAria",
      "downloadFailed",
      "noPreview",
      "outlineAria",
      "previewAria",
    ].map((name) => `chat.deck.${name}`),
    ...tools.map((tool) => `chat.tools.name.${tool}`),
    ...tools.map((tool) => `chat.tools.doing.${tool}`),
    ...tools.map((tool) => `chat.tools.done.${tool}`),
    ...tools.map((tool) => `chat.tools.failed.${tool}`),
    "chat.tools.doing.list_files_top",
    "chat.tools.done.list_files_top",
    "chat.tools.pending.write_file",
    "chat.tools.pending.edit_file",
    "chat.tools.pending.delete_file",
    ...[
      "none",
      "more",
      "files",
      "filesOne",
      "matches",
      "matchesOne",
      "excerpts",
      "excerptsOne",
      "lineRange",
      "version",
      "slides",
      "slidesOne",
    ].map((name) => `chat.tools.detail.${name}`),
    ...["timeout", "memory", "syntax", "runtime", "too_large", "busy", "unavailable", "other"].map(
      (reason) => `chat.tools.code.reason.${reason}`,
    ),
    ...["show", "heading", "stdout", "stderr", "noOutput", "cut", "filesWritten"].map(
      (name) => `chat.tools.code.${name}`,
    ),
    ...["open", "openAria", "pendingTitle", "review", "reviewMissing", "budgetTitle"].map(
      (name) => `chat.tools.${name}`,
    ),
  ];

  it.each(["en", "id"])("has every key in %s", (locale) => {
    applyLocale(locale);
    const unresolved = keys.filter((key) => t(key) === key);
    expect(unresolved).toEqual([]);
  });

  it("lists eighty-six keys, so a key dropped from the list is noticed", () => {
    expect(keys).toHaveLength(86);
  });
});

describe("web_fetch labels", () => {
  const page = { success: true, data: { url: "https://example.com/a", finalUrl: "https://example.com/a" } };
  const refused = { success: false, error: "Page returned HTTP 404" };

  it("names the fetched host in English", () => {
    const input = { url: "https://example.com/pricing?x=1" };
    expect(toolActivityLabel("web_fetch", input)).toBe("Opening example.com…");
    expect(toolCallSummary("web_fetch", input, page)).toBe("Opened example.com");
    expect(toolCallSummary("web_fetch", input, refused)).toBe("Could not open example.com");
    expect(toolRowLabel("web_fetch", input, page)).toBe("Opened example.com");
  });

  it("reads the url from arguments that arrive as JSON text", () => {
    expect(toolCallSummary("web_fetch", '{"url":"https://docs.example.org/guide"}', page)).toBe(
      "Opened docs.example.org",
    );
  });

  it("does not show the page address, only its host", () => {
    const label = toolCallSummary("web_fetch", { url: "https://example.com/secret/path?token=abc" }, page);
    expect(label).not.toContain("secret");
    expect(label).not.toContain("token");
  });

  it("falls back to a plain sentence when the address is missing or not a web page", () => {
    expect(toolActivityLabel("web_fetch")).toBe("Opening a page…");
    expect(toolActivityLabel("web_fetch", { url: "not a url" })).toBe("Opening a page…");
    expect(toolCallSummary("web_fetch", { url: "file:///etc/passwd" }, page)).toBe("Web page");
    expect(toolCallSummary("web_fetch", undefined, refused)).toBe("Could not open the page");
    expect(toolDoneLabel("web_fetch")).toBe("Web page");
  });

  it("says a spent budget did not open the page", () => {
    const budget = { ok: false, reason: "budget", message: "Tool budget spent." };
    expect(toolCallSummary("web_fetch", { url: "https://example.com" }, budget)).toBe("Could not open example.com");
  });

  it("names the fetched host in Indonesian", () => {
    applyLocale("id");
    const input = { url: "https://example.com/pricing" };
    expect(toolActivityLabel("web_fetch", input)).toBe("Sedang membuka example.com…");
    expect(toolCallSummary("web_fetch", input, page)).toBe("Membuka example.com");
    expect(toolCallSummary("web_fetch", input, refused)).toBe("Tidak dapat membuka example.com");
    expect(toolActivityLabel("web_fetch")).toBe("Sedang membuka halaman…");
    expect(toolCallSummary("web_fetch", undefined, refused)).toBe("Tidak dapat membuka halaman");
    expect(toolDoneLabel("web_fetch")).toBe("Halaman web");
  });

  it.each(["en", "id"])("has every web_fetch key in %s", (locale) => {
    applyLocale(locale);
    const keys = [
      "chat.tool.fetching",
      "chat.tool.fetch",
      "chat.tool.fetchFailed",
      "chat.tools.doing.web_fetch",
      "chat.tools.done.web_fetch",
      "chat.tools.failed.web_fetch",
    ];
    expect(keys.filter((key) => t(key) === key)).toEqual([]);
  });
});

describe("what a search row shows (safe web search)", () => {
  const LONG_QUERY = "Indonesian personal data protection law cross-border transfer requirements for cloud providers";

  it("names a web search's whole query, not a clipped one", () => {
    expect(toolCallSummary("web_search", { query: LONG_QUERY }, undefined)).toBe(`Search · ${LONG_QUERY}`);
  });

  it("shows why a search was not sent", () => {
    const refusal = { ok: false, reason: "outbound", message: "Not sent: too long." };
    expect(toolCallSummary("web_search", { query: "q" }, refusal)).toBe("Search · q → Not sent: too long.");
  });

  it("lists every search a dossier ran on its own line, in both languages", () => {
    const output = {
      ok: false,
      reason: "failed",
      code: "outbound_refused",
      message: "Not sent.",
      queries: ["a b", "c"],
    };
    expect(toolCallSummary("research_dossier", { question: "x" }, output)).toBe(
      "Research dossier · Not sent.\nSearched the web for: a b · c",
    );
    applyLocale("id");
    expect(toolCallSummary("research_dossier", { question: "x" }, output)).toBe(
      "Dosir riset · Not sent.\nDicari di web: a b · c",
    );
  });
});
