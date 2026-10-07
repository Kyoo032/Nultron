/**
 * The input whitelist, the format gate and the timeouts against a REAL ffmpeg and ffprobe (SR-135).
 *
 * `ffmpeg/input-safety.test.ts` and `ffmpeg/run-input-safety.test.ts` hold the logic with a stub. This file runs
 * the bundled programs on tiny files it generates itself and answers the three questions a stub cannot:
 * does an ordinary mp4, mov, webm, mp3, wav and m4a still import, extract and render with the whitelist on; is a
 * playlist or concat script refused; and does the whitelist really keep ffmpeg from opening an address.
 *
 * The programs are found, in order, through AGENTFORGE_FFMPEG_PATH, the staged copy in
 * `apps/desktop/resources/ffmpeg/` (`node apps/desktop/scripts/stage-ffmpeg.mjs --target <t>`), then PATH. With none
 * of them the whole file is skipped, so a machine without ffmpeg stays green.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-ffmpeg-real-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "stub";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.AGENTFORGE_SERVER;

const STAGED = fileURLToPath(new URL("../../../../apps/desktop/resources/ffmpeg/", import.meta.url));
const EXE = process.platform === "win32" ? ".exe" : "";
if (!process.env.AGENTFORGE_FFMPEG_PATH && existsSync(join(STAGED, `ffmpeg${EXE}`))) {
  process.env.AGENTFORGE_FFMPEG_PATH = join(STAGED, `ffmpeg${EXE}`);
}

const binary = await import("./ffmpeg-binary");
const ffmpeg = binary.resolveFfmpeg();
const ffprobe = binary.resolveFfprobe();
const available = ffmpeg.found && ffprobe.found && Boolean(ffmpeg.path) && Boolean(ffprobe.path);

const TENANT = "safety-tenant";
const PROJECT = "p1";
const SCOPE = { tenantId: TENANT, projectId: PROJECT };

let media: string;
let recipes: typeof import("./ffmpeg/recipes");
let run: typeof import("./ffmpeg/run");
let audio: typeof import("../meeting/audio");
let core: typeof import("@agentforge/core");

const at = (name: string): string => join(media, name);

function make(args: string[]): void {
  execFileSync(ffmpeg.path as string, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "pipe" });
}

const VIDEO = ["-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=10"];
const SOUND = ["-f", "lavfi", "-i", "sine=duration=1"];

beforeAll(async () => {
  if (!available) return;
  recipes = await import("./ffmpeg/recipes");
  run = await import("./ffmpeg/run");
  audio = await import("../meeting/audio");
  core = await import("@agentforge/core");
  const { tenantMediaRoot } = await import("../media-root");
  media = tenantMediaRoot(TENANT);
  mkdirSync(media, { recursive: true });

  make([...VIDEO, ...SOUND, "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", at("ok.mp4")]);
  make([...VIDEO, ...SOUND, "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", at("ok.mov")]);
  make([...VIDEO, ...SOUND, "-shortest", "-c:v", "libvpx", "-c:a", "libvorbis", at("ok.webm")]);
  make([...SOUND, "-c:a", "libmp3lame", at("ok.mp3")]);
  make([...SOUND, at("ok.wav")]);
  make([...SOUND, "-c:a", "aac", at("ok.m4a")]);
  // The refused kinds: a playlist with a local segment, a playlist with an address, a concat script, a metadata file.
  make([...VIDEO, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mpegts", at("seg.ts")]);
  writeFileSync(
    at("local.m3u8"),
    "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:1,\nseg.ts\n#EXT-X-ENDLIST\n",
  );
  writeFileSync(
    at("net.m3u8"),
    "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttp://127.0.0.1:9/seg.ts\n#EXT-X-ENDLIST\n",
  );
  writeFileSync(at("list.ffconcat"), "ffconcat version 1.0\nfile ok.mp4\n");
  writeFileSync(at("meta.txt"), ";FFMETADATA1\ntitle=x\n");
}, 120_000);

afterAll(async () => {
  try {
    const { sql } = await import("@agentforge/db");
    sql.close();
  } catch {
    // The database was never opened when the whole file was skipped.
  }
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Best effort, as in test/global-setup.ts: on Windows an open handle can refuse the delete.
  }
});

async function refusal(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error("expected a refusal");
}

describe.skipIf(!available)(
  "ordinary media still works with the whitelist on (a real ffmpeg)",
  { timeout: 60_000 },
  () => {
    const ORDINARY = ["ok.mp4", "ok.mov", "ok.webm", "ok.mp3", "ok.wav", "ok.m4a"];

    it("probes mp4, mov, webm, mp3, wav and m4a", async () => {
      for (const name of ORDINARY) {
        const probed = await recipes.probe(at(name), SCOPE);
        expect(probed.durationSeconds, name).toBeGreaterThan(0.5);
        expect(probed.durationSeconds, name).toBeLessThan(2);
      }
    });

    it("gives the meeting probe the same six", async () => {
      const allow = { roots: [media], denied: [] };
      for (const name of ORDINARY) {
        expect(await audio.probeDuration(at(name), allow), name).toBeGreaterThan(0.5);
      }
    });

    it("extracts audio (the Edit recipe) from a video and from an audio file", async () => {
      for (const name of ["ok.mp4", "ok.m4a"]) {
        const { files } = await recipes.extractAudio(at(name), SCOPE);
        expect(files).toHaveLength(1);
        expect(statSync(files[0]).size, name).toBeGreaterThan(1000);
      }
    });

    it("extracts Meeting's audio chunks from a recording", async () => {
      const allow = { roots: [media], denied: [] };
      const out = join(media, "meeting-chunks");
      const extracted = await audio.extractMeetingAudio(at("ok.mp4"), out, allow);
      expect(extracted.files.length).toBeGreaterThanOrEqual(1);
      expect(statSync(extracted.files[0]).size).toBeGreaterThan(1000);
    });

    it("runs the analysis recipes and a thumbnail", async () => {
      const silence = await recipes.silenceDetect(at("ok.mp4"), SCOPE, 30);
      expect(Array.isArray(silence.ranges)).toBe(true);
      const scenes = await recipes.sceneDetect(at("ok.mp4"), SCOPE, 30);
      expect(Array.isArray(scenes.frames)).toBe(true);
      const thumb = await recipes.thumbnail(at("ok.mp4"), SCOPE, 3, 30);
      expect(statSync(thumb.file).size).toBeGreaterThan(100);
    });

    function projectWith(clips: boolean): import("@agentforge/core").EditProject {
      const doc = core.emptyProject({ id: PROJECT, workspaceId: "w1", name: "Safety", aspect: "1:1", fps: 30 });
      const assets: Record<string, import("@agentforge/core").Asset> = clips
        ? {
            a1: {
              id: "a1",
              kind: "video" as const,
              storagePath: at("ok.mp4"),
              durationFrames: 30,
              width: 64,
              height: 64,
              fps: 10,
            },
          }
        : {};
      return {
        ...doc,
        width: 128,
        height: 128,
        assets,
        clips: clips
          ? [
              {
                id: "c1",
                trackId: "v1",
                timelineStartFrame: 0,
                durationFrames: 20,
                source: { assetId: "a1", inFrame: 0 },
                status: "ready" as const,
              },
            ]
          : [],
      };
    }

    it("renders a timeline with a clip, and one with none (the lavfi input), with libx264", async () => {
      for (const clips of [true, false]) {
        const { file } = await recipes.render(TENANT, projectWith(clips), "h264-720p");
        expect(statSync(file).size, `clips=${clips}`).toBeGreaterThan(500);
        const info = JSON.parse(
          execFileSync(ffprobe.path as string, ["-v", "error", "-print_format", "json", "-show_streams", file], {
            encoding: "utf8",
          }),
        ) as { streams: Array<{ codec_name?: string }> };
        expect(info.streams[0].codec_name).toBe("h264");
      }
    });

    it("renders a still frame from the timeline", async () => {
      const { file } = await recipes.frameAt(TENANT, projectWith(true), 2);
      expect(statSync(file).size).toBeGreaterThan(100);
    });
  },
);

describe.skipIf(!available)("a playlist or a script is refused (a real ffprobe)", { timeout: 60_000 }, () => {
  it("refuses an HLS playlist whose segment is a local file, in the Edit probe and in Meeting's", async () => {
    const edit = await refusal(recipes.probe(at("local.m3u8"), SCOPE));
    expect(edit.code).toBe("unsupported_media");
    expect(edit.message).toMatch(/playlist or a list of other files/i);
    const meeting = await refusal(audio.probeDuration(at("local.m3u8"), { roots: [media], denied: [] }));
    expect(meeting.code).toBe("unsupported_media");
  });

  it("refuses an ffconcat script and an ffmetadata file", async () => {
    for (const name of ["list.ffconcat", "meta.txt"]) {
      const edit = await refusal(recipes.probe(at(name), SCOPE));
      expect(edit.code, name).toBe("unsupported_media");
      const meeting = await refusal(audio.probeDuration(at(name), { roots: [media], denied: [] }));
      expect(meeting.code, name).toBe("unsupported_media");
    }
  });

  it("fails a playlist that names an address closed: the probe errors, nothing is fetched", async () => {
    const edit = await refusal(recipes.probe(at("net.m3u8"), SCOPE));
    expect(edit.code).toBe("ffmpeg_failed");
    await refusal(audio.probeDuration(at("net.m3u8"), { roots: [media], denied: [] }));
  });

  it("an extractMeetingAudio on a concat script is refused before ffmpeg is asked to read it", async () => {
    const out = join(media, "meeting-concat");
    const error = await refusal(audio.extractMeetingAudio(at("list.ffconcat"), out, { roots: [media], denied: [] }));
    expect(error.code).toBe("unsupported_media");
  });
});

describe.skipIf(!available)(
  "the whitelist keeps ffmpeg from opening an address (a real ffmpeg)",
  { timeout: 60_000 },
  () => {
    let server: http.Server;
    let hits: string[] = [];
    let port = 0;

    beforeAll(async () => {
      server = http.createServer((request, response) => {
        hits.push(`${request.method} ${request.url}`);
        response.statusCode = 404;
        response.end("no");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("the control: ffmpeg run directly, with no whitelist, does fetch the address (so a zero below means something)", async () => {
      hits = [];
      const { execFile } = await import("node:child_process");
      await new Promise<void>((resolve) => {
        execFile(
          ffmpeg.path as string,
          ["-hide_banner", "-loglevel", "error", "-i", `http://127.0.0.1:${port}/direct.mp4`, "-f", "null", "-"],
          () => resolve(),
        );
      });
      expect(hits).toEqual(["GET /direct.mp4"]);
    });

    it("through runFfmpeg the same input makes no request at all", async () => {
      hits = [];
      // Deliberately bypasses the path guard every recipe uses: the whitelist alone has to hold.
      await expect(
        run.runFfmpeg(["-i", `http://127.0.0.1:${port}/direct.mp4`, "-f", "null", "-"], { timeoutMs: 20_000 }),
      ).rejects.toBeTruthy();
      expect(hits).toEqual([]);
    });

    it("a probe of that address through runFfmpeg makes none either", async () => {
      hits = [];
      await expect(
        run.runFfmpeg(["-v", "error", "-show_format", `http://127.0.0.1:${port}/direct.mp4`], {
          timeoutMs: 20_000,
          bin: "ffprobe",
        }),
      ).rejects.toBeTruthy();
      expect(hits).toEqual([]);
    });
  },
);

describe.skipIf(!available)("the timeout cap (a real recipe, a stubbed ffmpeg)", { timeout: 60_000 }, () => {
  it("a file that declares 10^7 seconds gets a bounded timeout from the silence scan on a hosted server", async () => {
    process.env.AGENTFORGE_SERVER = "1";
    const seen: number[] = [];
    try {
      run.setExecFileForTests((async (
        file: string,
        args: readonly string[] | undefined,
        options: { timeout?: number },
      ) => {
        seen.push(options.timeout ?? Number.NaN);
        if (file === ffprobe.path || (args ?? []).includes("-show_format")) {
          return {
            stdout: JSON.stringify({
              streams: [],
              format: { duration: "10000000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
            }),
            stderr: "",
          };
        }
        return { stdout: "", stderr: "" };
      }) as never);
      await recipes.silenceDetect(at("ok.mp4"), SCOPE, 30);
    } finally {
      run.setExecFileForTests(null);
      delete process.env.AGENTFORGE_SERVER;
    }
    const { ANALYSIS_TIMEOUT_CEILING_MS } = await import("./ffmpeg/input-safety");
    expect(seen).toHaveLength(2); // the probe, then the scan
    expect(seen[1]).toBe(ANALYSIS_TIMEOUT_CEILING_MS);
  });

  it("the same file on a desk is bounded by the longest media the product accepts, not by its own claim", async () => {
    const seen: number[] = [];
    try {
      run.setExecFileForTests((async (
        _file: string,
        args: readonly string[] | undefined,
        options: { timeout?: number },
      ) => {
        seen.push(options.timeout ?? Number.NaN);
        if ((args ?? []).includes("-show_format")) {
          return {
            stdout: JSON.stringify({
              streams: [],
              format: { duration: "10000000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
            }),
            stderr: "",
          };
        }
        return { stdout: "", stderr: "" };
      }) as never);
      await recipes.silenceDetect(at("ok.mp4"), SCOPE, 30);
    } finally {
      run.setExecFileForTests(null);
    }
    expect(seen[1]).toBe(2 * 36 * 600 * 1000 + 30_000);
    expect(seen[1]).toBeLessThan(2 ** 31 - 1);
  });
});

describe("this file reads what it claims to", () => {
  it("is pinned to the recipes and the meeting extractor that import the safety module", () => {
    const recipesSource = readFileSync(fileURLToPath(new URL("./ffmpeg/recipes.ts", import.meta.url)), "utf8");
    const audioSource = readFileSync(fileURLToPath(new URL("../meeting/audio.ts", import.meta.url)), "utf8");
    expect(recipesSource).toContain("assertAcceptableContainer(parsed.format?.format_name");
    expect(audioSource).toContain("assertAcceptableContainer(parsed.format?.format_name");
    expect(recipesSource).toContain("renderTimeoutMs(timelineSeconds)");
  });

  it("knows whether a real ffmpeg was found", () => {
    // Informational: the suites above are skipped, not failed, when this is false.
    expect(typeof available).toBe("boolean");
  });
});
