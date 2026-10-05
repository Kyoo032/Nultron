import { describe, expect, it } from "vitest";
import { cleanUp, createTracker, findNewArtifacts, findStrayArtifacts, pickNewArtifacts } from "./cleanup";
import { createHttp } from "./client";
import { fakeHost, json } from "./fake-host";

const BASE = "http://127.0.0.1:3000";
const LIST = {
  items: [
    { id: "old", mode: "documents", meta: { question: "Write a note." } },
    { id: "new-doc", mode: "documents", meta: { question: "Write a note." } },
    { id: "other-doc", mode: "documents", meta: { question: "A neighbour asked this." } },
    { id: "new-deck", mode: "presentations", meta: { question: "Write a note." } },
  ],
};

describe("pickNewArtifacts", () => {
  it("takes only what is new, in the mode, with this run's question", () => {
    expect(pickNewArtifacts(LIST, new Set(["old"]), "documents", "Write a note.")).toEqual(["new-doc"]);
  });

  it("reads a body that is not a list as empty", () => {
    expect(pickNewArtifacts(null, new Set(), "documents", "q")).toEqual([]);
    expect(pickNewArtifacts({ items: "x" }, new Set(), "documents", "q")).toEqual([]);
  });
});

describe("createTracker", () => {
  it("keeps each id once and hands out copies", () => {
    const tracker = createTracker();
    tracker.thread("t1");
    tracker.thread("t1");
    tracker.dataset("d1");
    tracker.artifact("a1");
    const snapshot = tracker.snapshot();
    snapshot.threads.push("injected");
    expect(tracker.snapshot()).toEqual({ threads: ["t1"], datasets: ["d1"], artifacts: ["a1"] });
  });
});

describe("findNewArtifacts and findStrayArtifacts", () => {
  it("asks for the mode's list and filters it", async () => {
    const { fetch } = fakeHost({ "GET /api/v1/artifacts?mode=documents": json(LIST) });
    const http = createHttp({ base: BASE, fetch });
    expect(await findNewArtifacts(http, new Set(["old"]), "documents", "Write a note.")).toEqual(["new-doc"]);
  });

  it("finds a late artifact by any question the run asked, in any mode", async () => {
    const { fetch } = fakeHost({ "GET /api/v1/artifacts": json(LIST) });
    const http = createHttp({ base: BASE, fetch });
    expect(await findStrayArtifacts(http, new Set(["old", "new-doc"]), new Set(["Write a note."]))).toEqual([
      "new-deck",
    ]);
  });
});

describe("cleanUp", () => {
  it("deletes what the run made and proves each is gone with a 404", async () => {
    const gone = new Set<string>();
    const del = (path: string) => () => {
      gone.add(path);
      return json({ ok: true });
    };
    const get = (path: string) => () => (gone.has(path) ? json({ error: { code: "not_found" } }, 404) : json({}));
    const { fetch, seen } = fakeHost({
      "DELETE /api/v1/threads/t1": del("/api/v1/threads/t1"),
      "GET /api/v1/threads/t1": get("/api/v1/threads/t1"),
      "DELETE /api/v1/datasets/d1": del("/api/v1/datasets/d1"),
      "GET /api/v1/datasets/d1": get("/api/v1/datasets/d1"),
      "DELETE /api/v1/artifacts/a1": del("/api/v1/artifacts/a1"),
      "GET /api/v1/artifacts/a1": get("/api/v1/artifacts/a1"),
    });
    const http = createHttp({ base: BASE, fetch });
    const record = await cleanUp(http, { threads: ["t1"], datasets: ["d1"], artifacts: ["a1"] });
    expect(record).toEqual({ threads: ["t1"], datasets: ["d1"], artifacts: ["a1"], failed: [], verifiedGone: true });
    expect(seen.filter((request) => request.method === "DELETE").map((request) => request.path)).toEqual([
      "/api/v1/threads/t1",
      "/api/v1/datasets/d1",
      "/api/v1/artifacts/a1",
    ]);
  });

  it("records a delete the host refused and does not claim it is gone", async () => {
    const { fetch } = fakeHost({
      "DELETE /api/v1/threads/t1": json({ error: { code: "internal_error", message: "disk" } }, 500),
    });
    const http = createHttp({ base: BASE, fetch });
    const record = await cleanUp(http, { threads: ["t1"], datasets: [], artifacts: [] });
    expect(record.failed).toEqual(["thread t1: HTTP 500 internal_error: disk"]);
    expect(record.threads).toEqual([]);
    expect(record.verifiedGone).toBe(false);
  });

  it("treats an id the host no longer knows as already gone", async () => {
    const { fetch } = fakeHost({});
    const http = createHttp({ base: BASE, fetch });
    const record = await cleanUp(http, { threads: ["t9"], datasets: [], artifacts: [] });
    expect(record).toEqual({ threads: ["t9"], datasets: [], artifacts: [], failed: [], verifiedGone: true });
  });
});
