/**
 * The Edit agent's prompt names no server detail on the hosted service.
 *
 * `ffmpegPromptLine` fed the model the install hint for the SERVER when ffmpeg was missing: its
 * platform, the command that installs ffmpeg on it, and a line telling the owner to run it "in a
 * terminal" and press "Check again". On the hosted service the machine is the operator's, not the
 * tenant's: the model can repeat any of that to the person in chat, so the operator's platform and
 * install tooling leaked through the one channel `edit/doctor.ts` had already closed (it drops
 * `ffmpeg.setup` from the report on the hosted server — see `doctor-hosted.test.ts`). The advice is
 * also wrong there, because a tenant can install nothing on the server and the hosted banner shows
 * one calm line instead.
 *
 * Off server mode the line is exactly what it was: a desk's owner owns the machine and acts on it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EDIT_AGENT_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-edit-agent-prompt-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "stub";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.AGENTFORGE_SERVER;

/** A binary that does not exist, under a directory name nothing else contains: the probe fails and names it. */
const OPERATOR_DIR = "operator-private-dir-9a1f";
const FAKE_FFMPEG = join(dataDir, OPERATOR_DIR, "ffmpeg");
const PREVIOUS_FFMPEG = process.env.AGENTFORGE_FFMPEG_PATH;

let agent: typeof import("./agent-run");
let doctor: typeof import("./doctor");
let binary: typeof import("./ffmpeg-binary");

beforeAll(async () => {
  agent = await import("./agent-run");
  doctor = await import("./doctor");
  binary = await import("./ffmpeg-binary");
}, EDIT_AGENT_IMPORT_BUDGET_MS);

beforeEach(() => {
  process.env.AGENTFORGE_FFMPEG_PATH = FAKE_FFMPEG;
  binary.resetFfmpegBinaryCache();
  doctor.resetDoctorRecheckThrottle();
});

afterEach(() => {
  delete process.env.AGENTFORGE_SERVER;
  if (PREVIOUS_FFMPEG === undefined) {
    delete process.env.AGENTFORGE_FFMPEG_PATH;
  } else {
    process.env.AGENTFORGE_FFMPEG_PATH = PREVIOUS_FFMPEG;
  }
  binary.resetFfmpegBinaryCache();
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Best effort, as in test/global-setup.ts: on Windows an open handle can refuse the delete.
  }
});

/** Everything that describes the server's machine or how to change it. */
const SERVER_DETAIL = [
  /macos|windows|linux/i,
  /AGENTFORGE_FFMPEG_PATH/,
  /winget|brew |apt install|sudo/i,
  /terminal/i,
  /check again/i,
  /install ffmpeg/i,
  new RegExp(OPERATOR_DIR),
];

describe("the ffmpeg line of the Edit agent prompt", () => {
  it("hosted, ffmpeg missing: says the video tools are not set up and names nothing of the server", () => {
    process.env.AGENTFORGE_SERVER = "1";
    const line = agent.ffmpegPromptLine();

    for (const detail of SERVER_DETAIL) {
      expect(line, String(detail)).not.toMatch(detail);
    }
    // What the model may still pass on: the tools are off, and an administrator turns them on.
    expect(line).toMatch(/not (set up|available)/i);
    expect(line).toMatch(/administrator/i);
    expect(line).toMatch(/do not queue ffmpeg jobs/i);
  });

  it("hosted, ffmpeg missing, for every reason the probe can give", () => {
    process.env.AGENTFORGE_SERVER = "1";
    for (const reason of ["missing", "version_below_6", "exec_failed", "unparsed_version"]) {
      const line = agent.ffmpegPromptLine({
        ffmpeg: { found: false, path: FAKE_FFMPEG, version: null, reason },
      });
      for (const detail of SERVER_DETAIL) {
        expect(line, `${reason} ${detail}`).not.toMatch(detail);
      }
    }
  });

  it("hosted, ffmpeg present: the line it always was", () => {
    process.env.AGENTFORGE_SERVER = "1";
    const line = agent.ffmpegPromptLine({
      ffmpeg: { found: true, path: "/usr/bin/ffmpeg", version: "7.0", reason: undefined },
    });

    expect(line).toBe("ffmpeg 7.0 is installed. Export and ffmpeg are free. Never call ffmpeg yourself.");
  });

  it("Personal parity: on a desk the whole install hint is still in the prompt, byte for byte", () => {
    const line = agent.ffmpegPromptLine();
    const report = doctor.getEditDoctor();
    const setup = report.ffmpeg.setup;

    expect(report.ffmpeg.found).toBe(false);
    expect(setup).toBeDefined();
    expect(line).toBe(
      [
        `ffmpeg is NOT available on this ${setup?.platform}: ${setup?.summary}`,
        `If the owner asks for probe, cut, captions or export, or asks why video tools fail, tell them to run \`${setup?.installCommand}\` in a terminal, then press "Check again" in the Edit banner. No restart needed.`,
        "Do not queue ffmpeg jobs until it is installed.",
      ].join(" "),
    );
    // And it is the part that must not travel on the hosted server.
    expect(line).toMatch(/terminal/);
    expect(line).toContain(setup?.installCommand ?? "<unset>");
  });

  it("reaches the model: the compact prompt carries the hosted line and none of the server detail", () => {
    process.env.AGENTFORGE_SERVER = "1";
    const prompt = agent.compactPrompt(
      {
        name: "Cut",
        width: 1920,
        height: 1080,
        fps: 30,
        seq: 1,
        review: {},
        tracks: [],
        clips: [],
        ingredients: [],
      } as unknown as Parameters<typeof agent.compactPrompt>[0],
      2,
    );

    for (const detail of SERVER_DETAIL) {
      expect(prompt, String(detail)).not.toMatch(detail);
    }
    expect(prompt).toContain("Turn cap USD: 2.");
  });
});
