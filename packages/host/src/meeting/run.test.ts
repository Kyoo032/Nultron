/**
 * Meeting mode — the run, with ffmpeg, the recogniser and the model stubbed at their module seams.
 *
 * What this proves is what a run keeps when a later step fails: the minutes when the translation
 * fails, the bill for the chunks the gateway answered when a later chunk does not, and no chunk
 * cache left on disk whichever step it was.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type TenantContext } from "@agentforge/core";
import type { MeetingMinutes, MeetingTranscript } from "@agentforge/core/meeting";
import type { ExtractedAudio } from "./audio";

// Isolation: this file's own desk, set BEFORE the run (and through it the database) is imported.
const dataDir = mkdtempSync(join(tmpdir(), "agentforge-meeting-run-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;

const seams = vi.hoisted(() => ({
  extract: vi.fn(),
  transcribe: vi.fn(),
  ask: vi.fn(),
  usage: vi.fn(),
}));

vi.mock("./audio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./audio")>()),
  extractMeetingAudio: seams.extract,
}));
vi.mock("./transcribe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./transcribe")>()),
  resolveMeetingAsr: () => ({
    available: true,
    model: "asr-test",
    wire: "chat_audio",
    candidates: ["asr-test"],
    reason: "ok",
  }),
  transcribeChunks: seams.transcribe,
}));
vi.mock("../job-regen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../job-regen")>()),
  collectJobAssistantRun: seams.ask,
}));
vi.mock("../usage-record", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../usage-record")>()),
  recordTranscriptionUsage: seams.usage,
}));
vi.mock("../knowledge-ingest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../knowledge-ingest")>()),
  upsertWorkSource: async () => ({ status: "skipped", reason: "test" }),
}));

type RunModule = typeof import("./run");
type StoreModule = typeof import("./store");
let run: RunModule;
let store: StoreModule;

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org-meeting-run",
  workspaceId: "ws-meeting-run",
  userId: "local",
  role: "owner",
};

/** Three ten-minute chunks: 25 minutes of audio. */
const DURATION_SECONDS = 1500;

const TRANSCRIPT: MeetingTranscript = {
  text: "Dewi: we ship the checkout fix on Friday.",
  segments: [],
  language: "en",
  source: "pasted",
  model: "",
};

function minutes(title: string): MeetingMinutes {
  return {
    title,
    heldOn: "",
    summary: "The team agreed to ship the checkout fix on Friday.",
    attendees: [],
    decisions: [],
    actionItems: [],
    risks: [],
    openQuestions: [],
  };
}

/** Stands in for ffmpeg: writes three chunks where the run asked, and remembers where that was. */
function extractInto(outDirs: string[], after?: () => void) {
  return async (_source: string, outDir: string): Promise<ExtractedAudio> => {
    outDirs.push(outDir);
    mkdirSync(outDir, { recursive: true });
    const files = [0, 1, 2].map((index) => {
      const file = join(outDir, `chunk-00${index}.mp3`);
      writeFileSync(file, "x");
      return file;
    });
    after?.();
    return { files, durationSeconds: DURATION_SECONDS, offsets: [0, 600, 1200] };
  };
}

type ChunkOptions = { onChunk?: (current: number, total: number) => void };

/** Stands in for the recogniser: announces chunks 1..`failAt` and refuses chunk `failAt`. */
function refuseChunk(failAt: number) {
  return async (files: string[], options: ChunkOptions): Promise<MeetingTranscript> => {
    for (let current = 1; current <= failAt; current += 1) {
      options.onChunk?.(current, files.length);
    }
    throw new ApiError("transcription_failed", `chunk ${failAt} was refused`, 502);
  };
}

function newMeeting(): string {
  const created = store.meetingStore().create(tenant, { title: "Checkout weekly", locale: "en" });
  return created.id;
}

function recordedMeeting(): string {
  const id = newMeeting();
  store.meetingStore().addRecording(tenant, id, {
    filename: "call.mp3",
    mime: "audio/mpeg",
    bytes: new Uint8Array([1, 2, 3]),
  });
  return id;
}

beforeAll(async () => {
  store = await import("./store");
  run = await import("./run");
}, 60_000);

beforeEach(() => {
  vi.stubEnv("AGENTFORGE_RUNTIME", "ai");
});

afterEach(() => {
  vi.unstubAllEnvs();
  seams.extract.mockReset();
  seams.transcribe.mockReset();
  seams.ask.mockReset();
  seams.usage.mockReset();
});

afterAll(async () => {
  // The kernel SQLite lives in dataDir; close it so Windows releases the file before cleanup.
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("transcribeMeeting", () => {
  it("bills the chunks the gateway answered when a later chunk is refused", async () => {
    const id = recordedMeeting();
    seams.extract.mockImplementation(extractInto([]));
    seams.transcribe.mockImplementation(refuseChunk(3));

    await expect(run.transcribeMeeting(tenant, id)).rejects.toMatchObject({ code: "transcription_failed" });

    // Chunks one and two answered: twenty minutes of audio the tenant has already paid for.
    expect(seams.usage).toHaveBeenCalledTimes(1);
    expect(seams.usage).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: tenant.workspaceId }), {
      model: "asr-test",
      seconds: 1200,
    });
  });

  it("bills nothing when the very first chunk is refused", async () => {
    const id = recordedMeeting();
    seams.extract.mockImplementation(extractInto([]));
    seams.transcribe.mockImplementation(refuseChunk(1));

    await expect(run.transcribeMeeting(tenant, id)).rejects.toMatchObject({ code: "transcription_failed" });
    expect(seams.usage).not.toHaveBeenCalled();
  });

  it("bills the whole recording once when every chunk answered", async () => {
    const id = recordedMeeting();
    seams.extract.mockImplementation(extractInto([]));
    seams.transcribe.mockImplementation(async (files: string[], options: ChunkOptions) => {
      for (let current = 1; current <= files.length; current += 1) {
        options.onChunk?.(current, files.length);
      }
      return { ...TRANSCRIPT, source: "gateway", model: "asr-test" };
    });

    const record = await run.transcribeMeeting(tenant, id);

    expect(record.status).toBe("transcribed");
    expect(seams.usage).toHaveBeenCalledTimes(1);
    expect(seams.usage).toHaveBeenCalledWith(expect.anything(), { model: "asr-test", seconds: DURATION_SECONDS });
  });

  it("clears the chunk cache when ffmpeg fails part-way through", async () => {
    const id = recordedMeeting();
    const outDirs: string[] = [];
    seams.extract.mockImplementation(async (_source: string, outDir: string) => {
      outDirs.push(outDir);
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "chunk-000.mp3"), "x");
      throw new ApiError("ffmpeg_failed", "ffmpeg recipe failed", 502);
    });

    await expect(run.transcribeMeeting(tenant, id)).rejects.toMatchObject({ code: "ffmpeg_failed" });
    expect(outDirs).toHaveLength(1);
    expect(existsSync(outDirs[0] as string)).toBe(false);
    expect(seams.transcribe).not.toHaveBeenCalled();
  });

  it("clears the chunk cache when the client leaves as the audio is ready", async () => {
    const id = recordedMeeting();
    const outDirs: string[] = [];
    const controller = new AbortController();
    seams.extract.mockImplementation(extractInto(outDirs, () => controller.abort()));

    await expect(run.transcribeMeeting(tenant, id, { abortSignal: controller.signal })).rejects.toMatchObject({
      code: "aborted",
    });
    expect(existsSync(outDirs[0] as string)).toBe(false);
    expect(seams.transcribe).not.toHaveBeenCalled();
  });

  it("clears the chunk cache when the recogniser fails", async () => {
    const id = recordedMeeting();
    const outDirs: string[] = [];
    seams.extract.mockImplementation(extractInto(outDirs));
    seams.transcribe.mockImplementation(refuseChunk(2));

    await expect(run.transcribeMeeting(tenant, id)).rejects.toMatchObject({ code: "transcription_failed" });
    expect(existsSync(outDirs[0] as string)).toBe(false);
  });
});

describe("generateMinutes", () => {
  function transcribedMeeting(): string {
    const id = newMeeting();
    store.meetingStore().update(tenant, id, { status: "transcribed", transcript: TRANSCRIPT });
    return id;
  }

  function answer(translation: "ok" | "fail") {
    return async (options: { versionId: string }) => {
      if (options.versionId === "meeting-translate") {
        if (translation === "fail") {
          throw new ApiError("generation_failed", "The gateway did not answer", 502);
        }
        return { text: JSON.stringify(minutes("Rapat mingguan checkout")), model: "minutes-model" };
      }
      return { text: JSON.stringify(minutes("Checkout weekly")), model: "minutes-model" };
    };
  }

  it("keeps the minutes on the meeting when the translation fails", async () => {
    const id = transcribedMeeting();
    // An earlier run left minutes and their translation behind; both describe older minutes.
    const earlier = {
      locale: "en" as const,
      minutes: minutes("Last week"),
      artifactId: "",
      model: "m",
      unverifiedNames: [],
      checks: null,
    };
    store.meetingStore().update(tenant, id, {
      minutes: earlier,
      translation: { ...earlier, locale: "id", minutes: minutes("Minggu lalu") },
    });
    seams.ask.mockImplementation(answer("fail"));

    await expect(run.generateMinutes(tenant, id)).rejects.toMatchObject({
      code: "generation_failed",
    });

    const record = store.meetingStore().get(tenant, id);
    expect(record?.status).toBe("minuted");
    expect(record?.minutes?.minutes.title).toBe("Checkout weekly");
    expect(record?.minutes?.locale).toBe("en");
    // The old translation described older minutes; it must not sit beside the new ones.
    expect(record?.translation).toBeNull();
  });

  it("saves the minutes and then their translation when both land", async () => {
    const id = transcribedMeeting();
    seams.ask.mockImplementation(answer("ok"));

    const returned = await run.generateMinutes(tenant, id);

    const record = store.meetingStore().get(tenant, id);
    expect(record?.status).toBe("minuted");
    expect(record?.minutes?.minutes.title).toBe("Checkout weekly");
    expect(record?.translation?.locale).toBe("id");
    expect(record?.translation?.minutes.title).toBe("Rapat mingguan checkout");
    expect(returned.translation?.minutes.title).toBe("Rapat mingguan checkout");
  });

  it("saves the minutes without a translation when none is asked for", async () => {
    const id = transcribedMeeting();
    seams.ask.mockImplementation(answer("fail"));

    const returned = await run.generateMinutes(tenant, id, { translate: false });

    expect(returned.minutes?.minutes.title).toBe("Checkout weekly");
    expect(returned.translation).toBeNull();
    expect(seams.ask).toHaveBeenCalledTimes(1);
  });

  it("hands the job's cancel to the minutes call and to the translation call", async () => {
    const id = transcribedMeeting();
    seams.ask.mockImplementation(answer("ok"));
    const controller = new AbortController();

    await run.generateMinutes(tenant, id, { abortSignal: controller.signal });

    expect(seams.ask).toHaveBeenCalledTimes(2);
    for (const [options] of seams.ask.mock.calls) {
      expect((options as { signal?: AbortSignal }).signal).toBe(controller.signal);
    }
  });

  it("saves nothing when the cancel lands while the minutes are being written", async () => {
    const id = transcribedMeeting();
    const controller = new AbortController();
    seams.ask.mockImplementation(async () => {
      controller.abort(new Error("client left"));
      return { text: JSON.stringify(minutes("Checkout weekly")), model: "minutes-model" };
    });

    await expect(run.generateMinutes(tenant, id, { abortSignal: controller.signal })).rejects.toMatchObject({
      code: "aborted",
      status: 499,
    });

    const record = store.meetingStore().get(tenant, id);
    expect(record?.status).toBe("transcribed");
    expect(record?.minutes ?? null).toBeNull();
    expect(seams.ask).toHaveBeenCalledTimes(1);
  });

  it("asks for the minutes once more when the first answer is not the sheet", async () => {
    const id = transcribedMeeting();
    let minutesCalls = 0;
    seams.ask.mockImplementation(async (options: { versionId: string; systemPrompt: string }) => {
      if (options.versionId === "meeting-translate") {
        return { text: JSON.stringify(minutes("Rapat mingguan checkout")), model: "minutes-model" };
      }
      minutesCalls += 1;
      if (minutesCalls === 1) {
        return { text: "not the sheet", model: "minutes-model" };
      }
      expect(options.systemPrompt).toContain("Write the minutes");
      return { text: JSON.stringify(minutes("Checkout weekly")), model: "minutes-model" };
    });

    const returned = await run.generateMinutes(tenant, id, { translate: false });

    expect(minutesCalls).toBe(2);
    expect(returned.minutes?.minutes.title).toBe("Checkout weekly");
  });

  it("strips a date and a figure the transcript never said before saving", async () => {
    const id = transcribedMeeting();
    const phases: string[] = [];
    seams.ask.mockImplementation(async (options: { versionId: string }) => {
      if (options.versionId === "meeting-translate") {
        return {
          text: JSON.stringify({
            ...minutes("Rapat"),
            heldOn: "Monday",
            summary: "Latensi 99 ms.",
          }),
          model: "minutes-model",
        };
      }
      return {
        text: JSON.stringify({
          ...minutes("Checkout weekly"),
          heldOn: "Monday",
          summary: "Latency hit 99 ms.",
        }),
        model: "minutes-model",
      };
    });

    const returned = await run.generateMinutes(tenant, id, {
      emit: (event) => {
        if (event.type === "job.phase") {
          phases.push(event.phase);
        }
      },
    });

    expect(returned.minutes?.minutes.heldOn).toBe("");
    expect(returned.minutes?.minutes.summary).toContain("[figure not said]");
    expect(returned.minutes?.minutes.summary).not.toContain("99");
    expect(returned.translation?.minutes.summary).not.toContain("99");
    expect(phases).toEqual(["minuting", "grounding", "saving", "translating"]);
  });

  it("labels each phase from the meeting copy table", async () => {
    const id = transcribedMeeting();
    seams.ask.mockImplementation(answer("ok"));
    const labels: string[] = [];

    await run.generateMinutes(tenant, id, {
      emit: (event) => {
        if (event.type === "job.phase") {
          labels.push(event.label);
        }
      },
    });

    // The desk locale is English here; the Indonesian copy is pinned in `core/src/meeting/skills.test.ts`.
    expect(labels).toEqual([
      "Writing the minutes",
      "Checking names, dates, and figures",
      "Saving the minutes",
      "Translating the minutes",
    ]);
  });

  it("asks for the translation once more, then keeps the minutes when it still disagrees", async () => {
    const id = transcribedMeeting();
    let translateCalls = 0;
    seams.ask.mockImplementation(async (options: { versionId: string }) => {
      if (options.versionId === "meeting-translate") {
        translateCalls += 1;
        return {
          text: JSON.stringify({
            ...minutes("Rapat"),
            decisions: [{ statement: "Buy a second vendor", provisional: false, context: "" }],
          }),
          model: "minutes-model",
        };
      }
      return { text: JSON.stringify(minutes("Checkout weekly")), model: "minutes-model" };
    });

    await expect(run.generateMinutes(tenant, id)).rejects.toMatchObject({ code: "translation_disagreed" });

    const record = store.meetingStore().get(tenant, id);
    expect(translateCalls).toBe(2);
    expect(record?.status).toBe("minuted");
    expect(record?.minutes?.minutes.title).toBe("Checkout weekly");
    expect(record?.translation).toBeNull();
  });

  it("writes an Indonesian meeting with the Indonesian output rule", async () => {
    const created = store.meetingStore().create(tenant, { title: "Rapat", locale: "id" });
    store.meetingStore().update(tenant, created.id, { status: "transcribed", transcript: TRANSCRIPT });
    seams.ask.mockImplementation(async (options: { versionId: string; systemPrompt: string }) => {
      expect(options.systemPrompt).toContain("Bahasa Indonesia");
      if (options.versionId === "meeting-translate") {
        return { text: JSON.stringify(minutes("Checkout weekly")), model: "minutes-model" };
      }
      return { text: JSON.stringify(minutes("Rapat mingguan")), model: "minutes-model" };
    });

    const returned = await run.generateMinutes(tenant, created.id, { translate: false });

    expect(returned.minutes?.locale).toBe("id");
    expect(seams.ask).toHaveBeenCalledTimes(1);
  });
});

describe("generateMinutes checks", () => {
  const LONG_TRANSCRIPT: MeetingTranscript = {
    text: [
      "Dewi: we ship the checkout fix on Friday 14 March and the call is at 15:30.",
      "Budi: I will update the runbook before 3 pm and send it to Dewi.",
      "Dewi: nobody owns the vendor contract yet, so we leave that open for now.",
    ].join("\n"),
    segments: [],
    language: "en",
    source: "pasted",
    model: "",
  };

  type Item = { task: string; owner: string; due: string; firstStep: string };
  const item = (task: string, owner: string): Item => ({ task, owner, due: "", firstStep: "" });
  const decision = (statement: string) => ({ statement, provisional: false, context: "" });

  function withMinutes(overrides: Partial<MeetingMinutes> = {}): MeetingMinutes {
    return { ...minutes("Checkout weekly"), ...overrides };
  }

  function longMeeting(): string {
    const id = newMeeting();
    store.meetingStore().update(tenant, id, { status: "transcribed", transcript: LONG_TRANSCRIPT });
    return id;
  }

  /**
   * Scripted model: the nth minutes call answers `answers[n]` (an Error is thrown instead). The
   * translation call answers the sheet the minutes call last wrote with only its title translated,
   * because a translation that is not the same sheet is refused (`translation_disagreed`).
   */
  function script(answers: Array<MeetingMinutes | string | Error>) {
    let call = 0;
    let lastSheet: MeetingMinutes = withMinutes();
    return async (options: { versionId: string }) => {
      if (options.versionId === "meeting-translate") {
        return { text: JSON.stringify({ ...lastSheet, title: "Rapat mingguan checkout" }), model: "minutes-model" };
      }
      const answer = answers[Math.min(call, answers.length - 1)];
      call += 1;
      if (typeof answer === "object" && !(answer instanceof Error)) {
        lastSheet = answer;
      }
      if (answer instanceof Error) {
        throw answer;
      }
      return { text: typeof answer === "string" ? answer : JSON.stringify(answer), model: "minutes-model" };
    };
  }

  function minutesCalls(): Array<{ prompt: string }> {
    return seams.ask.mock.calls
      .map(([options]) => options as { versionId: string; prompt: string })
      .filter((options) => options.versionId === "meeting-minutes");
  }

  async function savedMeta(id: string): Promise<Record<string, unknown>> {
    const { artifactStore } = await import("../artifacts");
    const artifactId = store.meetingStore().get(tenant, id)?.minutes?.artifactId ?? "";
    expect(artifactId).not.toBe("");
    return artifactStore().get(tenant, artifactId)?.meta ?? {};
  }

  const BAD_OWNER = withMinutes({ actionItems: [item("Renegotiate the vendor contract", "Rudi")] });
  const GOOD_OWNER = withMinutes({ actionItems: [item("Renegotiate the vendor contract", "Dewi")] });
  const BAD_DATE = withMinutes({ decisions: [decision("Ship the checkout fix on 21 March")] });
  const GOOD_DATE = withMinutes({ decisions: [decision("Ship the checkout fix on 14 March")] });
  const ALL_PASS = [
    { check: "minutes-shape", ok: true },
    { check: "action-owners", ok: true },
    { check: "quoted-dates", ok: true },
    { check: "summary-present", ok: true },
  ];

  it("asks once and records a passing run when the first minutes pass", async () => {
    const id = longMeeting();
    seams.ask.mockImplementation(script([GOOD_DATE]));

    await run.generateMinutes(tenant, id, { translate: false });

    expect(minutesCalls()).toHaveLength(1);
    expect(await savedMeta(id)).toMatchObject({ checks: { passed: true, rounds: 0, verdicts: ALL_PASS } });
  });

  it("sends the failed items back once and keeps the corrected minutes", async () => {
    const id = longMeeting();
    seams.ask.mockImplementation(script([BAD_OWNER, GOOD_OWNER]));
    const emit = vi.fn();

    const record = await run.generateMinutes(tenant, id, { translate: false, emit });

    const calls = minutesCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).not.toContain("ERROR:");
    // The repair carries the draft that failed and the exact item, as ERROR / WHY / FIX.
    expect(calls[1]?.prompt).toContain("Your previous answer:");
    expect(calls[1]?.prompt).toContain('"owner":"Rudi"');
    expect(calls[1]?.prompt).toContain(
      'ERROR: action item 1 ("Renegotiate the vendor contract") is owned by "Rudi", a name the transcript never says.',
    );
    expect(calls[1]?.prompt).toContain("FIX: Fix action item 1");
    expect(record.minutes?.minutes.actionItems[0]?.owner).toBe("Dewi");
    expect(record.minutes?.unverifiedNames).toEqual([]);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "job.step", phase: "minuting" }));
    expect(await savedMeta(id)).toMatchObject({ checks: { passed: true, rounds: 1, verdicts: ALL_PASS } });
  });

  it("repairs an answer that was not JSON", async () => {
    const id = longMeeting();
    seams.ask.mockImplementation(script(["Here are the minutes you asked for.", GOOD_DATE]));

    const record = await run.generateMinutes(tenant, id, { translate: false });

    expect(minutesCalls()).toHaveLength(2);
    expect(minutesCalls()[1]?.prompt).toContain(
      "ERROR: The minutes could not be read: the answer is not a single JSON object.",
    );
    expect(record.minutes?.minutes.decisions[0]?.statement).toBe("Ship the checkout fix on 14 March");
  });

  it("still fails with the old error when the minutes never parse", async () => {
    const id = longMeeting();
    seams.ask.mockImplementation(script(["not json", "still not json"]));

    await expect(run.generateMinutes(tenant, id, { translate: false })).rejects.toMatchObject({
      code: "invalid_minutes",
      status: 502,
    });
    expect(minutesCalls()).toHaveLength(2);
    expect(store.meetingStore().get(tenant, id)?.status).toBe("transcribed");
  });

  it("saves minutes that still fail after the repair, with the verdicts on the artifact", async () => {
    const id = longMeeting();
    seams.ask.mockImplementation(script([BAD_DATE, BAD_DATE]));

    const record = await run.generateMinutes(tenant, id, { translate: false });

    expect(minutesCalls()).toHaveLength(2);
    expect(record.status).toBe("minuted");
    // The repair did not fix the date, so the code stamps the figure the transcript never said.
    expect(record.minutes?.minutes.decisions[0]?.statement).toBe("Ship the checkout fix on [figure not said] March");
    expect(await savedMeta(id)).toMatchObject({
      checks: {
        passed: false,
        rounds: 1,
        verdicts: [
          { check: "minutes-shape", ok: true },
          { check: "action-owners", ok: true },
          { check: "quoted-dates", ok: false },
          { check: "summary-present", ok: true },
        ],
      },
    });
  });

  it("carries the verdicts on the minutes record, so the studio can say what still failed", async () => {
    const id = longMeeting();
    seams.ask.mockImplementation(script([BAD_DATE, BAD_DATE]));

    const returned = await run.generateMinutes(tenant, id);

    // The response the stream ends with, and the record a reload reads back: the same verdicts.
    const failed = {
      passed: false,
      rounds: 1,
      verdicts: [
        { check: "minutes-shape", ok: true },
        { check: "action-owners", ok: true },
        { check: "quoted-dates", ok: false },
        { check: "summary-present", ok: true },
      ],
    };
    expect(returned.minutes?.checks).toEqual(failed);
    expect(store.meetingStore().get(tenant, id)?.minutes?.checks).toEqual(failed);
    // The translation is not checked, so it claims no verdicts.
    expect(returned.translation?.checks).toBeNull();
  });

  it("reports a passing run as passed, with no rounds spent", async () => {
    const id = longMeeting();
    seams.ask.mockImplementation(script([GOOD_DATE]));

    const returned = await run.generateMinutes(tenant, id, { translate: false });

    expect(returned.minutes?.checks).toEqual({ passed: true, rounds: 0, verdicts: ALL_PASS });
  });

  it("keeps the first draft when the repair call itself fails", async () => {
    const id = longMeeting();
    seams.ask.mockImplementation(
      script([BAD_DATE, new ApiError("generation_failed", "The gateway did not answer", 502)]),
    );

    const record = await run.generateMinutes(tenant, id, { translate: false });

    expect(minutesCalls()).toHaveLength(2);
    // The repair did not fix the date, so the code stamps the figure the transcript never said.
    expect(record.minutes?.minutes.decisions[0]?.statement).toBe("Ship the checkout fix on [figure not said] March");
    expect(await savedMeta(id)).toMatchObject({ checks: { passed: false, rounds: 1 } });
  });

  it("does not repair a first call that fails: that error is the run's, as before", async () => {
    const id = longMeeting();
    seams.ask.mockImplementation(script([new ApiError("generation_failed", "The gateway did not answer", 502)]));

    await expect(run.generateMinutes(tenant, id, { translate: false })).rejects.toMatchObject({
      code: "generation_failed",
    });
    expect(minutesCalls()).toHaveLength(1);
  });

  it("still stamps an owner the transcript never says after the repair did not fix it", async () => {
    const id = longMeeting();
    seams.ask.mockImplementation(script([BAD_OWNER, BAD_OWNER]));

    const record = await run.generateMinutes(tenant, id, { translate: false });

    expect(record.minutes?.minutes.actionItems[0]?.owner).toBe("[needs owner]");
    expect(record.minutes?.unverifiedNames).toEqual(["Rudi"]);
    expect(await savedMeta(id)).toMatchObject({ unverifiedNames: ["Rudi"], checks: { passed: false, rounds: 1 } });
  });

  it("still drops an invented attendee from minutes that passed their checks on the repair", async () => {
    const id = longMeeting();
    // Attendees are the guard's to police, not a check's: the repair fixes the date, the guard drops Rudi.
    const repaired = {
      ...GOOD_DATE,
      attendees: [
        { name: "Dewi", role: "" },
        { name: "Rudi", role: "" },
      ],
    };
    seams.ask.mockImplementation(script([BAD_DATE, repaired]));

    const record = await run.generateMinutes(tenant, id, { translate: false });

    expect(minutesCalls()).toHaveLength(2);
    expect(record.minutes?.minutes.attendees.map((attendee) => attendee.name)).toEqual(["Dewi"]);
    expect(record.minutes?.unverifiedNames).toEqual(["Rudi"]);
    expect(await savedMeta(id)).toMatchObject({ checks: { passed: true, rounds: 1 } });
  });

  it("does not check or repair the translation", async () => {
    const id = longMeeting();
    seams.ask.mockImplementation(script([GOOD_DATE]));

    const record = await run.generateMinutes(tenant, id);

    expect(minutesCalls()).toHaveLength(1);
    expect(seams.ask).toHaveBeenCalledTimes(2);
    expect(record.translation?.locale).toBe("id");
    expect(record.translation?.artifactId).not.toBe("");
    const { artifactStore } = await import("../artifacts");
    expect(artifactStore().get(tenant, record.translation?.artifactId ?? "")?.meta).not.toHaveProperty("checks");
  });

  it("reports a cancel during the repair as the job's cancel, not as the signal's reason", async () => {
    const id = longMeeting();
    const controller = new AbortController();
    let call = 0;
    seams.ask.mockImplementation(async () => {
      call += 1;
      if (call === 2) {
        controller.abort(new Error("client left"));
        throw new Error("socket closed");
      }
      return { text: JSON.stringify(BAD_DATE), model: "minutes-model" };
    });

    await expect(
      run.generateMinutes(tenant, id, { translate: false, abortSignal: controller.signal }),
    ).rejects.toMatchObject({ code: "aborted", status: 499 });
    expect(store.meetingStore().get(tenant, id)?.status).toBe("transcribed");
  });
});
