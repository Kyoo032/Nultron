/**
 * The Edit agent's ffmpeg line in the packaged app.
 *
 * The packaged installer carries its own ffmpeg (`resources/ffmpeg/`), so when that copy will not run the model
 * must not tell the person to run `winget install` or `brew install ffmpeg` in a terminal: they did not choose this
 * ffmpeg and cannot fix it that way. It passes on the one thing that helps (reinstall the app) and stops queueing
 * ffmpeg jobs. A desk that is not packaged keeps the install-hint line byte for byte (`agent-prompt-hosted.test.ts`
 * holds that).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EDIT_AGENT_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";
import { ffmpegSetupHint } from "./ffmpeg-setup";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-edit-agent-prompt-packaged-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "stub";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.AGENTFORGE_SERVER;

let agent: typeof import("./agent-run");

beforeAll(async () => {
  agent = await import("./agent-run");
}, EDIT_AGENT_IMPORT_BUDGET_MS);

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Best effort, as in test/global-setup.ts: on Windows an open handle can refuse the delete.
  }
});

describe("ffmpegPromptLine, packaged app, bundled ffmpeg failing", () => {
  for (const reason of ["missing", "exec_failed", "unparsed_version", "version_below_6"]) {
    it(`reason ${reason}: says to reinstall the app and names no install command`, () => {
      const line = agent.ffmpegPromptLine({
        ffmpeg: {
          found: false,
          path: null,
          version: null,
          reason,
          setup: ffmpegSetupHint("win32", reason, { bundled: true }),
        },
      });

      expect(line).toMatch(/reinstall/i);
      expect(line).toMatch(/do not queue ffmpeg jobs/i);
      expect(line).not.toMatch(/winget|brew |apt install|sudo|terminal|AGENTFORGE_FFMPEG_PATH|install ffmpeg/i);
      expect(line).not.toMatch(/run `/);
    });
  }

  it("a desk that is not packaged still gets the install hint", () => {
    const line = agent.ffmpegPromptLine({
      ffmpeg: {
        found: false,
        path: null,
        version: null,
        reason: "missing",
        setup: ffmpegSetupHint("win32", "missing"),
      },
    });

    expect(line).toContain("winget install --id Gyan.FFmpeg -e");
    expect(line).toMatch(/terminal/);
  });
});
