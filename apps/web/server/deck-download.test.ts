import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { downloadArtifactFile } from "@/lib/artifacts-client";
import { createFilesApi } from "@/lib/files-api";

/**
 * The host opens its SQLite file when it is first imported, so a throwaway data dir has to be in the
 * environment before that. ES imports run before the module body, so the host is imported inside
 * `beforeAll`, after these lines; a static import would open `data/` in the checkout.
 */
const dataDir = mkdtempSync(join(tmpdir(), "agentforge-web-download-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "3f8a1c05d97e26b4084fa3c1e5d7290b6c48af13e02d95b7ca6318fd4e7092a5";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.AGENTFORGE_SERVER;

let host: typeof import("@agentforge/host");

/** The value, or a failure that names the missing one: a test reads a captured call it has just made. */
function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("expected a captured value");
  }
  return value;
}

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const DECK = {
  title: "Roadmap review",
  slides: [
    { heading: "What shipped", bullets: ["Deck tool", "Download buttons"], notes: "Say thanks." },
    { heading: "What is next", bullets: ["Hosted proof"], notes: "" },
  ],
};
const FILE_PATH = "out/summary.csv";
const FILE_TEXT = "name,total\nwarung,12\nkedai,7\n";

type ZipEntry = { name: string; method: number; compressed: number; offset: number };

function zipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.byteLength - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) {
    end -= 1;
  }
  if (end < 0) {
    throw new Error("not a zip: no end-of-directory record");
  }
  const total = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < total; i += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) {
      throw new Error("bad central directory");
    }
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    entries.push({
      name: Buffer.from(bytes.subarray(at + 46, at + 46 + nameLength)).toString("utf8"),
      method: view.getUint16(at + 10, true),
      compressed: view.getUint32(at + 20, true),
      offset: view.getUint32(at + 42, true),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function zipText(bytes: Uint8Array, entry: ZipEntry): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  const body = bytes.subarray(start, start + entry.compressed);
  return (entry.method === 0 ? Buffer.from(body) : inflateRawSync(body)).toString("utf8");
}

function slideTexts(bytes: Uint8Array): string[] {
  return zipEntries(bytes)
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }))
    .map((entry) => zipText(bytes, entry));
}

let server: Server;
let base = "";
let artifactId = "";
let artifactName = "";

type Saved = { blob: Blob; filename: string };
const saved: Saved[] = [];

function stubBrowser(): void {
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
    realFetch(typeof input === "string" && input.startsWith("/") ? `${base}${input}` : input, init),
  );
  const anchor = { href: "", download: "", click: () => undefined };
  const blobs = new Map<string, Blob>();
  vi.stubGlobal("document", {
    cookie: "",
    createElement: () => anchor,
  });
  anchor.click = () => {
    const blob = blobs.get(anchor.href);
    if (blob) {
      saved.push({ blob, filename: anchor.download });
    }
  };
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    const url = `blob:test-${blobs.size}`;
    blobs.set(url, blob as Blob);
    return url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
}

beforeAll(async () => {
  expect(process.env.AGENTFORGE_DATA_DIR).toBe(dataDir);
  host = await import("@agentforge/host");
  const { handleNodeRequest } = await import("@agentforge/host/http");
  const { getTool, invokeTool } = await import("@agentforge/core");
  host.ensureToolsRegistered();
  const tenant = await host.getTenant();
  const tool = getTool("build_deck");
  if (!tool) {
    throw new Error("build_deck is not registered");
  }
  const made = (await invokeTool(tool, DECK, tenant)) as { ok: boolean; artifactId: string; filename: string };
  expect(made.ok).toBe(true);
  artifactId = made.artifactId;
  artifactName = made.filename;

  const written = await host.dispatch({
    method: "POST",
    path: "/api/v1/files",
    query: {},
    params: {},
    headers: {},
    body: { path: FILE_PATH, content: FILE_TEXT },
  });
  expect(written).toMatchObject({ type: "json", status: 200 });

  server = createServer((req, res) => {
    void handleNodeRequest(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 400_000);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  saved.length = 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("in the browser, over a real socket", () => {
  it("the deck card's Download saves a real .pptx: right type, right name, one slide part per slide", async () => {
    stubBrowser();
    expect(artifactName).toBe("roadmap-review.pptx");
    await downloadArtifactFile(artifactId, "fallback.pptx");

    expect(saved).toHaveLength(1);
    expect(saved[0]?.filename).toBe("roadmap-review.pptx");
    expect(saved[0]?.blob.type).toBe(PPTX);
    const bytes = new Uint8Array(await must(saved[0]).blob.arrayBuffer());
    expect(Buffer.from(bytes.subarray(0, 4)).toString("latin1")).toBe("PK\u0003\u0004");
    const slides = slideTexts(bytes);
    // The title slide plus the two the model wrote.
    expect(slides).toHaveLength(3);
    expect(slides[0]).toContain("Roadmap review");
    expect(slides[1]).toContain("What shipped");
    expect(slides[1]).toContain("Download buttons");
    expect(slides[2]).toContain("What is next");
  });

  it("the desk file's Download saves the text byte for byte, under the file's own name", async () => {
    stubBrowser();
    const outcome = await createFilesApi().download(FILE_PATH);
    expect(outcome).toEqual({ ok: true, data: { filename: "summary.csv" } });
    expect(saved).toHaveLength(1);
    expect(saved[0]?.filename).toBe("summary.csv");
    expect(saved[0]?.blob.type).toMatch(/^text\/csv/);
    expect(await saved[0]?.blob.text()).toBe(FILE_TEXT);
  });

  it("answers a file that is not on the desk with the host's code and saves nothing", async () => {
    stubBrowser();
    expect(await createFilesApi().download("out/never-written.csv")).toEqual({
      ok: false,
      code: "not_found",
      status: 404,
    });
    expect(saved).toEqual([]);
  });

  it("throws the host's sentence for a deck that is gone, so the card can show its error", async () => {
    stubBrowser();
    await expect(downloadArtifactFile("00000000-0000-4000-8000-000000000000")).rejects.toThrow("Artifact not found");
    expect(saved).toEqual([]);
  });
});
