/**
 * The two download calls the Chat buttons make, on each transport this renderer has.
 *
 * - the deck card calls `downloadArtifactFile` (artifacts-client), and a desk file calls `download`
 *   on the files API;
 * - on the web both fetch bytes and save a blob through an anchor;
 * - in the packaged app `apiFetch` crosses the IPC bridge, the shell answers `{ type: "bytes" }`, and
 *   `apiFetch` itself hands the bytes to `window.agentforge.saveBytes` (the native save dialog). The
 *   caller must then do nothing more, or the person gets a second dialog for the same file.
 *
 * The shell's own half (`host:save-bytes` in apps/desktop/main.cjs) is not run here.
 */
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
    io: { desktop: () => false, saveBlob: (blob: Blob, filename: string) => void saved.push({ blob, filename }) },
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

  it("does not save a second copy on the desktop, where apiFetch has already written the file", async () => {
    const { saved, io } = sink();
    const outcome = await createFilesApi(async () => file("x", 'attachment; filename="a.md"'), {
      ...io,
      desktop: () => true,
    }).download("a.md");
    expect(outcome).toEqual({ ok: true, data: { filename: "a.md" } });
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

describe("in the packaged app, over the IPC bridge", () => {
  function bridge(answer: { type: "bytes"; status: number; bytes: number[]; contentType: string; filename?: string }) {
    const invoke = vi.fn(async (_request: unknown) => answer);
    const saveBytes = vi.fn(async () => undefined);
    vi.stubGlobal("window", { agentforge: { isElectron: true, invoke, stream: vi.fn(), saveBytes } });
    return { invoke, saveBytes };
  }

  it("a desk file goes through the native save dialog once and no blob is made", async () => {
    const text = "# Plan\n";
    const { invoke, saveBytes } = bridge({
      type: "bytes",
      status: 200,
      bytes: Array.from(bytesOf(text)),
      contentType: "text/markdown; charset=utf-8",
      filename: "plan.md",
    });
    const createUrl = vi.spyOn(URL, "createObjectURL");
    const outcome = await createFilesApi().download("notes/plan.md");
    expect(outcome).toEqual({ ok: true, data: { filename: "plan.md" } });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      method: "GET",
      path: "/api/v1/files/download",
      query: { path: "notes/plan.md" },
    });
    expect(saveBytes).toHaveBeenCalledTimes(1);
    expect(saveBytes).toHaveBeenCalledWith("plan.md", Array.from(bytesOf(text)));
    expect(createUrl).not.toHaveBeenCalled();
  });

  it("the deck goes through the native save dialog once, with the zip bytes the host built", async () => {
    const zip = [0x50, 0x4b, 0x03, 0x04, 9, 8, 7];
    const { invoke, saveBytes } = bridge({
      type: "bytes",
      status: 200,
      bytes: zip,
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      filename: "quarterly-review.pptx",
    });
    const createUrl = vi.spyOn(URL, "createObjectURL");
    await downloadArtifactFile("a1b2", "deck.pptx");
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ method: "GET", path: "/api/v1/artifacts/a1b2/file" });
    expect(saveBytes).toHaveBeenCalledTimes(1);
    expect(saveBytes).toHaveBeenCalledWith("quarterly-review.pptx", zip);
    expect(createUrl).not.toHaveBeenCalled();
  });

  it("a refusal from the host reaches the caller and opens no dialog", async () => {
    const invoke = vi.fn(async () => ({
      type: "json",
      status: 404,
      body: { error: { code: "not_found", message: "Artifact not found" } },
    }));
    const saveBytes = vi.fn(async () => undefined);
    vi.stubGlobal("window", { agentforge: { isElectron: true, invoke, stream: vi.fn(), saveBytes } });
    await expect(downloadArtifactFile("missing")).rejects.toThrow("Artifact not found");
    expect(await createFilesApi().download("gone.md")).toEqual({ ok: false, code: "not_found", status: 404 });
    expect(saveBytes).not.toHaveBeenCalled();
  });
});

describe("in the packaged app, when the save itself does not happen", () => {
  /** The host sent the bytes; what the shell's save dialog and disk did with them is `answer`. */
  function shell(answer: unknown) {
    const invoke = vi.fn(async () => ({
      type: "bytes",
      status: 200,
      bytes: [1, 2, 3],
      contentType: "application/octet-stream",
      filename: "deck.pptx",
    }));
    const saveBytes = vi.fn(async () => answer);
    vi.stubGlobal("window", { agentforge: { isElectron: true, invoke, stream: vi.fn(), saveBytes } });
    return { saveBytes };
  }

  it("a disk that refused the write is an error the card can show, not a download that seems to have worked", async () => {
    const { saveBytes } = shell({ ok: false, reason: "write-failed" });
    await expect(downloadArtifactFile("a1b2", "deck.pptx")).rejects.toMatchObject({
      name: "DesktopSaveError",
      reason: "write-failed",
      message: expect.stringMatching(/could not be written/i),
    });
    expect(saveBytes).toHaveBeenCalledTimes(1);
  });

  it("every other refusal throws too, with a sentence", async () => {
    for (const reason of ["too-large", "forbidden", "bad-filename"]) {
      shell({ ok: false, reason });
      await expect(downloadArtifactFile("a1b2", "deck.pptx"), reason).rejects.toMatchObject({
        name: "DesktopSaveError",
        reason,
      });
    }
  });

  it("a desk file's refusal is save_failed, not a network error", async () => {
    shell({ ok: false, reason: "write-failed" });
    expect(await createFilesApi().download("notes/plan.md")).toEqual({ ok: false, code: "save_failed", status: 0 });
  });

  it("a closed dialog is the person's choice: no error from either button", async () => {
    shell({ ok: false, reason: "canceled" });
    await expect(downloadArtifactFile("a1b2", "deck.pptx")).resolves.toBeUndefined();
    expect(await createFilesApi().download("notes/plan.md")).toEqual({ ok: true, data: { filename: "deck.pptx" } });
  });

  it("a save that worked, and an older shell that answers nothing, stay what they were", async () => {
    shell({ ok: true });
    await expect(downloadArtifactFile("a1b2", "deck.pptx")).resolves.toBeUndefined();
    shell(undefined);
    await expect(downloadArtifactFile("a1b2", "deck.pptx")).resolves.toBeUndefined();
  });
});
