import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "./api-client";
import { DocsError, deleteDocSection, postDocSection, putDocSection } from "./docs-client";

vi.mock("./api-client", () => ({ apiFetch: vi.fn() }));

const apiFetchMock = vi.mocked(apiFetch);

const ANSWER = {
  headVersion: 7,
  version: {
    version: 7,
    kind: "document",
    changedSectionIds: ["s1"],
    baseVersion: 6,
    note: null,
    author: { kind: "person", userId: "user_me" },
    createdAt: 1,
  },
  sectionAuthors: { s1: { version: 7, author: { kind: "person", userId: "user_me" } } },
  bodyRefreshed: true,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function sentTo(index: number): { path: string; method: string; body: unknown } {
  const call = apiFetchMock.mock.calls[index];
  if (!call) {
    throw new Error(`no request ${index}`);
  }
  const [path, init] = call;
  return {
    path,
    method: init?.method ?? "",
    body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
  };
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe("section writes", () => {
  it("PUTs one section with the base version and reads back the answer", async () => {
    apiFetchMock.mockResolvedValueOnce(json(200, ANSWER));
    const section = { heading: "Mine", blocks: [{ type: "paragraph" as const, text: "text" }] };
    const answer = await putDocSection("art_1", "s 1", { baseVersion: 6, section });
    expect(sentTo(0)).toEqual({
      path: "/api/v1/docs/art_1/sections/s%201",
      method: "PUT",
      body: { baseVersion: 6, section: { heading: "Mine", blocks: [{ type: "paragraph", text: "text" }] } },
    });
    expect(answer.headVersion).toBe(7);
    expect(answer.version?.version).toBe(7);
    expect(answer.sectionAuthors.s1?.version).toBe(7);
  });

  it("POSTs a new section after the named one and leaves the id to the host", async () => {
    apiFetchMock.mockResolvedValueOnce(json(201, ANSWER));
    await postDocSection("art_1", { baseVersion: 6, afterSectionId: "s2", section: { blocks: [] } });
    expect(sentTo(0)).toEqual({
      path: "/api/v1/docs/art_1/sections",
      method: "POST",
      body: { baseVersion: 6, afterSectionId: "s2", section: { blocks: [] } },
    });
  });

  it("POSTs without afterSectionId when none is given", async () => {
    apiFetchMock.mockResolvedValueOnce(json(201, ANSWER));
    await postDocSection("art_1", { baseVersion: 6, section: { blocks: [] } });
    expect(sentTo(0).body).toEqual({ baseVersion: 6, section: { blocks: [] } });
  });

  it("DELETEs a section with the base version in the body", async () => {
    apiFetchMock.mockResolvedValueOnce(json(200, ANSWER));
    await deleteDocSection("art_1", "s1", { baseVersion: 6 });
    expect(sentTo(0)).toEqual({
      path: "/api/v1/docs/art_1/sections/s1",
      method: "DELETE",
      body: { baseVersion: 6 },
    });
  });

  it("turns a 409 section_changed envelope into a DocsError with its code", async () => {
    apiFetchMock.mockResolvedValueOnce(
      json(409, { error: { code: "section_changed", message: "changed", sectionIds: ["s1"] } }),
    );
    const error = await putDocSection("art_1", "s1", { baseVersion: 6, section: { blocks: [] } }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(DocsError);
    expect(error).toMatchObject({ code: "section_changed", status: 409 });
  });

  it("turns a 403 storage_quota_exceeded envelope into a DocsError with its code", async () => {
    apiFetchMock.mockResolvedValueOnce(json(403, { error: { code: "storage_quota_exceeded", message: "full" } }));
    const error = await postDocSection("art_1", { baseVersion: 6, section: { blocks: [] } }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "storage_quota_exceeded", status: 403 });
  });

  it("refuses an answer that does not have the write shape", async () => {
    apiFetchMock.mockResolvedValueOnce(json(200, { headVersion: "seven" }));
    const error = await deleteDocSection("art_1", "s1", { baseVersion: 6 }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "docs_malformed", status: 502 });
  });
});
