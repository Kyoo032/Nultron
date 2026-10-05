import { describe, expect, it } from "vitest";
import { MAX_STREAM_BYTES } from "./limits";
import { capUtf8, cleanGuestError, composeStream, hostRedactions, scrubHost } from "./sanitize";

const PYODIDE_TRACEBACK = [
  "Traceback (most recent call last):",
  '  File "/lib/python314.zip/_pyodide/_base.py", line 619, in eval_code_async',
  "    await CodeRunner(",
  "    ...<10 lines>...",
  "    .run_async(globals, locals)",
  '  File "/lib/python314.zip/_pyodide/_base.py", line 420, in run_async',
  "    coroutine = eval(self.code, globals, locals)",
  '  File "<exec>", line 3, in <module>',
  '  File "<exec>", line 2, in f',
  "ZeroDivisionError: division by zero",
  "",
].join("\n");

describe("cleanGuestError", () => {
  it("keeps the guest's own frames and drops the Pyodide wrapper frames with their source lines", () => {
    expect(cleanGuestError(PYODIDE_TRACEBACK, [])).toBe(
      [
        "Traceback (most recent call last):",
        '  File "<exec>", line 3, in <module>',
        '  File "<exec>", line 2, in f',
        "ZeroDivisionError: division by zero",
      ].join("\n"),
    );
  });

  it("keeps the source and caret lines under a guest frame", () => {
    const syntax = [
      "Traceback (most recent call last):",
      '  File "/lib/python314.zip/_pyodide/_base.py", line 151, in _parse_and_compile_gen',
      "    mod = compile(source, filename, mode, flags | ast.PyCF_ONLY_AST)",
      '  File "<exec>", line 1',
      "    def f(:",
      "          ^",
      "SyntaxError: invalid syntax",
    ].join("\n");
    expect(cleanGuestError(syntax, [])).toBe(
      [
        "Traceback (most recent call last):",
        '  File "<exec>", line 1',
        "    def f(:",
        "          ^",
        "SyntaxError: invalid syntax",
      ].join("\n"),
    );
  });

  it("keeps a QuickJS stack, which names only <exec>", () => {
    const js = "TypeError: cannot read property 'x' of null\n    at <eval> (<exec>:1:5)\n";
    expect(cleanGuestError(js, [])).toBe("TypeError: cannot read property 'x' of null\n    at <eval> (<exec>:1:5)");
  });

  it("keeps a /workspace frame from a pandas read of the guest's own file", () => {
    const text = "FileNotFoundError: [Errno 44] No such file or directory: '/workspace/data.csv'";
    expect(cleanGuestError(text, [])).toBe(text);
  });

  it("removes file URLs, Windows paths and Node internals", () => {
    const text = [
      "Error: boom",
      "    at load (file:///C:/Users/someone/app/resources/sandbox/vendor/pyodide/pyodide.asm.mjs:1:2)",
      "    at node:internal/modules/run_main:1:1",
      "Cannot open C:\\Users\\someone\\secret.txt now",
    ].join("\n");
    const cleaned = cleanGuestError(text, []);
    expect(cleaned).not.toMatch(/someone|file:\/\/|node:internal|C:\\/);
    expect(cleaned).toContain("[host path]");
  });

  it("removes the exact host strings it was told about, in both slash styles and any case", () => {
    const ship = "C:\\Program Files\\Nultron\\resources\\sandbox";
    const text = `failed in ${ship}\\vendor and again in ${ship.replaceAll("\\", "/").toUpperCase()}/x`;
    const cleaned = cleanGuestError(text, hostRedactions([ship]));
    expect(cleaned).not.toMatch(/Nultron|Program Files/i);
  });
});

describe("scrubHost", () => {
  it("leaves guest virtual paths alone", () => {
    const text = "see /workspace/out/a.csv and /home/pyodide/x and /tmp/y and /lib/python314.zip/z";
    expect(scrubHost(text, [])).toBe(text);
  });

  it("ignores redactions too short to be a path", () => {
    expect(hostRedactions(["/", "ab"])).not.toContain("/");
    expect(hostRedactions(["/", "ab"])).not.toContain("ab");
  });
});

describe("capUtf8", () => {
  it("passes short text through", () => {
    expect(capUtf8("hello")).toEqual({ text: "hello", cut: false });
  });

  it("cuts at the byte cap on a character boundary and says so, staying within the cap", () => {
    const text = "é".repeat(MAX_STREAM_BYTES);
    const capped = capUtf8(text);
    expect(capped.cut).toBe(true);
    expect(Buffer.byteLength(capped.text, "utf8")).toBeLessThanOrEqual(MAX_STREAM_BYTES);
    expect(capped.text).toContain("[run_code] Output cut at 64 KB.");
    expect(capped.text).not.toContain(String.fromCharCode(0xfffd));
  });
});

describe("composeStream", () => {
  it("appends the runner's notes after the guest's text", () => {
    expect(composeStream("out", ["[run_code] a", "[run_code] b"])).toBe("out\n[run_code] a\n[run_code] b");
  });

  it("returns just the notes when the guest wrote nothing", () => {
    expect(composeStream("", ["[run_code] a"])).toBe("[run_code] a");
  });

  it("keeps the notes whole when the guest text has to be cut, and stays within the cap", () => {
    const composed = composeStream("x".repeat(200_000), ["[run_code] Skipped out/a.bin: not text."]);
    expect(Buffer.byteLength(composed, "utf8")).toBeLessThanOrEqual(MAX_STREAM_BYTES);
    expect(composed.endsWith("[run_code] Skipped out/a.bin: not text.")).toBe(true);
    expect(composed).toContain("Output cut");
  });
});
