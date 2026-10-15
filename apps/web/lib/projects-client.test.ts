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

import { apiFetch } from "./api-client";
import {
  addProjectFile,
  addProjectMedia,
  bringProjectAgent,
  createProject,
  downloadFile,
  handOverProject,
  inviteProjectMember,
  listInvitablePeople,
  listProjectFiles,
  listProjectPeople,
  listProjects,
  ProjectsError,
  removeProjectFile,
  removeProjectMedia,
  removeProjectMember,
  renameProject,
  setProjectMemberRole,
  takeOutProjectAgent,
  downloadProjectFile,
} from "./projects-client";
import { canRemoveFile, splitProjects, formatBytes, fileIconName, fileKind } from "./projects-view";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const PROJECT = {
  id: "proj_1",
  name: "Q4 plan",
  role: "owner",
  memberCount: 1,
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

  it("refuses a list whose role is not one of the three Workspace roles", async () => {
    calls.push({
      path: "/api/v1/projects",
      init: undefined,
      response: json(200, { items: [{ ...PROJECT, role: "superuser" }] }),
    });
    await expect(listProjects()).rejects.toMatchObject({ code: "projects_malformed", status: 502 });
  });

  it("reads the caller's role and the member count, and drops the old visibility word the host still sends", async () => {
    calls.push({
      path: "/api/v1/projects",
      init: undefined,
      response: json(200, { items: [{ ...PROJECT, role: "admin", memberCount: 3, visibility: "workspace" }] }),
    });
    expect(await listProjects()).toEqual([
      {
        id: "proj_1",
        name: "Q4 plan",
        role: "admin",
        memberCount: 3,
        createdBy: "user_me",
        createdAt: 1,
        updatedAt: 2,
      },
    ]);
  });

  it("creates a Workspace from a name only", async () => {
    calls.push({
      path: "/api/v1/projects",
      init: { method: "POST", body: JSON.stringify({ name: "Q4 plan" }) },
      response: json(201, { project: PROJECT }),
    });
    expect((await createProject("Q4 plan")).id).toBe("proj_1");
  });

  it("renames with a body that holds the name and nothing else, since the host refuses visibility", async () => {
    calls.push({
      path: "/api/v1/projects/proj_1",
      init: { method: "PATCH", body: JSON.stringify({ name: "Q1 plan" }) },
      response: json(200, { project: { ...PROJECT, name: "Q1 plan" } }),
    });
    expect((await renameProject("proj_1", "Q1 plan")).name).toBe("Q1 plan");
    expect(vi.mocked(apiFetch).mock.calls.at(-1)?.[1]?.body).toBe('{"name":"Q1 plan"}');
  });

  it("lists the members and the agents brought in", async () => {
    const member = { userId: "user_me", name: "Ana", role: "owner", addedBy: "user_me", addedAt: 5 };
    const agent = { agentId: "research", broughtBy: "user_me", addedAt: 6 };
    calls.push({
      path: "/api/v1/projects/proj_1/members",
      init: undefined,
      response: json(200, { members: [member], agents: [agent] }),
    });
    expect(await listProjectPeople("proj_1")).toEqual({ members: [member], agents: [agent] });
  });

  it("reads the colleagues a Workspace may invite, by id and name only", async () => {
    calls.push({
      path: "/api/v1/projects/proj_1/invitable",
      init: undefined,
      response: json(200, { items: [{ userId: "u_cara", name: "Cara", email: "cara@example.test" }] }),
    });
    expect(await listInvitablePeople("proj_1")).toEqual([{ userId: "u_cara", name: "Cara" }]);
  });

  it("sends each member and agent action to its own route, in the body shape the host reads", async () => {
    const members = [{ userId: "u b", name: "u b", role: "member", addedBy: "user_me", addedAt: 5 }];
    calls.push(
      {
        path: "/api/v1/projects/proj_1/members",
        init: { method: "POST", body: JSON.stringify({ userId: "u b" }) },
        response: json(201, { members }),
      },
      {
        path: "/api/v1/projects/proj_1/members/u%20b",
        init: { method: "PATCH", body: JSON.stringify({ role: "admin" }) },
        response: json(200, { ok: true }),
      },
      {
        path: "/api/v1/projects/proj_1/owner",
        init: { method: "POST", body: JSON.stringify({ userId: "u b" }) },
        response: json(200, { ok: true }),
      },
      { path: "/api/v1/projects/proj_1/members/u%20b", init: { method: "DELETE" }, response: json(200, { ok: true }) },
      {
        path: "/api/v1/projects/proj_1/agents",
        init: { method: "POST", body: JSON.stringify({ agentId: "research" }) },
        response: json(201, { agents: [{ agentId: "research", broughtBy: "user_me", addedAt: 7 }] }),
      },
      {
        path: "/api/v1/projects/proj_1/agents/research",
        init: { method: "DELETE" },
        response: json(200, { ok: true }),
      },
    );
    expect(await inviteProjectMember("proj_1", "u b")).toEqual(members);
    await setProjectMemberRole("proj_1", "u b", "admin");
    await handOverProject("proj_1", "u b");
    await removeProjectMember("proj_1", "u b");
    expect(await bringProjectAgent("proj_1", "research")).toEqual([
      { agentId: "research", broughtBy: "user_me", addedAt: 7 },
    ]);
    await takeOutProjectAgent("proj_1", "research");
    expect(calls).toEqual([]);
  });

  it("keeps the host's 404 for an id that is not a person of the company", async () => {
    calls.push({
      path: "/api/v1/projects/proj_1/members",
      init: { method: "POST", body: JSON.stringify({ userId: "nobody" }) },
      response: json(404, { error: { code: "not_found", message: "Not found" } }),
    });
    await expect(inviteProjectMember("proj_1", "nobody")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
      message: "Not found",
    });
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
  it("lets the file's maker, or the Workspace's owner or an admin, see Remove, and no other member", () => {
    const asMember = { ...PROJECT, role: "member" as const };
    expect(canRemoveFile(file, asMember, "user_a")).toBe(true);
    expect(canRemoveFile(file, asMember, "user_c")).toBe(false);
    expect(canRemoveFile(file, { ...PROJECT, role: "admin" }, "user_c")).toBe(true);
    expect(canRemoveFile(file, { ...PROJECT, role: "owner" }, "user_c")).toBe(true);
    expect(canRemoveFile(file, { ...PROJECT, role: "owner" }, null)).toBe(false);
  });

  it("splits the list into the Workspaces the person owns and the ones shared with them", () => {
    const mine = { ...PROJECT, id: "p1", role: "owner" as const };
    const adminOf = { ...PROJECT, id: "p2", role: "admin" as const, createdBy: "user_other" };
    const memberOf = { ...PROJECT, id: "p3", role: "member" as const, createdBy: "user_other" };
    expect(splitProjects([mine, adminOf, memberOf])).toEqual({ own: [mine], shared: [adminOf, memberOf] });
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
