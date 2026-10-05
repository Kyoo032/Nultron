/**
 * The folder client is the renderer half of `packages/host/src/folder-root/routes.ts`. What is held
 * here: the seven calls hit the right method and path with the right body, every host answer is
 * validated before a component sees it, and a refusal becomes a typed code (never a throw, never the
 * host's English).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(),
}));

vi.mock("./api-client", () => ({ apiFetch }));

import {
  approveProposal,
  errorCodeOf,
  fetchFolderStatus,
  fetchProposalDiff,
  listPendingProposals,
  mountFolder,
  parseApproveOutcome,
  parseFolderStatus,
  parseProposalDiff,
  parseProposalList,
  rejectProposal,
  unmountFolder,
} from "./folder-api";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  apiFetch.mockReset();
});

describe("parseFolderStatus", () => {
  it("reads the three fields and keeps a name only while a folder is open", () => {
    expect(parseFolderStatus({ available: true, mounted: true, name: "notes" })).toEqual({
      available: true,
      mounted: true,
      name: "notes",
    });
    expect(parseFolderStatus({ available: true, mounted: false, name: "stale" })).toEqual({
      available: true,
      mounted: false,
      name: null,
    });
    expect(parseFolderStatus({ available: false, mounted: false, name: null })).toEqual({
      available: false,
      mounted: false,
      name: null,
    });
  });

  it("refuses an answer that is not the status shape", () => {
    expect(parseFolderStatus(null)).toBeNull();
    expect(parseFolderStatus({ available: "yes", mounted: false })).toBeNull();
    expect(parseFolderStatus({ mounted: true })).toBeNull();
    expect(parseFolderStatus([])).toBeNull();
  });
});

describe("parseProposalList", () => {
  it("keeps well-formed proposals and drops the rest", () => {
    const list = parseProposalList({
      items: [
        {
          id: "p1",
          path: "notes/plan.md",
          kind: "write",
          status: "pending",
          runId: "r",
          createdAt: 1,
          decidedAt: null,
        },
        { id: "p2", path: "old.txt", kind: "delete", status: "pending" },
        { id: "p3", path: "x", kind: "rename", status: "pending" },
        { id: "p4", path: "x", kind: "write", status: "weird" },
        { path: "no-id", kind: "write", status: "pending" },
        "nope",
      ],
    });
    expect(list).toEqual([
      { id: "p1", path: "notes/plan.md", kind: "write", status: "pending" },
      { id: "p2", path: "old.txt", kind: "delete", status: "pending" },
    ]);
  });

  it("refuses a body without an items array", () => {
    expect(parseProposalList({})).toBeNull();
    expect(parseProposalList({ items: "x" })).toBeNull();
  });
});

describe("parseProposalDiff", () => {
  it("requires both texts and reads stale as a strict boolean", () => {
    const body = { id: "p1", path: "a.txt", kind: "write", status: "pending", before: "a", after: "b", stale: true };
    expect(parseProposalDiff(body)).toEqual({ ...body });
    expect(parseProposalDiff({ ...body, stale: "true" })?.stale).toBe(false);
    expect(parseProposalDiff({ ...body, before: undefined })).toBeNull();
    expect(parseProposalDiff({ ...body, after: 3 })).toBeNull();
  });
});

describe("parseApproveOutcome", () => {
  it("reads applied, stale and failed with its reason", () => {
    expect(parseApproveOutcome({ id: "p", status: "applied" })).toEqual({ status: "applied" });
    expect(parseApproveOutcome({ id: "p", status: "stale" })).toEqual({ status: "stale" });
    expect(parseApproveOutcome({ id: "p", status: "failed", reason: "denied" })).toEqual({
      status: "failed",
      reason: "denied",
    });
    expect(parseApproveOutcome({ id: "p", status: "failed", reason: "anything" })).toEqual({
      status: "failed",
      reason: "io_error",
    });
    expect(parseApproveOutcome({ id: "p", status: "approved" })).toBeNull();
    expect(parseApproveOutcome(null)).toBeNull();
  });
});

describe("errorCodeOf", () => {
  it("takes the code from the host envelope and maps anything unknown to unknown", () => {
    expect(errorCodeOf({ error: { code: "folder_mount_refused", message: "That folder does not exist." } })).toBe(
      "folder_mount_refused",
    );
    expect(errorCodeOf({ error: { code: "proposal_not_pending" } })).toBe("proposal_not_pending");
    expect(errorCodeOf({ error: { code: "something_new" } })).toBe("unknown");
    expect(errorCodeOf({ error: "gateway_blocked" })).toBe("unknown");
    expect(errorCodeOf(null)).toBe("unknown");
  });
});

describe("the calls", () => {
  it("reads the status with a plain GET", async () => {
    apiFetch.mockResolvedValue(json({ available: true, mounted: true, name: "notes" }));
    const result = await fetchFolderStatus();
    expect(apiFetch).toHaveBeenCalledWith("/api/v1/folder", {});
    expect(result).toEqual({ ok: true, value: { available: true, mounted: true, name: "notes" } });
  });

  it("mounts by POSTing the picked path once, as JSON", async () => {
    apiFetch.mockResolvedValue(json({ available: true, mounted: true, name: "notes" }));
    const result = await mountFolder("C:\\Users\\me\\notes");
    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetch.mock.calls[0] ?? [];
    expect(path).toBe("/api/v1/folder/mount");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ path: "C:\\Users\\me\\notes" });
    expect(result.ok).toBe(true);
    // What came back to the renderer carries the name only.
    expect(JSON.stringify(result)).not.toContain("Users");
  });

  it("turns a refused mount into its code", async () => {
    apiFetch.mockResolvedValue(
      json({ error: { code: "folder_mount_refused", message: "Your whole home folder cannot be opened." } }, 400),
    );
    expect(await mountFolder("C:\\Users\\me")).toEqual({ ok: false, code: "folder_mount_refused", status: 400 });
    apiFetch.mockResolvedValue(json({ error: { code: "folder_mount_ipc_only", message: "x" } }, 403));
    expect(await mountFolder("/tmp/a")).toEqual({ ok: false, code: "folder_mount_ipc_only", status: 403 });
    apiFetch.mockResolvedValue(json({ error: { code: "folder_unavailable", message: "x" } }, 403));
    expect(await mountFolder("/tmp/a")).toEqual({ ok: false, code: "folder_unavailable", status: 403 });
  });

  it("unmounts with DELETE and reads ok:true", async () => {
    apiFetch.mockResolvedValue(json({ ok: true }));
    expect(await unmountFolder()).toEqual({ ok: true, value: true });
    expect(apiFetch).toHaveBeenCalledWith("/api/v1/folder/mount", { method: "DELETE" });
  });

  it("lists only pending proposals", async () => {
    apiFetch.mockResolvedValue(json({ items: [{ id: "p1", path: "a", kind: "write", status: "pending" }] }));
    const result = await listPendingProposals();
    expect(apiFetch).toHaveBeenCalledWith("/api/v1/folder/proposals?status=pending", {});
    expect(result).toEqual({ ok: true, value: [{ id: "p1", path: "a", kind: "write", status: "pending" }] });
  });

  it("encodes the id into the diff, approve and reject paths", async () => {
    apiFetch.mockResolvedValue(json({}));
    await fetchProposalDiff("a/b c");
    await approveProposal("a/b c");
    await rejectProposal("a/b c");
    expect(apiFetch.mock.calls.map(([path, init]) => [path, init?.method ?? "GET"])).toEqual([
      ["/api/v1/folder/proposals/a%2Fb%20c", "GET"],
      ["/api/v1/folder/proposals/a%2Fb%20c/approve", "POST"],
      ["/api/v1/folder/proposals/a%2Fb%20c/reject", "POST"],
    ]);
  });

  it("returns the approve outcome the host gave", async () => {
    apiFetch.mockResolvedValue(json({ id: "p1", status: "stale" }));
    expect(await approveProposal("p1")).toEqual({ ok: true, value: { status: "stale" } });
  });

  it("reads a 409 on approve as proposal_not_pending", async () => {
    apiFetch.mockResolvedValue(json({ error: { code: "proposal_not_pending", message: "decided" } }, 409));
    expect(await approveProposal("p1")).toEqual({ ok: false, code: "proposal_not_pending", status: 409 });
  });

  it("turns a transport failure into network, not a throw", async () => {
    apiFetch.mockRejectedValue(new Error("boom"));
    expect(await fetchFolderStatus()).toEqual({ ok: false, code: "network", status: 0 });
  });

  it("turns an unreadable or unrecognised answer into unknown", async () => {
    apiFetch.mockResolvedValue(new Response("<html>", { status: 200 }));
    expect(await fetchFolderStatus()).toEqual({ ok: false, code: "unknown", status: 200 });
    apiFetch.mockResolvedValue(json({ hello: "world" }));
    expect(await approveProposal("p1")).toEqual({ ok: false, code: "unknown", status: 200 });
  });

  it("reads a host without the routes (404) as a failure, not as a folder", async () => {
    apiFetch.mockResolvedValue(json({ error: { code: "not_found", message: "Not found" } }, 404));
    expect(await fetchFolderStatus()).toEqual({ ok: false, code: "not_found", status: 404 });
  });
});
