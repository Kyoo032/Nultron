import { describe, expect, it } from "vitest";
import { createFilesApi, type FilesFetch } from "./files-api";

type Call = { url: string; init: RequestInit | undefined };

function stub(status: number, body: unknown) {
  const calls: Call[] = [];
  const fetcher: FilesFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return { calls, api: createFilesApi(fetcher) };
}

describe("the wire", () => {
  it("lists with no query by default and passes dir and glob when given", async () => {
    const { api, calls } = stub(200, {
      items: [{ path: "notes/plan.md", kind: "file", bytes: 12, updatedAt: 5, version: 2 }],
    });
    const out = await api.list();
    expect(calls[0].url).toBe("/api/v1/files");
    expect(out).toEqual({
      ok: true,
      data: [{ path: "notes/plan.md", kind: "file", bytes: 12, updatedAt: 5, version: 2 }],
    });
    await api.list("notes", "*.md");
    expect(calls[1].url).toBe("/api/v1/files?dir=notes&glob=*.md");
  });

  it("puts the path in the query, encoded, never in the route", async () => {
    const { api, calls } = stub(200, { path: "my notes/a&b.md", text: "x", sha256: "h", bytes: 1, version: 3 });
    const out = await api.content("my notes/a&b.md");
    expect(calls[0].url).toBe("/api/v1/files/content?path=my+notes%2Fa%26b.md");
    expect(out).toEqual({ ok: true, data: { path: "my notes/a&b.md", text: "x", sha256: "h", bytes: 1, version: 3 } });
  });

  it("reads the history and one version", async () => {
    const version = {
      version: 1,
      bytes: 4,
      sha256: "h",
      authorKind: "agent",
      authorId: "run-1",
      mode: "research",
      createdAt: 9,
    };
    const history = stub(200, { items: [version] });
    expect(await history.api.versions("a.md")).toEqual({ ok: true, data: [version] });
    expect(history.calls[0].url).toBe("/api/v1/files/versions?path=a.md");
    const one = stub(200, { path: "a.md", text: "old", sha256: "h", bytes: 3, version: 1 });
    await one.api.version("a.md", 1);
    expect(one.calls[0].url).toBe("/api/v1/files/version?path=a.md&version=1");
  });

  it("saves, reverts and deletes with the verbs and bodies the host reads", async () => {
    const saved = { status: "saved", path: "notes/plan.md", version: 4 };
    const save = stub(200, saved);
    expect(await save.api.save("notes/plan.md", "hello")).toEqual({
      ok: true,
      data: { path: "notes/plan.md", version: 4 },
    });
    expect(save.calls[0].url).toBe("/api/v1/files");
    expect(save.calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(save.calls[0].init?.body))).toEqual({ path: "notes/plan.md", content: "hello" });

    const revert = stub(200, saved);
    await revert.api.revert("notes/plan.md", 2);
    expect(revert.calls[0].url).toBe("/api/v1/files/revert");
    expect(revert.calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(revert.calls[0].init?.body))).toEqual({ path: "notes/plan.md", version: 2 });

    const remove = stub(200, saved);
    await remove.api.remove("notes/plan.md");
    expect(remove.calls[0].url).toBe("/api/v1/files?path=notes%2Fplan.md");
    expect(remove.calls[0].init?.method).toBe("DELETE");
  });
});

describe("failures", () => {
  it("keeps the host's code and status", async () => {
    const { api } = stub(404, { error: { code: "not_found", message: "File not found" } });
    expect(await api.content("gone.md")).toEqual({ ok: false, code: "not_found", status: 404 });
    const full = stub(403, { error: { code: "storage_quota_exceeded", message: "full" } });
    expect(await full.api.save("a.md", "x")).toEqual({ ok: false, code: "storage_quota_exceeded", status: 403 });
  });

  it("reports a dead network as network and a body it cannot read as bad_response", async () => {
    const down = createFilesApi(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await down.list()).toEqual({ ok: false, code: "network", status: 0 });
    expect(await stub(200, { nope: true }).api.list()).toEqual({ ok: false, code: "bad_response", status: 200 });
    expect(await stub(200, { items: [{ path: 3 }] }).api.list()).toEqual({
      ok: false,
      code: "bad_response",
      status: 200,
    });
    expect(
      await stub(200, { status: "pending_approval", path: "a.md", proposalId: "p" }).api.save("a.md", "x"),
    ).toEqual({
      ok: false,
      code: "bad_response",
      status: 200,
    });
  });

  it("falls back to a generic code for an error body in another shape", async () => {
    const html = createFilesApi(async () => new Response("<html>502</html>", { status: 502 }));
    expect(await html.list()).toEqual({ ok: false, code: "error", status: 502 });
  });
});
