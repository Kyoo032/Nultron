import { describe, expect, it } from "vitest";
import {
  checksNote,
  DESK_SOURCE_MAX_CHARS,
  deskSourcesOverLimit,
  MAX_DESK_SOURCE_FILES,
  pickableFiles,
  pruneDeskSources,
  sourceFilesBody,
  splitDeskPath,
  splitDraftResponse,
  toggleDeskSource,
} from "./documents-desk-sources";
import type { FileEntry } from "./files-model";

const file = (path: string, bytes = 100): FileEntry => ({ path, kind: "file", bytes, updatedAt: 0, version: 1 });

describe("picking desk files", () => {
  it("lists files A to Z by path and leaves directories out", () => {
    const entries: FileEntry[] = [
      file("notes/b.md"),
      file("a.md"),
      { path: "notes", kind: "dir", bytes: 0, updatedAt: 0, version: null },
      file("notes/a10.md"),
      file("notes/a2.md"),
    ];
    expect(pickableFiles(entries).map((entry) => entry.path)).toEqual([
      "a.md",
      "notes/a2.md",
      "notes/a10.md",
      "notes/b.md",
    ]);
    // A new array: the caller's list is not reordered.
    expect(entries[0]?.path).toBe("notes/b.md");
  });

  it("splits a path into its folders and its file name, keeping the slash on the folders", () => {
    expect(splitDeskPath("notes/2026/plan.md")).toEqual({ dir: "notes/2026/", name: "plan.md" });
    expect(splitDeskPath("brief.md")).toEqual({ dir: "", name: "brief.md" });
    expect(splitDeskPath("notes/")).toEqual({ dir: "notes/", name: "" });
    const parts = splitDeskPath("a/b/c.txt");
    expect(parts.dir + parts.name).toBe("a/b/c.txt");
  });

  it("adds a path, removes a picked one, and never changes the list it was given", () => {
    const one = ["a.md"];
    const two = toggleDeskSource(one, "b.md");
    expect(two).toEqual(["a.md", "b.md"]);
    expect(one).toEqual(["a.md"]);
    expect(toggleDeskSource(two, "a.md")).toEqual(["b.md"]);
  });

  it("stops at five: a sixth add changes nothing, a removal still works", () => {
    const five = Array.from({ length: MAX_DESK_SOURCE_FILES }, (_, index) => `f${index}.md`);
    expect(toggleDeskSource(five, "extra.md")).toEqual(five);
    expect(toggleDeskSource(five, "f0.md")).toEqual(["f1.md", "f2.md", "f3.md", "f4.md"]);
  });

  it("drops a picked path that is no longer on the desk, keeping the order", () => {
    expect(pruneDeskSources(["a.md", "gone.md", "c.md"], ["c.md", "a.md", "z.md"])).toEqual(["a.md", "c.md"]);
    expect(pruneDeskSources([], ["a.md"])).toEqual([]);
  });

  it("sends sourceFiles only when something is picked, so the body is as it was otherwise", () => {
    expect(sourceFilesBody([])).toEqual({});
    expect(sourceFilesBody(["a.md", "b.md"])).toEqual({ sourceFiles: ["a.md", "b.md"] });
    expect(JSON.stringify({ prompt: "x", ...sourceFilesBody([]) })).toBe('{"prompt":"x"}');
  });

  it("mirrors the host's five-file and 120k-character limits", () => {
    expect(MAX_DESK_SOURCE_FILES).toBe(5);
    expect(DESK_SOURCE_MAX_CHARS).toBe(120_000);
  });

  it("warns when the picked files and the pasted text together pass the ceiling", () => {
    const entries = [file("a.md", 70_000), file("b.md", 40_000)];
    expect(deskSourcesOverLimit(["a.md", "b.md"], entries, 10_000)).toBe(false);
    expect(deskSourcesOverLimit(["a.md", "b.md"], entries, 10_001)).toBe(true);
    expect(deskSourcesOverLimit(["a.md"], entries, 0)).toBe(false);
    // A path the list does not know adds nothing.
    expect(deskSourcesOverLimit(["unknown.md"], entries, 0)).toBe(false);
  });
});

describe("the generate response", () => {
  const DRAFT = { title: "Memo", sections: [{ heading: "One", body: "Body." }] };

  it("is the plain draft when the host sent no checks", () => {
    expect(splitDraftResponse(DRAFT)).toEqual({ draft: DRAFT, checks: null });
  });

  it("takes the checks off the draft so the preview and the download get the draft alone", () => {
    const checks = {
      passed: false,
      rounds: 1,
      failures: [{ check: "grounding", error: "A section does not follow", sections: [0] }],
    };
    const split = splitDraftResponse({ ...DRAFT, checks });
    expect(split.draft).toEqual(DRAFT);
    expect(split.draft).not.toHaveProperty("checks");
    expect(split.checks).toEqual(checks);
  });

  it("ignores a failure it does not know and a section that is not a number", () => {
    const split = splitDraftResponse({
      ...DRAFT,
      checks: {
        passed: false,
        rounds: 1,
        failures: [
          { check: "mystery", error: "x", sections: [0] },
          { check: "structure", error: "y", sections: ["a", -1, 1.5, 2] },
        ],
      },
    });
    expect(split.checks?.failures).toEqual([{ check: "structure", error: "y", sections: [2] }]);
  });

  it("never reads a report as passed while it lists a failure", () => {
    const split = splitDraftResponse({
      ...DRAFT,
      checks: { passed: true, rounds: 0, failures: [{ check: "structure", error: "y", sections: [] }] },
    });
    expect(split.checks?.passed).toBe(false);
  });

  it("survives a body that is not an object", () => {
    expect(splitDraftResponse(null).checks).toBeNull();
    expect(splitDraftResponse("text").checks).toBeNull();
  });
});

describe("the note the page shows", () => {
  const sections = [{ heading: "Context" }, { heading: "Risks" }, { heading: "Ask" }];
  const failure = (check: "structure" | "grounding", list: number[]) => ({
    passed: false,
    rounds: 1,
    failures: [{ check, error: "e", sections: list }],
  });

  it("is nothing when the checks passed, or there are none", () => {
    expect(checksNote(null, sections)).toBeNull();
    expect(checksNote({ passed: true, rounds: 1, failures: [] }, sections)).toBeNull();
  });

  it("names the sections that may not follow the source, once each", () => {
    expect(checksNote(failure("grounding", [2, 0, 2]), sections)).toEqual({
      kind: "grounding",
      headings: ["Ask", "Context"],
    });
  });

  it("names a heading shared by two flagged sections once", () => {
    expect(checksNote(failure("grounding", [0, 1]), [{ heading: "Notes" }, { heading: "Notes" }])).toEqual({
      kind: "grounding",
      headings: ["Notes"],
    });
  });

  it("falls back to the structure note when a flagged section is gone", () => {
    expect(checksNote(failure("grounding", [7]), sections)).toBeNull();
    const both = {
      passed: false,
      rounds: 1,
      failures: [
        { check: "grounding" as const, error: "g", sections: [7] },
        { check: "structure" as const, error: "s", sections: [] },
      ],
    };
    expect(checksNote(both, sections)).toEqual({ kind: "structure" });
  });

  it("says structure for a structure failure, and prefers the sections when both failed", () => {
    expect(checksNote(failure("structure", []), sections)).toEqual({ kind: "structure" });
    const both = {
      passed: false,
      rounds: 1,
      failures: [
        { check: "structure" as const, error: "s", sections: [] },
        { check: "grounding" as const, error: "g", sections: [1] },
      ],
    };
    expect(checksNote(both, sections)).toEqual({ kind: "grounding", headings: ["Risks"] });
  });
});
