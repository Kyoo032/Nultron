import { describe, expect, it } from "vitest";
import { classifyCrash, classifyGuestError, NOTES, skippedNote } from "./outcome";
import type { ChildResult } from "./protocol";

function result(patch: Partial<ChildResult>): ChildResult {
  return {
    type: "result",
    id: "1",
    error: null,
    errorName: null,
    why: null,
    value: null,
    stdout: "",
    stderr: "",
    files: {},
    skipped: [],
    tooLarge: false,
    discard: false,
    runMs: 1,
    ...patch,
  };
}

describe("classifyGuestError, Python", () => {
  it.each([
    ["SyntaxError", "syntax"],
    ["IndentationError", "syntax"],
    ["TabError", "syntax"],
    ["MemoryError", "memory"],
    ["ZeroDivisionError", "runtime"],
    ["KeyError", "runtime"],
    ["RecursionError", "runtime"],
  ] as const)("%s is %s", (errorName, expected) => {
    expect(classifyGuestError("python", result({ error: `${errorName}: x`, errorName }))).toBe(expected);
  });

  it("calls the wasm cap a memory failure whatever the exception type says", () => {
    expect(
      classifyGuestError("python", result({ error: "RangeError: wasm memory cap reached", errorName: "RangeError" })),
    ).toBe("memory");
  });
});

describe("classifyGuestError, JavaScript", () => {
  it("maps the interrupt deadline to timeout and the wasm cap to memory", () => {
    expect(classifyGuestError("javascript", result({ error: "InternalError: interrupted", why: "deadline" }))).toBe(
      "timeout",
    );
    expect(classifyGuestError("javascript", result({ error: "InternalError: interrupted", why: "wasm-memory" }))).toBe(
      "memory",
    );
  });

  it("maps QuickJS out of memory to memory, SyntaxError to syntax, everything else to runtime", () => {
    expect(
      classifyGuestError("javascript", result({ error: "InternalError: out of memory", errorName: "InternalError" })),
    ).toBe("memory");
    expect(classifyGuestError("javascript", result({ error: "SyntaxError: x", errorName: "SyntaxError" }))).toBe(
      "syntax",
    );
    expect(classifyGuestError("javascript", result({ error: "TypeError: x", errorName: "TypeError" }))).toBe("runtime");
  });
});

describe("classifyCrash", () => {
  it("reads a permission refusal as the sandbox doing its job", () => {
    expect(classifyCrash("Error [ERR_ACCESS_DENIED]: Access to this API has been restricted")).toEqual({
      reason: "runtime",
      note: NOTES.denied,
    });
  });

  it("reads a V8 heap exhaustion as memory", () => {
    expect(
      classifyCrash("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory").reason,
    ).toBe("memory");
  });

  it("calls anything else an unexpected stop, with a fixed sentence", () => {
    expect(classifyCrash("")).toEqual({ reason: "runtime", note: NOTES.crashed });
    expect(classifyCrash("C:\\Users\\someone\\secret\\file.js:1 weird failure").note).not.toContain("someone");
  });
});

describe("skippedNote", () => {
  it("uses fixed phrases and names the file", () => {
    expect(skippedNote("out/a.bin", "binary")).toBe(
      "[run_code] Skipped out/a.bin: not valid UTF-8 text; the desk only keeps text files.",
    );
    expect(skippedNote("out/b.txt", "too_large")).toBe("[run_code] Skipped out/b.txt: larger than 2 MB.");
    expect(skippedNote("out/c.txt", "mystery")).toBe("[run_code] Skipped out/c.txt: not saved.");
  });
});
