import { describe, expect, it } from "vitest";
import { filenameFromDisposition, leafName } from "./download-name";

describe("filenameFromDisposition", () => {
  it("reads a quoted name", () => {
    expect(filenameFromDisposition('attachment; filename="plan.md"')).toBe("plan.md");
  });

  it("prefers the UTF-8 form, which carries the real name", () => {
    expect(
      filenameFromDisposition("attachment; filename=\"My plan _.md\"; filename*=UTF-8''My%20plan%20%E2%98%95.md"),
    ).toBe("My plan ☕.md");
  });

  it("reads a name that only has the RFC 5987 form", () => {
    expect(filenameFromDisposition("attachment; filename*=UTF-8''Rapat%20Dir%C3%A9ksi.docx")).toBe(
      "Rapat Diréksi.docx",
    );
  });

  it("falls back to the plain name when the UTF-8 form has a bad escape", () => {
    expect(filenameFromDisposition("attachment; filename=\"a.md\"; filename*=UTF-8''%E2%98")).toBe("a.md");
  });

  it("reads an unquoted name and gives up on no name at all", () => {
    expect(filenameFromDisposition("attachment; filename=plan.md")).toBe("plan.md");
    expect(filenameFromDisposition("attachment")).toBeNull();
    expect(filenameFromDisposition(null)).toBeNull();
    expect(filenameFromDisposition("")).toBeNull();
  });
});

describe("leafName", () => {
  it("is the last part of a path", () => {
    expect(leafName("notes/2026/plan.md")).toBe("plan.md");
    expect(leafName("plan.md")).toBe("plan.md");
    expect(leafName("")).toBe("file");
  });
});
