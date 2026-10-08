import { describe, expect, it } from "vitest";
import { canSeePath, privateFolderFor, privateFolderOf } from "./private-uploads";

describe("privateFolderFor", () => {
  it("is a tilde and the user id when the id is a plain token", () => {
    expect(privateFolderFor("user-123_a")).toBe("~user-123_a");
  });

  it("hashes an id that is not safe in a path, so two different ids never share a folder", () => {
    const a = privateFolderFor("ana@example.test");
    const b = privateFolderFor("ana@example.tesu");
    expect(a).toMatch(/^~h-[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
    expect(privateFolderFor("../../etc")).toMatch(/^~h-[0-9a-f]{32}$/);
    expect(privateFolderFor("x".repeat(200))).toMatch(/^~h-[0-9a-f]{32}$/);
  });

  it("is stable for one id", () => {
    expect(privateFolderFor("ana@example.test")).toBe(privateFolderFor("ana@example.test"));
  });
});

describe("privateFolderOf", () => {
  it("names the private folder a path sits in, and only under uploads", () => {
    expect(privateFolderOf("uploads/~ana/report.pdf.md")).toBe("~ana");
    expect(privateFolderOf("uploads/~ana/deeper/x.md")).toBe("~ana");
    expect(privateFolderOf("uploads/~ana")).toBe("~ana");
    expect(privateFolderOf("uploads/shared/report.md")).toBeNull();
    expect(privateFolderOf("uploads/report.md")).toBeNull();
    expect(privateFolderOf("notes/~ana/report.md")).toBeNull();
    expect(privateFolderOf("~ana/report.md")).toBeNull();
  });
});

describe("canSeePath", () => {
  const ana = { userId: "ana" };
  const ben = { userId: "ben" };

  it("lets a person see their own folder and nobody else's, on the hosted server", () => {
    expect(canSeePath(ana, "uploads/~ana/a.md", true)).toBe(true);
    expect(canSeePath(ben, "uploads/~ana/a.md", true)).toBe(false);
    expect(canSeePath(ben, "uploads/~ana", true)).toBe(false);
    expect(canSeePath(ana, "uploads/~anna/a.md", true)).toBe(false);
  });

  it("does not guard anything that is not a private folder", () => {
    for (const path of ["uploads/shared.md", "notes/a.md", "uploads/team/a.md", "Uploads/~ana/a.md"]) {
      expect(canSeePath(ben, path, true), path).toBe(true);
    }
  });

  it("refuses every private folder to a caller with no user id, such as a background run", () => {
    expect(canSeePath({}, "uploads/~ana/a.md", true)).toBe(false);
    expect(canSeePath({ userId: "" }, "uploads/~ana/a.md", true)).toBe(false);
    expect(canSeePath({}, "notes/a.md", true)).toBe(true);
  });

  it("guards nothing on a desk, where there is one person", () => {
    expect(canSeePath(ben, "uploads/~ana/a.md", false)).toBe(true);
    expect(canSeePath({}, "uploads/~ana/a.md", false)).toBe(true);
  });

  it("is case sensitive, like the desk's own paths", () => {
    expect(canSeePath({ userId: "Ana" }, "uploads/~ana/a.md", true)).toBe(false);
  });
});
