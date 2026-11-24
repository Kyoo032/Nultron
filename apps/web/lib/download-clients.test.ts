import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadArtifactFile } from "./artifacts-client";
import { createFilesApi, type FilesFetch } from "./files-api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const bytesOf = (text: string) => new TextEncoder().encode(text);

/** The value, or a failure that names the missing one: a test reads a captured call it has just made. */
function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("expected a captured value");
  }
  return value;
}

function file(text: string, disposition: string | null, status = 200): Response {
  return new Response(bytesOf(text), {
    status,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      ...(disposition ? { "Content-Disposition": disposition } : {}),
    },
  });
}

function sink() {
  const saved: Array<{ blob: Blob; filename: string }> = [];
  return {
    saved,
    io: { saveBlob: (blob: Blob, filename: string) => void saved.push({ blob, filename }) },
  };
}

describe("a desk file, on the web", () => {
  it("asks for the file by path in the query and saves the bytes under the name the host sent", async () => {
    const urls: string[] = [];
    const { saved, io } = sink();
    const fetcher: FilesFetch = async (url) => {
      urls.push(url);
      return file("# Plan\n", 'attachment; filename="plan.md"');
    };
    const outcome = await createFilesApi(fetcher, io).download("notes/plan.md");
    expect(outcome).toEqual({ ok: true, data: { filename: "plan.md" } });
    expect(urls).toEqual(["/api/v1/files/download?path=notes%2Fplan.md"]);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.filename).toBe("plan.md");
    expect(await saved[0]?.blob.text()).toBe("# Plan\n");
  });

  it("prefers the UTF-8 file name when the host sent one, and falls back to the path's own name", async () => {
    const utf8 = sink();
    await createFilesApi(
      async () => file("x", "attachment; filename=\"My plan _.md\"; filename*=UTF-8''My%20plan%20%E2%98%95.md"),
      utf8.io,
    ).download("dl/My plan ☕.md");
    expect(utf8.saved[0]?.filename).toBe("My plan ☕.md");

    const bare = sink();
    await createFilesApi(async () => file("x", null), bare.io).download("dl/notes/plan.md");
    expect(bare.saved[0]?.filename).toBe("plan.md");
  });

  it("keeps the host's code when it refuses, and saves nothing", async () => {
    const { saved, io } = sink();
    const gone = createFilesApi(
      async () =>
        new Response(JSON.stringify({ error: { code: "not_found", message: "No file at that path." } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      io,
    );
    expect(await gone.download("gone.md")).toEqual({ ok: false, code: "not_found", status: 404 });
    const down = createFilesApi(async () => {
      throw new TypeError("fetch failed");
    }, io);
    expect(await down.download("a.md")).toEqual({ ok: false, code: "network", status: 0 });
    expect(saved).toEqual([]);
  });
});

describe("the deck, on the web", () => {
  it("fetches the artifact file route and saves the zip bytes under the file name the host sent", async () => {
    const zip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(url);
      return new Response(zip, {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          "Content-Disposition": 'attachment; filename="quarterly-review.pptx"',
        },
      });
    });
    const blobs: Blob[] = [];
    const anchor = { href: "", download: "", click: vi.fn() };
    vi.stubGlobal("document", { createElement: () => anchor, cookie: "" });
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return "blob:deck";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    await downloadArtifactFile("a1b2", "deck.pptx");

    expect(asked).toEqual(["/api/v1/artifacts/a1b2/file"]);
    expect(anchor.download).toBe("quarterly-review.pptx");
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(await must(blobs[0]).arrayBuffer())).toEqual(zip);
    expect(blobs[0]?.type).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
  });

  it("throws the host's own sentence when the artifact is gone, so the card can show it", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ error: { code: "not_found", message: "Artifact not found" } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(downloadArtifactFile("missing")).rejects.toThrow("Artifact not found");
  });
});
