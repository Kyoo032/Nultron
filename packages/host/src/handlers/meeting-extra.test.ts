/**
 * Meeting mode — the doc-flow routes: a transcript file, translating the stored minutes, and the owner's
 * edit of one item. The runtime is the stub, so nothing here reaches the gateway; what it proves is the
 * route contract: what is read, saved, refused, and in which order the lookup and the gate come.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROUTER_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";
import type { HostFile, HostRequest, HostResult } from "../types";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-meeting-extra-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_RUNTIME = "stub";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;

type RouterModule = typeof import("../router");
type ExtraModule = typeof import("./meeting-extra");
let router: RouterModule;
let extra: ExtraModule;
let tenantOf: (request: HostRequest) => Promise<import("@agentforge/core").TenantContext>;
let storeOf: () => import("../meeting/store").MeetingStore;

function request(method: string, path: string, more: Partial<HostRequest> = {}): HostRequest {
  return { method, path, query: {}, params: {}, headers: {}, ...more };
}

/** What the tests read of a meeting, or of the host error envelope. */
type Reply = {
  id: string;
  status: string;
  transcript: { text: string; source: string; model: string; segments: unknown[] } | null;
  transcriptArtifactId: string;
  minutes: { minutes: { decisions: Array<Record<string, unknown>> } } | null;
  error?: { code: string; message: string };
};

async function json(method: string, path: string, more: Partial<HostRequest> = {}) {
  const result = await router.dispatch(request(method, path, more));
  if (result.type !== "json") {
    throw new Error(`${method} ${path}: expected json, got ${result.type}`);
  }
  return { status: result.status, body: result.body as Reply };
}

async function streamEvents(result: HostResult): Promise<Array<Record<string, unknown>>> {
  if (result.type !== "stream") {
    throw new Error(`expected stream, got ${result.type}`);
  }
  const events: Array<Record<string, unknown>> = [];
  for await (const chunk of result.events) {
    events.push(JSON.parse(chunk.split("data: ")[1] ?? "{}") as Record<string, unknown>);
  }
  return events;
}

function upload(filename: string, text: string | Uint8Array, mime = "text/plain"): HostFile {
  return { field: "file", filename, mime, bytes: typeof text === "string" ? new TextEncoder().encode(text) : text };
}

async function newMeeting(): Promise<string> {
  const created = await json("POST", "/api/v1/meetings", { body: { title: "Checkout weekly", locale: "en" } });
  expect(created.status).toBe(201);
  return created.body.id;
}

beforeAll(async () => {
  router = await import("../router");
  extra = await import("./meeting-extra");
  ({ getTenant: tenantOf } = await import("../tenant"));
  storeOf = (await import("../meeting/store")).meetingStore;
}, ROUTER_IMPORT_BUDGET_MS);

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("POST /meetings/:id/transcript/file", () => {
  it("saves a text file as the transcript, the way a pasted one is", async () => {
    const id = await newMeeting();
    const result = await json("POST", `/api/v1/meetings/${id}/transcript/file`, {
      files: [upload("talk.txt", "Dewi: we ship the checkout fix on Friday.\nBudi: I will update the runbook.")],
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      status: "transcribed",
      transcript: { source: "pasted", model: "", segments: [] },
    });
    expect(result.body.transcript?.text).toContain("Budi: I will update the runbook.");
    expect(result.body.transcriptArtifactId).not.toBe("");
    const read = await json("GET", `/api/v1/meetings/${id}`);
    expect(read.body.transcript?.text).toBe(result.body.transcript?.text);
  });

  it("keeps the timings of a caption file", async () => {
    const id = await newMeeting();
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Dewi>We ship on Friday.</v>\n";
    const result = await json("POST", `/api/v1/meetings/${id}/transcript/file`, {
      files: [upload("zoom.vtt", vtt, "text/vtt")],
    });
    expect(result.status).toBe(200);
    expect(result.body.transcript?.text).toBe("Dewi: We ship on Friday.");
    expect(result.body.transcript?.segments).toEqual([
      { startSeconds: 1, speaker: "Dewi", text: "We ship on Friday." },
    ]);
  });

  it("takes the first file when none is named file, and refuses a request with no file", async () => {
    const id = await newMeeting();
    const odd: HostFile = { ...upload("talk.md", "Dewi: ship it on Friday, please."), field: "transcript" };
    expect((await json("POST", `/api/v1/meetings/${id}/transcript/file`, { files: [odd] })).status).toBe(200);
    const none = await json("POST", `/api/v1/meetings/${id}/transcript/file`, { files: [] });
    expect(none.status).toBe(400);
    expect(none.body.error?.message).toContain("Attach one transcript file");
  });

  it("refuses a file that is not a transcript, an empty one and one with no text, each in a sentence", async () => {
    const id = await newMeeting();
    const mp3 = await json("POST", `/api/v1/meetings/${id}/transcript/file`, {
      files: [upload("talk.mp3", new Uint8Array([1, 2, 3]), "audio/mpeg")],
    });
    expect(mp3.status).toBe(400);
    expect(mp3.body.error?.code).toBe("unsupported_content_type");
    const empty = await json("POST", `/api/v1/meetings/${id}/transcript/file`, { files: [upload("talk.txt", "")] });
    expect(empty.body.error?.message).toBe("That file is empty.");
    const blank = await json("POST", `/api/v1/meetings/${id}/transcript/file`, {
      files: [upload("talk.txt", "  \n ")],
    });
    expect(blank.body.error?.message).toBe("No text could be read from that file.");
    expect((await json("GET", `/api/v1/meetings/${id}`)).body.transcript).toBeNull();
  });

  it("is free: it never asks the gateway gate, so it works with no key at all", async () => {
    const id = await newMeeting();
    delete process.env.AGENTFORGE_RUNTIME;
    try {
      const result = await json("POST", `/api/v1/meetings/${id}/transcript/file`, {
        files: [upload("talk.txt", "Dewi: we ship the checkout fix on Friday.")],
      });
      expect(result.status).toBe(200);
    } finally {
      process.env.AGENTFORGE_RUNTIME = "stub";
    }
  });

  it("is a 404 for a meeting that is not the caller's, before the file is read", async () => {
    const result = await json("POST", `/api/v1/meetings/${crypto.randomUUID()}/transcript/file`, {
      files: [upload("talk.txt", "Dewi: we ship the checkout fix on Friday.")],
    });
    expect(result.status).toBe(404);
    expect(result.body.error?.code).toBe("not_found");
  });
});

describe("POST /meetings/:id/translate/stream", () => {
  it("is refused visibly under the stub runtime, as a job error, not a half-translation", async () => {
    const id = await newMeeting();
    const result = await router.dispatch(request("POST", `/api/v1/meetings/${id}/translate/stream`, { body: {} }));
    const events = await streamEvents(result);
    expect(events[0]).toMatchObject({ type: "job.error", code: "runtime_stub", status: 503 });
  });

  it("is a 404 for a meeting that is not the caller's", async () => {
    const result = await json("POST", `/api/v1/meetings/${crypto.randomUUID()}/translate/stream`, { body: {} });
    expect(result.status).toBe(404);
  });
});

describe("PUT /meetings/:id/minutes/edits (handler)", () => {
  async function minutedMeeting(): Promise<{
    id: string;
    call: (body: unknown, meetingId?: string) => Promise<HostResult>;
  }> {
    const id = await newMeeting();
    const tenant = await tenantOf(request("GET", "/"));
    storeOf().update(tenant, id, {
      status: "minuted",
      transcript: {
        text: "Dewi: we ship the checkout fix on Friday.",
        segments: [],
        language: "",
        source: "pasted",
        model: "",
      },
      minutes: {
        locale: "en",
        minutes: {
          title: "Checkout weekly",
          heldOn: "",
          summary: "The team ships the fix.",
          attendees: [],
          decisions: [
            { statement: "Ship the fix", provisional: false, context: "", quote: "we ship the checkout fix on Friday" },
          ],
          actionItems: [],
          risks: [],
          openQuestions: [],
        },
        artifactId: "",
        model: "",
        unverifiedNames: [],
        checks: null,
      },
    });
    return {
      id,
      call: (body, meetingId = id) =>
        extra.handlePutMeetingMinutesEdit(request("PUT", "/", { params: { meetingId }, body })),
    };
  }

  it("changes one item and answers the meeting as it now is", async () => {
    const { call } = await minutedMeeting();
    const result = await call({
      kind: "decision",
      index: 0,
      set: { statement: "Ship on the 21st", provisional: true },
    });
    expect(result).toMatchObject({ type: "json", status: 200 });
    const body = (result as { body: Reply }).body;
    expect(body.minutes?.minutes.decisions[0]).toMatchObject({
      statement: "Ship on the 21st",
      provisional: true,
      edited: true,
      quote: "we ship the checkout fix on Friday",
    });
  });

  it("refuses an edit that is not one, with the field that is wrong", async () => {
    const { call } = await minutedMeeting();
    for (const body of [
      undefined,
      {},
      { kind: "decision", index: 0, set: {} },
      { kind: "decision", index: 0, set: { quote: "x" } },
    ]) {
      const result = await call(body);
      expect(result, JSON.stringify(body)).toMatchObject({ type: "json", status: 400 });
      expect((result as { body: { error: { code: string } } }).body.error.code).toBe("invalid_request");
    }
  });

  it("is a 404 for an item that is not there and for a meeting that is not the caller's", async () => {
    const { call } = await minutedMeeting();
    expect(await call({ kind: "action", index: 0, set: { task: "x" } })).toMatchObject({ status: 404 });
    expect(await call({ kind: "decision", index: 0, set: { statement: "x" } }, crypto.randomUUID())).toMatchObject({
      status: 404,
    });
  });
});
