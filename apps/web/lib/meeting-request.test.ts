/**
 * The two requests the doc-flow Meeting desk adds: a transcript sent as a file, and the owner's edit of
 * one minutes item. Both follow the order SR-45 set for the recording upload: `res.ok` before the body,
 * an error body read with a catch, and a dead network reported rather than thrown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyLocale, resetLocaleForTests } from "./i18n";
import { postMeetingTranscriptFile, putMinutesEdit } from "./meeting-request";
import type { MeetingApiFetch } from "./meeting-upload";

vi.mock("@/lib/api-client", () => ({
  apiFetch: async () => {
    throw new Error("the real api-client must never be reached from these cases");
  },
}));

function answer(status: number, body: unknown, badJson = false): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (badJson) {
        throw new SyntaxError("Unexpected token <");
      }
      return body;
    },
  } as Response;
}

beforeEach(() => applyLocale("en"));
afterEach(() => resetLocaleForTests());

describe("postMeetingTranscriptFile", () => {
  const transcript = new File(["Rina: we ship on Friday."], "weekly.txt", { type: "text/plain" });

  it("posts the file under the field the host reads, to the meeting's own route", async () => {
    const fetcher = vi.fn<MeetingApiFetch>(async () => answer(200, { id: "m1", title: "weekly" }));
    const outcome = await postMeetingTranscriptFile("m1", transcript, fetcher);
    expect(outcome).toEqual({ ok: true, meeting: { id: "m1", title: "weekly" } });
    const [path, init] = fetcher.mock.calls[0] ?? [];
    expect(path).toBe("/api/v1/meetings/m1/transcript/file");
    expect(init?.method).toBe("POST");
    const form = init?.body as FormData;
    expect(form.get("file")).toBeInstanceOf(File);
    expect((form.get("file") as File).name).toBe("weekly.txt");
  });

  it("says what the host said when it refuses the file", async () => {
    const fetcher: MeetingApiFetch = async () =>
      answer(400, { error: { code: "needs_ocr", message: "That PDF is a scan; paste its text instead." } });
    expect(await postMeetingTranscriptFile("m1", transcript, fetcher)).toEqual({
      ok: false,
      message: "That PDF is a scan; paste its text instead.",
    });
  });

  it("falls back to the catalog sentence on an error page that is not JSON", async () => {
    const fetcher: MeetingApiFetch = async () => answer(502, null, true);
    expect(await postMeetingTranscriptFile("m1", transcript, fetcher)).toEqual({
      ok: false,
      message: "Could not read that transcript file.",
    });
  });

  it("reports a dead network instead of throwing", async () => {
    const fetcher: MeetingApiFetch = async () => {
      throw new Error("offline");
    };
    expect(await postMeetingTranscriptFile("m1", transcript, fetcher)).toEqual({ ok: false, message: "offline" });
  });

  it("counts a 2xx the host could not serialise as stored", async () => {
    const fetcher: MeetingApiFetch = async () => answer(200, null, true);
    expect(await postMeetingTranscriptFile("m1", transcript, fetcher)).toEqual({ ok: true, meeting: null });
  });
});

describe("putMinutesEdit", () => {
  const edit = { kind: "action", index: 1, set: { owner: "Rina" } } as const;

  it("PUTs the edit as JSON to the meeting's edits route and returns the meeting it answers", async () => {
    const fetcher = vi.fn<MeetingApiFetch>(async () => answer(200, { id: "m1", title: "weekly" }));
    const outcome = await putMinutesEdit("m1", edit, fetcher);
    expect(outcome).toEqual({ ok: true, meeting: { id: "m1", title: "weekly" } });
    const [path, init] = fetcher.mock.calls[0] ?? [];
    expect(path).toBe("/api/v1/meetings/m1/minutes/edits");
    expect(init?.method).toBe("PUT");
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual(edit);
  });

  it("keeps the host's own sentence when it refuses", async () => {
    const fetcher: MeetingApiFetch = async () =>
      answer(404, { error: { code: "not_found", message: "That item is not in the minutes any more." } });
    expect(await putMinutesEdit("m1", edit, fetcher)).toEqual({
      ok: false,
      message: "That item is not in the minutes any more.",
    });
  });

  it("falls back to the catalog sentence, in the desk language", async () => {
    applyLocale("id");
    const fetcher: MeetingApiFetch = async () => answer(500, null, true);
    const outcome = await putMinutesEdit("m1", edit, fetcher);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.message).toBe("Perubahan itu gagal disimpan.");
  });
});
