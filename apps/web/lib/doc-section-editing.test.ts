import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DocsError, parseDocPage, type DocChange, type DocPage, type DocSectionInput } from "@/lib/docs-client";
import { createSectionStore, newSectionIds, noticeKeyFor, type SectionTransport } from "@/lib/doc-section-editing";

const here = dirname(fileURLToPath(import.meta.url));

const WRITE: DocChange = { headVersion: 6, version: null, sectionAuthors: {}, bodyRefreshed: true };

function pageWith(headVersion: number, sections: readonly { id: string; heading?: string; text: string }[]): DocPage {
  return parseDocPage({
    artifactId: "art_1",
    title: "Memo",
    kind: "document",
    headVersion,
    spec: {
      kind: "document",
      title: "Memo",
      theme: "plain",
      titlePage: false,
      sections: sections.map((section) => ({
        id: section.id,
        heading: section.heading ?? null,
        blocks: [{ type: "paragraph", text: section.text }],
      })),
    },
    sectionAuthors: {},
    proposals: [],
  });
}

function fakeTransport(page: DocPage) {
  const put = vi.fn<(sectionId: string, baseVersion: number, section: DocSectionInput) => Promise<DocChange>>(
    async () => WRITE,
  );
  const post = vi.fn<(baseVersion: number, afterSectionId: string | undefined) => Promise<DocChange>>(
    async () => WRITE,
  );
  const remove = vi.fn<(sectionId: string, baseVersion: number) => Promise<DocChange>>(async () => WRITE);
  const fetchPage = vi.fn<() => Promise<DocPage>>(async () => page);
  const applyWrite = vi.fn<(write: DocChange) => void>();
  const transport: SectionTransport = { put, post, remove, fetchPage, applyWrite };
  return { transport, put, post, remove, fetchPage, applyWrite };
}

const DRAFT: DocSectionInput = { heading: "Mine", blocks: [{ type: "paragraph", text: "my text" }] };

describe("editing a section", () => {
  it("saves at the head it saw, applies the answer and closes the editor", async () => {
    const { transport, put, fetchPage, applyWrite } = fakeTransport(pageWith(6, [{ id: "s1", text: "old" }]));
    const store = createSectionStore(transport);
    store.actions.open("s1");
    await store.actions.save("s1", DRAFT, 5);
    expect(put).toHaveBeenCalledWith("s1", 5, DRAFT);
    expect(applyWrite).toHaveBeenCalledWith(WRITE);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(store.getState()).toEqual({ openId: null, confirmingId: null, busy: false, notice: null });
  });

  it("keeps the draft open and shows the conflict on a 409", async () => {
    const { transport, put, applyWrite } = fakeTransport(pageWith(5, [{ id: "s1", text: "old" }]));
    put.mockRejectedValueOnce(new DocsError("section_changed", "changed", 409));
    const store = createSectionStore(transport);
    store.actions.open("s1");
    await store.actions.save("s1", DRAFT, 5);
    expect(store.getState()).toMatchObject({
      openId: "s1",
      busy: false,
      notice: { sectionId: "s1", code: "section_changed" },
    });
    expect(applyWrite).not.toHaveBeenCalled();
  });

  it("keep re-fetches the page and re-sends the draft against the new head", async () => {
    const fresh = pageWith(7, [{ id: "s1", text: "their text" }]);
    const { transport, put, fetchPage, applyWrite } = fakeTransport(fresh);
    put.mockRejectedValueOnce(new DocsError("section_changed", "changed", 409));
    const store = createSectionStore(transport);
    store.actions.open("s1");
    await store.actions.save("s1", DRAFT, 5);

    const rebuilt: DocSectionInput = { heading: "Mine", blocks: [{ type: "paragraph", text: "my text, again" }] };
    const seen: string[] = [];
    await store.actions.keep("s1", (section) => {
      seen.push(section.blocks.map((block) => (block.type === "paragraph" ? block.text : "")).join(""));
      return rebuilt;
    });

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(["their text"]);
    expect(put.mock.calls).toEqual([
      ["s1", 5, DRAFT],
      ["s1", 7, rebuilt],
    ]);
    expect(applyWrite).toHaveBeenCalledWith(WRITE);
    expect(store.getState()).toMatchObject({ openId: null, busy: false, notice: null });
  });

  it("closes the editor without writing when the reader takes their version", async () => {
    const { transport, put, fetchPage } = fakeTransport(pageWith(6, [{ id: "s1", text: "theirs" }]));
    const store = createSectionStore(transport);
    store.actions.open("s1");
    await store.actions.reload();
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(put).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ openId: null, busy: false });
  });

  it("closes the editor and says so when the section is gone on keep", async () => {
    const gone = pageWith(7, [{ id: "s2", text: "other" }]);
    const { transport, put } = fakeTransport(gone);
    put.mockRejectedValueOnce(new DocsError("section_changed", "changed", 409));
    const store = createSectionStore(transport);
    store.actions.open("s1");
    await store.actions.save("s1", DRAFT, 5);
    await store.actions.keep("s1", () => DRAFT);
    expect(put).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({ openId: null, notice: { sectionId: null, code: "section_not_found" } });
  });

  it("reports a storage refusal against the section being saved", async () => {
    const { transport, put, applyWrite } = fakeTransport(pageWith(5, [{ id: "s1", text: "old" }]));
    put.mockRejectedValueOnce(new DocsError("storage_quota_exceeded", "full", 403));
    const store = createSectionStore(transport);
    store.actions.open("s1");
    await store.actions.save("s1", DRAFT, 5);
    expect(store.getState()).toMatchObject({
      openId: "s1",
      notice: { sectionId: "s1", code: "storage_quota_exceeded" },
    });
    expect(applyWrite).not.toHaveBeenCalled();
  });

  it("ignores a second save while one is in flight", async () => {
    const { transport, put } = fakeTransport(pageWith(5, [{ id: "s1", text: "old" }]));
    let release: () => void = () => undefined;
    put.mockImplementationOnce(
      () =>
        new Promise<DocChange>((resolveWrite) => {
          release = () => resolveWrite(WRITE);
        }),
    );
    const store = createSectionStore(transport);
    store.actions.open("s1");
    const first = store.actions.save("s1", DRAFT, 5);
    expect(store.getState().busy).toBe(true);
    await store.actions.save("s1", DRAFT, 5);
    release();
    await first;
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("says the saved change could not be refreshed when the re-fetch fails", async () => {
    const { transport, fetchPage } = fakeTransport(pageWith(5, [{ id: "s1", text: "old" }]));
    fetchPage.mockRejectedValueOnce(new Error("offline"));
    const store = createSectionStore(transport);
    store.actions.open("s1");
    await store.actions.save("s1", DRAFT, 5);
    expect(store.getState()).toMatchObject({ openId: null, notice: { sectionId: null, code: "refresh_failed" } });
  });
});

describe("adding a section", () => {
  it("opens the new section, found by diffing the ids", async () => {
    const after = pageWith(7, [
      { id: "s1", text: "a" },
      { id: "s2", text: "b" },
      { id: "s9", text: "" },
    ]);
    const { transport, post, applyWrite } = fakeTransport(after);
    const store = createSectionStore(transport);
    await store.actions.add("s2", 6, ["s1", "s2"]);
    expect(post).toHaveBeenCalledWith(6, "s2");
    expect(applyWrite).toHaveBeenCalledWith(WRITE);
    expect(store.getState()).toMatchObject({ openId: "s9", busy: false, notice: null });
  });

  it("shows a failed add outside any section", async () => {
    const { transport, post, fetchPage } = fakeTransport(pageWith(6, [{ id: "s1", text: "a" }]));
    post.mockRejectedValueOnce(new DocsError("not_editable", "no", 409));
    const store = createSectionStore(transport);
    await store.actions.add(undefined, 6, ["s1"]);
    expect(fetchPage).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ openId: null, notice: { sectionId: null, code: "not_editable" } });
  });
});

describe("deleting a section", () => {
  it("asks first, then sends the head it saw, and clears the editor on that section", async () => {
    const { transport, remove } = fakeTransport(pageWith(6, [{ id: "s1", text: "a" }]));
    const store = createSectionStore(transport);
    store.actions.open("s2");
    store.actions.askRemove("s2");
    expect(remove).not.toHaveBeenCalled();
    expect(store.getState().confirmingId).toBe("s2");
    await store.actions.remove("s2", 5);
    expect(remove).toHaveBeenCalledWith("s2", 5);
    expect(store.getState()).toMatchObject({ confirmingId: null, openId: null, busy: false, notice: null });
  });

  it("shows last_section against the section it refused", async () => {
    const { transport, remove, applyWrite } = fakeTransport(pageWith(6, [{ id: "s1", text: "a" }]));
    remove.mockRejectedValueOnce(new DocsError("last_section", "one left", 409));
    const store = createSectionStore(transport);
    store.actions.askRemove("s1");
    await store.actions.remove("s1", 6);
    expect(applyWrite).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ confirmingId: null, notice: { sectionId: "s1", code: "last_section" } });
  });
});

describe("notices and ids", () => {
  it("maps each refusal to its catalog key, and anything else to the generic one", () => {
    expect(noticeKeyFor("section_changed")).toBe("docpage.edit.conflict");
    expect(noticeKeyFor("storage_quota_exceeded")).toBe("docpage.edit.quota");
    expect(noticeKeyFor("last_section")).toBe("docpage.edit.lastSection");
    expect(noticeKeyFor("section_not_found")).toBe("docpage.edit.sectionGone");
    expect(noticeKeyFor("refresh_failed")).toBe("docpage.edit.refreshFailed");
    expect(noticeKeyFor("docs_error")).toBe("docpage.edit.failed");
  });

  it("finds the ids that are new after a write", () => {
    expect(newSectionIds(["s1", "s2"], ["s1", "s9", "s2"])).toEqual(["s9"]);
    expect(newSectionIds(["s1"], ["s1"])).toEqual([]);
  });

  it("names no Nultron in the controller source", () => {
    const source = readFileSync(resolve(here, "doc-section-editing.ts"), "utf8");
    expect(source.toLowerCase()).not.toContain("nultron");
  });
});
