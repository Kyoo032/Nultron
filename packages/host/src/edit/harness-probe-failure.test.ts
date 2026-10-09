import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  editHarnessLine,
  setEditToolBackend,
  type EditHarnessSkill,
  type EditProject,
  type EditToolBackend,
} from "@agentforge/core";

/**
 * A silence or scene probe that throws used to be swallowed with a bare `catch`: the skill said it found
 * nothing and nobody could tell why. The fallback stays the same; the failure is now logged, with the
 * message redacted (the probe's text can carry a key a tool echoed back).
 */
const dataDir = mkdtempSync(join(tmpdir(), "agentforge-harness-probe-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_RUNTIME = "stub";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.AGENTFORGE_SERVER;

const KEY = "sk-live-0123456789abcdefABCDEF";

/** A video clip with an asset, which is all the probes read. The probes are the only thing under test. */
function probeDoc(): EditProject {
  return {
    id: "probe-project",
    tracks: [{ id: "v1", kind: "video" }],
    clips: [
      { id: "clip-1", trackId: "v1", timelineStartFrame: 0, durationFrames: 150, source: { assetId: "asset-1" } },
    ],
  } as unknown as EditProject;
}

function failingBackend(message: string): EditToolBackend {
  return {
    detectSilence: async () => {
      throw new Error(message);
    },
    detectScenes: async () => {
      throw new Error(message);
    },
  } as unknown as EditToolBackend;
}

async function run(skill: EditHarnessSkill, text: string): Promise<string[]> {
  const { runEditHarness } = await import("./harness-run");
  const { createTurnBudget } = await import("./budget");
  const { getTenant } = await import("../tenant");
  const tenant = await getTenant();
  const pushed: string[] = [];
  await runEditHarness({
    tenant,
    projectId: "probe-project",
    text,
    skill,
    stub: false,
    budget: createTurnBudget({ capUsd: 2 }),
    doc: probeDoc(),
    push: (frame) => pushed.push(frame),
  });
  return pushed;
}

/** The structured lines the host logger wrote for one event, as parsed records. */
function loggedEvent(spy: { mock: { calls: unknown[][] } }, event: string): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map((call) => String(call[0]))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record.event === event);
}

describe("a probe that fails", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setEditToolBackend(failingBackend(`ffprobe exited, key ${KEY}`));
  });

  afterEach(() => {
    warn.mockRestore();
    setEditToolBackend(null);
  });

  afterAll(async () => {
    const { sql } = await import("@agentforge/db");
    sql.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("lifts no dead air as before, and logs each failed attempt with the secret masked", async () => {
    const { localeForRun } = await import("../run-context");
    const pushed = await run("lift-dead-air", "Lift the dead air");

    expect(pushed.join("")).toContain(editHarnessLine("liftDeadAirEmpty", localeForRun()));
    const failures = loggedEvent(warn, "edit_silence_probe_failed");
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({ level: "warn", attempt: 0 });
    expect(JSON.stringify(failures)).toContain("[REDACTED]");
    expect(JSON.stringify(failures)).not.toContain(KEY);
  });

  it("cuts on no shot as before, and logs each failed attempt with the secret masked", async () => {
    const { localeForRun } = await import("../run-context");
    const pushed = await run("cut-on-shots", "Cut where the picture changes");

    expect(pushed.join("")).toContain(editHarnessLine("cutOnShotsEmpty", localeForRun()));
    const failures = loggedEvent(warn, "edit_scene_probe_failed");
    expect(failures).toHaveLength(2);
    expect(JSON.stringify(failures)).toContain("[REDACTED]");
    expect(JSON.stringify(failures)).not.toContain(KEY);
  });
});
