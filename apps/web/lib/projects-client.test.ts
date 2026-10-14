import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ path: string; init: RequestInit | undefined; response: Response }> = [];
let electron = false;

vi.mock("./api-client", () => ({
  apiFetch: vi.fn(async (path: string, init?: RequestInit) => {
    const next = calls.shift();
    if (!next) {
      throw new Error(`unexpected call ${path}`);
    }
    expect(path).toBe(next.path);
    expect(init?.method ?? "GET").toBe(next.init?.method ?? "GET");
    if (next.init?.body !== undefined) {
      expect(JSON.parse(String(init?.body))).toEqual(JSON.parse(String(next.init.body)));
    }
    return next.response;
  }),
  isElectron: () => electron,
}));

import {
  addProjectFile,
  addProjectMedia,
  createProject,
  downloadFile,
  listProjectFiles,
  listProjects,
  ProjectsError,
  removeProjectFile,
  removeProjectMedia,
  updateProject,
  downloadProjectFile,
} from "./projects-client";
import { visibilityChange, canRemoveFile, splitProjects, formatBytes, fileIconName, fileKind } from "./projects-view";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const PROJECT = {
  id: "proj_1",
  name: "Q4 plan",
  visibility: "private",
  createdBy: "user_me",
  createdAt: 1,
  updatedAt: 2,
} as const;

describe("projects client", () => {
  beforeEach(() => {
    calls.length = 0;
    electron = false;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists the Workspaces the host returns, checked field by field", async () => {
    calls.push({ path: "/api/v1/projects", init: undefined, response: json(200, { items: [PROJECT] }) });
    expect(await listProjects()).toEqual([PROJECT]);
  });

  it("refuses a list whose visibility is not one of the two words", async () => {
    calls.push({
      path: "/api/v1/projects",
      init: undefined,
      response: json(200, { items: [{ ...PROJECT, visibility: "public" }] }),
    });
    await expect(listProjects()).rejects.toMatchObject({ code: "projects_malformed", status: 502 });
  });

  it("creates a Workspace from a name only", async () => {
    calls.push({
      path: "/api/v1/projects",
      init: { method: "POST", body: JSON.stringify({ name: "Q4 plan" }) },
      response: json(201, { project: PROJECT }),
    });
    expect((await createProject("Q4 plan")).id).toBe("proj_1");
  });

  it("sends the switch as a PATCH of visibility alone", async () => {
    calls.push({
      path: "/api/v1/projects/proj_1",
      init: { method: "PATCH", body: JSON.stringify({ visibility: "workspace" }) },
      response: json(200, { project: { ...PROJECT, visibility: "workspace" } }),
    });
    const updated = await updateProject("proj_1", { visibility: "workspace" });
    expect(updated.visibility).toBe("workspace");
  });

  it("the switch sends nothing when it does not move", () => {
    expect(visibilityChange("private", "private")).toBeNull();
    expect(visibilityChange("private", "workspace")).toEqual({ visibility: "workspace" });
    expect(visibilityChange("workspace", "private")).toEqual({ visibility: "private" });
  });

  it("keeps the host's own sentence when the host refuses", async () => {
    calls.push({
      path: "/api/v1/projects/proj_1/files/art_1",
      init: { method: "DELETE" },
      response: json(403, { error: { code: "not_allowed", message: "Only the maker can remove this file." } }),
    });
    const error = await removeProjectFile("proj_1", "art_1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProjectsError);
    expect(error).toMatchObject({ code: "not_allowed", status: 403, message: "Only the maker can remove this file." });
  });

  it("reads a file list with size and owner", async () => {
    const file = {
      id: "art_1",
      kind: "artifact",
      title: "Deck",
      mime: "application/pdf",
      sizeBytes: 2048,
      ownerUserId: "user_me",
      updatedAt: 3,
      previewUrl: null,
      downloadUrl: "/api/v1/artifacts/art_1/file",
    };
    calls.push({ path: "/api/v1/projects/proj_1/files", init: undefined, response: json(200, { items: [file] }) });
    expect(await listProjectFiles("proj_1")).toEqual([file]);
  });

  it("reads a generated image or video with its preview and its attachment URL (SR-175)", async () => {
    const image = {
      id: "med_1",
      kind: "image",
      title: "image-med_1.png",
      mime: "image/png",
      sizeBytes: 9,
      ownerUserId: "user_colleague",
      updatedAt: 4,
      previewUrl: "/api/v1/media/med_1/file",
      downloadUrl: "/api/v1/media/med_1/file?download=1",
    };
    calls.push({ path: "/api/v1/projects/proj_1/files", init: undefined, response: json(200, { items: [image] }) });
    expect(await listProjectFiles("proj_1")).toEqual([image]);
  });

  it("refuses a file list whose row has no known kind", async () => {
    calls.push({
      path: "/api/v1/projects/proj_1/files",
      init: undefined,
      response: json(200, {
        items: [
          { id: "x", kind: "audio", title: "t", mime: "audio/mpeg", sizeBytes: 1, updatedAt: 1, downloadUrl: "/d" },
        ],
      }),
    });
    const error = await listProjectFiles("proj_1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProjectsError);
    expect((error as ProjectsError).code).toBe("projects_malformed");
  });

  it("adds a generated image by its media id, in the same body shape the host reads", async () => {
    calls.push({
      path: "/api/v1/projects/proj_1/files",
      init: { method: "POST", body: JSON.stringify({ mediaId: "med_1" }) },
      response: json(200, { ok: true }),
    });
    await expect(addProjectMedia("proj_1", "med_1")).resolves.toBeUndefined();
  });

  it("takes a generated image out through the media route", async () => {
    calls.push({
      path: "/api/v1/projects/proj_1/media/med_1",
      init: { method: "DELETE" },
      response: json(200, { ok: true }),
    });
    await expect(removeProjectMedia("proj_1", "med_1")).resolves.toBeUndefined();
  });

  it("downloads a Workspace file from the URL the host gave it", async () => {
    const anchor = { href: "", download: "", click: vi.fn() };
    vi.stubGlobal("document", { createElement: () => anchor });
    vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined });
    calls.push({
      path: "/api/v1/media/med_1/file?download=1",
      init: undefined,
      response: new Response("bytes", {
        status: 200,
        headers: { "Content-Disposition": 'attachment; filename="image-med_1.png"' },
      }),
    });
    await downloadFile("/api/v1/media/med_1/file?download=1", "fallback.png");
    expect(anchor.download).toBe("image-med_1.png");
    expect(anchor.click).toHaveBeenCalledOnce();
  });

  it("adds a chat file by its artifact id", async () => {
    calls.push({
      path: "/api/v1/projects/proj_1/files",
      init: { method: "POST", body: JSON.stringify({ artifactId: "art_1" }) },
      response: json(200, { ok: true }),
    });
    await expect(addProjectFile("proj_1", "art_1")).resolves.toBeUndefined();
  });

  it("removes a file through its own route", async () => {
    calls.push({
      path: "/api/v1/projects/proj_1/files/art_1",
      init: { method: "DELETE" },
      response: json(200, { ok: true }),
    });
    await expect(removeProjectFile("proj_1", "art_1")).resolves.toBeUndefined();
  });

  it("saves a download under the name the host sent, with its accents", async () => {
    const anchor = { href: "", download: "", click: vi.fn() };
    vi.stubGlobal("document", { createElement: () => anchor });
    vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined });
    calls.push({
      path: "/api/v1/artifacts/art_1/file",
      init: undefined,
      response: new Response("bytes", {
        status: 200,
        headers: {
          "Content-Disposition": "attachment; filename=\"Rencana.docx\"; filename*=UTF-8''Rencana%20Q4%C3%A9.docx",
        },
      }),
    });
    await downloadProjectFile("art_1", "fallback.docx");
    expect(anchor.download).toBe("Rencana Q4é.docx");
    expect(anchor.click).toHaveBeenCalledOnce();
  });

  it("falls back to the file's own name when the host sends none", async () => {
    const anchor = { href: "", download: "", click: vi.fn() };
    vi.stubGlobal("document", { createElement: () => anchor });
    vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined });
    calls.push({
      path: "/api/v1/artifacts/art_2/file",
      init: undefined,
      response: new Response("bytes", { status: 200 }),
    });
    await downloadProjectFile("art_2", "deck.pptx");
    expect(anchor.download).toBe("deck.pptx");
  });
});

describe("projects view rules", () => {
  const file = {
    id: "art_1",
    kind: "artifact" as const,
    title: "Deck",
    mime: "application/pdf",
    sizeBytes: 1,
    ownerUserId: "user_a",
    updatedAt: 1,
    previewUrl: null,
    downloadUrl: "/api/v1/artifacts/art_1/file",
  };
  const project = { ...PROJECT, createdBy: "user_b" };

  it("lets the file's maker or the Workspace's maker see Remove, and nobody else", () => {
    expect(canRemoveFile(file, project, "user_a")).toBe(true);
    expect(canRemoveFile(file, project, "user_b")).toBe(true);
    expect(canRemoveFile(file, project, "user_c")).toBe(false);
    expect(canRemoveFile(file, project, null)).toBe(false);
  });

  it("splits the list into the person's own Workspaces and the company's", () => {
    const mine = { ...PROJECT, id: "p1", createdBy: "user_me" };
    const theirs = { ...PROJECT, id: "p2", createdBy: "user_other", visibility: "workspace" as const };
    expect(splitProjects([mine, theirs], "user_me")).toEqual({ own: [mine], shared: [theirs] });
  });

  it("maps a file type from its mime, never from its name", () => {
    expect(fileKind("application/vnd.openxmlformats-officedocument.presentationml.presentation")).toBe("slides");
    expect(fileIconName("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("finance");
    expect(fileKind("application/octet-stream")).toBe("other");
  });

  it("writes sizes in bytes, KB and MB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
