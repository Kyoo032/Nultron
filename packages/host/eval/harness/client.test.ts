import { describe, expect, it } from "vitest";
import { createHttp, describeError, errorText, requireLoopbackBase } from "./client";
import { fakeHost, json, sse } from "./fake-host";

const BASE = "http://127.0.0.1:3000";

describe("requireLoopbackBase", () => {
  it("accepts the loopback names and returns the origin", () => {
    expect(requireLoopbackBase("http://127.0.0.1:3000/anything")).toBe("http://127.0.0.1:3000");
    expect(requireLoopbackBase("http://localhost:4000")).toBe("http://localhost:4000");
    expect(requireLoopbackBase("http://[::1]:3000")).toBe("http://[::1]:3000");
  });

  it("refuses anything else, and anything that is not http", () => {
    expect(() => requireLoopbackBase("http://192.168.1.5:3000")).toThrow("got 192.168.1.5");
    expect(() => requireLoopbackBase("https://app.example.com")).toThrow("--base must be loopback");
    expect(() => requireLoopbackBase("ftp://127.0.0.1")).toThrow("--base must be http or https");
    expect(() => requireLoopbackBase("nonsense")).toThrow("--base must be a URL");
  });
});

describe("errorText", () => {
  it("reads the envelope and the flat gateway-gate body", () => {
    expect(errorText({ error: { code: "invalid_request", message: "prompt is required" } }, 400)).toBe(
      "HTTP 400 invalid_request: prompt is required",
    );
    expect(errorText({ error: "gateway_blocked", status: "needs_key", message: "Add a key." }, 403)).toBe(
      "HTTP 403 gateway_blocked: Add a key.",
    );
    expect(errorText(null, 502)).toBe("HTTP 502");
  });
});

describe("describeError", () => {
  it("names a timeout as one", () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    expect(describeError(timeout, 5000)).toBe("timed out after 5000 ms");
    expect(describeError(new Error("fetch failed"))).toBe("fetch failed");
  });
});

describe("createHttp", () => {
  it("stamps mutating calls with the base origin and leaves reads alone", async () => {
    const { fetch, seen } = fakeHost({
      "GET /api/v1/ping": json({ ok: true }),
      "POST /api/v1/x": json({ ok: true }, 201),
    });
    const http = createHttp({ base: BASE, fetch });
    await http.get("/api/v1/ping");
    const posted = await http.postJson("/api/v1/x", { a: 1 });
    expect(posted).toEqual({ status: 201, body: { ok: true } });
    expect(seen[0]?.headers.get("origin")).toBeNull();
    expect(seen[1]?.headers.get("origin")).toBe(BASE);
    expect(seen[1]?.headers.get("content-type")).toBe("application/json");
    expect(seen[1]?.body).toEqual({ a: 1 });
  });

  it("reads a stream split mid-frame into events", async () => {
    const events = [
      { type: "run.started", runId: "r1" },
      { type: "assistant.delta", text: "héllo" },
      { type: "run.completed", runId: "r1" },
    ];
    const { fetch } = fakeHost({ "POST /s": () => sse(events, { splitAt: 61 }) });
    const result = await createHttp({ base: BASE, fetch }).stream("/s", {}, 5000);
    expect(result.status).toBe(200);
    expect(result.events).toEqual(events);
    expect(result.malformed).toBe(0);
    expect(result.streamError).toBeNull();
  });

  it("counts a frame that is not JSON and keeps the rest", async () => {
    const { fetch } = fakeHost({
      "POST /b": () =>
        new Response('event: x\ndata: {nope\n\nevent: y\ndata: {"type":"y"}\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });
    const result = await createHttp({ base: BASE, fetch }).stream("/b", {}, 5000);
    expect(result.events).toEqual([{ type: "y" }]);
    expect(result.malformed).toBe(1);
  });

  it("hands back the JSON of a refused stream instead of events", async () => {
    const { fetch } = fakeHost({
      "POST /s": () => json({ error: "gateway_blocked", status: "needs_key", message: "Add a key." }, 403),
    });
    const result = await createHttp({ base: BASE, fetch }).stream("/s", {}, 5000);
    expect(result.status).toBe(403);
    expect(result.events).toEqual([]);
    expect(errorText(result.body, result.status)).toBe("HTTP 403 gateway_blocked: Add a key.");
  });

  it("refuses to be built for a host that is not loopback", () => {
    expect(() => createHttp({ base: "https://example.com", fetch: globalThis.fetch })).toThrow(
      "--base must be loopback",
    );
  });
});
