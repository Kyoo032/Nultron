/**
 * SR-138 in the renderer: the host refuses a run over the hosted caps with 429 `too_many_runs` or
 * 503 `server_busy`, and the person reads a sentence in their own language, never the host's English.
 *
 * The sentence is put in at the one place every answer passes through, `apiFetch`, so every studio
 * that reads `error.message` off a refused request (Chat, Documents, Images, Videos, Music, Finance,
 * Market, Edit, the job reader) shows it without each growing its own lookup, and a studio added next
 * month gets it too. This file holds the catalog copy, the pure lookup, and that boundary on both
 * transports (`fetch` on the web, IPC in the packaged app).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import enCommon from "../locales/en/common.json";
import idCommon from "../locales/id/common.json";
import { apiFetch } from "./api-client";
import { applyLocale, resetLocaleForTests } from "./i18n";
import { errorFromJson } from "./job-stream";
import { localizeRunLimitBody, runLimitMessage, SERVER_BUSY, TOO_MANY_RUNS } from "./run-limit-copy";

const CASES = [
  { code: TOO_MANY_RUNS, status: 429, key: "tooManyRuns" },
  { code: SERVER_BUSY, status: 503, key: "serverBusy" },
] as const;

const HOST_ENGLISH = "Your account already has 6 runs in progress. Wait for one to finish, then try again.";

afterEach(() => {
  resetLocaleForTests();
  vi.unstubAllGlobals();
  (globalThis as { window?: unknown }).window = undefined;
});

function stubFetchAnswering(status: number, body: unknown, contentType = "application/json"): void {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "Content-Type": contentType },
      }),
  );
}

describe("the catalog copy for the run limits", () => {
  it("names the two host reason codes the host actually sends", () => {
    expect(TOO_MANY_RUNS).toBe("too_many_runs");
    expect(SERVER_BUSY).toBe("server_busy");
  });

  it.each(CASES)("has a real sentence for $code in English and in Indonesian", ({ key }) => {
    const en = enCommon.runLimit[key];
    const id = idCommon.runLimit[key];
    expect(en.length).toBeGreaterThan(10);
    expect(id.length).toBeGreaterThan(10);
    expect(id, "the Indonesian copy is a translation, not the English text again").not.toBe(en);
    // A sentence, not a template: nothing in it waits for a value nobody passes.
    expect(en).not.toMatch(/\{[^}]*\}/);
    expect(id).not.toMatch(/\{[^}]*\}/);
  });

  it("does not tell the person the server is broken, and does not hand them a code", () => {
    for (const text of [...Object.values(enCommon.runLimit), ...Object.values(idCommon.runLimit)]) {
      expect(text).not.toMatch(/429|503|too_many|server_busy|error/i);
    }
  });
});

describe("runLimitMessage", () => {
  it.each(CASES)("reads $code as the catalog sentence in the desk's language", ({ code, key }) => {
    expect(runLimitMessage(code)).toBe(enCommon.runLimit[key]);
    applyLocale("id");
    expect(runLimitMessage(code)).toBe(idCommon.runLimit[key]);
  });

  it("says nothing for any other code, or for something that is not a code", () => {
    for (const other of [
      "too_many_jobs",
      "rate_limited",
      "gateway_blocked",
      "",
      "TOO_MANY_RUNS",
      429,
      null,
      undefined,
      {},
    ]) {
      expect(runLimitMessage(other), String(other)).toBeNull();
    }
  });
});

describe("localizeRunLimitBody", () => {
  it.each(CASES)(
    "swaps the host's text for the catalog sentence on a $status $code and keeps the rest",
    ({ code, status, key }) => {
      const body = { error: { code, message: HOST_ENGLISH, suggestModel: "m1" } };
      expect(localizeRunLimitBody(status, body)).toEqual({
        error: { code, message: enCommon.runLimit[key], suggestModel: "m1" },
      });
      expect(body.error.message, "the caller's own body is left alone").toBe(HOST_ENGLISH);
    },
  );

  it("leaves everything else exactly as it was", () => {
    const untouched: Array<[number, unknown]> = [
      [429, { error: { code: "rate_limited", message: "Too many requests." } }],
      [429, { error: { code: "too_many_jobs", message: "Too many sql jobs" } }],
      [503, { error: { code: "plan_unavailable", message: "x" } }],
      [200, { error: { code: TOO_MANY_RUNS, message: "not a refusal" } }],
      [403, { error: { code: SERVER_BUSY, message: "wrong status" } }],
      [429, { error: "too_many_runs" }],
      [429, null],
      [429, "text"],
      [429, []],
    ];
    for (const [status, body] of untouched) {
      expect(localizeRunLimitBody(status, body), JSON.stringify(body)).toBe(body);
    }
  });
});

describe("a refused request through apiFetch on the web", () => {
  it.each(CASES)(
    "hands every caller the catalog sentence for $code, status and code intact",
    async ({ code, status, key }) => {
      stubFetchAnswering(status, { error: { code, message: HOST_ENGLISH } });
      const response = await apiFetch("/api/v1/videos", { method: "POST", body: "{}" });
      expect(response.status).toBe(status);
      expect(response.ok).toBe(false);
      expect(response.headers.get("Content-Type")).toContain("application/json");
      expect(await response.json()).toEqual({ error: { code, message: enCommon.runLimit[key] } });
    },
  );

  it("answers in Indonesian on an Indonesian desk", async () => {
    applyLocale("id");
    stubFetchAnswering(429, { error: { code: TOO_MANY_RUNS, message: HOST_ENGLISH } });
    const response = await apiFetch("/api/v1/documents", { method: "POST", body: "{}" });
    const payload = (await response.json()) as { error: { message: string } };
    expect(payload.error.message).toBe(idCommon.runLimit.tooManyRuns);
  });

  it("is what every studio and the job reader read, so none needs a lookup of its own", async () => {
    stubFetchAnswering(503, { error: { code: SERVER_BUSY, message: "The server is busy right now." } });
    const response = await apiFetch("/api/v1/research/stream", { method: "POST", body: "{}" });
    const error = errorFromJson(await response.json(), response.status);
    expect(error).toMatchObject({ code: SERVER_BUSY, status: 503, message: enCommon.runLimit.serverBusy });
  });

  it("leaves every other refusal, and every success, byte for byte", async () => {
    for (const [status, body] of [
      [429, { error: { code: "rate_limited", message: "Too many requests. Please slow down." } }],
      [503, { error: { code: "internal_error", message: "Something went wrong." } }],
      [200, { ok: true }],
    ] as const) {
      stubFetchAnswering(status, body);
      const response = await apiFetch("/api/v1/images", { method: "POST", body: "{}" });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(body);
    }
  });

  it("does not choke on a refusal that is not JSON", async () => {
    stubFetchAnswering(503, "<html>upstream</html>", "text/html");
    const response = await apiFetch("/api/v1/images", { method: "POST", body: "{}" });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("<html>upstream</html>");
  });
});
