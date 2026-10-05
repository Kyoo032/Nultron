import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FileAuthor, FileRoot } from "@agentforge/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveProposal, getProposalDiff, listProposals, rejectProposal } from "./decisions";
import { createFolderRoot } from "./folder-root";
import { clearMount, mountFilePath } from "./mount-record";
import { mountFolder, unmountFolder } from "./mount-service";
import { DESK_A, DESK_B, makeSandbox, openProposalsFixture, type ProposalsFixture, type Sandbox } from "./test-support";

const AGENT: FileAuthor = { kind: "agent", runId: "run-1", mode: "chat" };

let box: Sandbox;
let fx: ProposalsFixture;
let root: FileRoot;

function deps() {
  return { store: fx.store };
}

async function propose(rel: string, content: string): Promise<string> {
  const outcome = await root.write(rel as never, content, AGENT);
  if (outcome.status !== "pending_approval") {
    throw new Error("expected a pending proposal");
  }
  return outcome.proposalId;
}

async function proposeDelete(rel: string): Promise<string> {
  const outcome = await root.remove(rel as never, AGENT);
  if (outcome.status !== "pending_approval") {
    throw new Error("expected a pending proposal");
  }
  return outcome.proposalId;
}

function statusOf(id: string): string | undefined {
  return (fx.db.prepare("SELECT status FROM file_proposals WHERE id = ?").get(id) as { status: string } | undefined)
    ?.status;
}

function insertRaw(id: string, relPath: string, kind: "write" | "delete", beforeSha256: string | null): void {
  fx.db
    .prepare(
      `INSERT INTO file_proposals (id, workspace_id, run_id, path, kind, before_sha256, after_body, status, created_at, decided_at)
       VALUES (?, 'desk-a', 'run-x', ?, ?, ?, NULL, 'pending', 1, NULL)`,
    )
    .run(id, relPath, kind, beforeSha256);
}

beforeEach(async () => {
  box = makeSandbox();
  fx = openProposalsFixture();
  await mountFolder(DESK_A, box.folder, deps());
  const made = await createFolderRoot(DESK_A, AGENT, deps());
  if ("ok" in made) {
    throw new Error(`root was refused: ${made.code}`);
  }
  root = made;
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(mountFilePath(), { force: true });
  fx.db.close();
  box.dispose();
});

async function codeOf(promise: Promise<unknown>): Promise<{ code?: string; status?: number }> {
  try {
    await promise;
  } catch (error) {
    return { code: (error as { code?: string }).code, status: (error as { status?: number }).status };
  }
  return {};
}

describe("approve", () => {
  it("writes the proposed text, marks the proposal applied and leaves no temp file behind", async () => {
    box.put("a.txt", "old");
    const id = await propose("a.txt", "new text");
    expect(readFileSync(path.join(box.folder, "a.txt"), "utf8")).toBe("old");
    expect(await approveProposal(DESK_A, id, deps())).toEqual({ id, status: "applied" });
    expect(readFileSync(path.join(box.folder, "a.txt"), "utf8")).toBe("new text");
    expect(readdirSync(box.folder)).toEqual(["a.txt"]);
    const row = fx.db.prepare("SELECT status, decided_at FROM file_proposals WHERE id = ?").get(id) as {
      status: string;
      decided_at: number;
    };
    expect(row.status).toBe("applied");
    expect(row.decided_at).toEqual(expect.any(Number));
  });

  it("creates a new file and its missing folders", async () => {
    const id = await propose("docs/new/page.md", "# Title\n");
    expect(await approveProposal(DESK_A, id, deps())).toEqual({ id, status: "applied" });
    expect(readFileSync(path.join(box.folder, "docs", "new", "page.md"), "utf8")).toBe("# Title\n");
  });

  it("writes the exact bytes, including a byte-order mark and CRLF line ends", async () => {
    const id = await propose("crlf.txt", "﻿one\r\ntwo\r\n");
    await approveProposal(DESK_A, id, deps());
    expect([...readFileSync(path.join(box.folder, "crlf.txt"))]).toEqual([
      0xef, 0xbb, 0xbf, 0x6f, 0x6e, 0x65, 0x0d, 0x0a, 0x74, 0x77, 0x6f, 0x0d, 0x0a,
    ]);
  });

  it("applies once: a second approval is refused and does not write again", async () => {
    box.put("a.txt", "old");
    const id = await propose("a.txt", "new");
    await approveProposal(DESK_A, id, deps());
    writeFileSync(path.join(box.folder, "a.txt"), "edited by the owner afterwards");
    expect(await codeOf(approveProposal(DESK_A, id, deps()))).toEqual({ code: "proposal_not_pending", status: 409 });
    expect(readFileSync(path.join(box.folder, "a.txt"), "utf8")).toBe("edited by the owner afterwards");
  });

  it("applies once when two approvals race", async () => {
    box.put("a.txt", "old");
    const id = await propose("a.txt", "new");
    const results = await Promise.allSettled([
      approveProposal(DESK_A, id, deps()),
      approveProposal(DESK_A, id, deps()),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(readFileSync(path.join(box.folder, "a.txt"), "utf8")).toBe("new");
  });

  it("answers stale and writes nothing when the file changed after the proposal", async () => {
    box.put("a.txt", "old");
    const id = await propose("a.txt", "new");
    writeFileSync(path.join(box.folder, "a.txt"), "changed on disk");
    expect(await approveProposal(DESK_A, id, deps())).toEqual({ id, status: "stale" });
    expect(readFileSync(path.join(box.folder, "a.txt"), "utf8")).toBe("changed on disk");
    expect(statusOf(id)).toBe("stale");
  });

  it("answers stale when a file now exists where the proposal expected none", async () => {
    const id = await propose("fresh.txt", "mine");
    writeFileSync(path.join(box.folder, "fresh.txt"), "theirs");
    expect(await approveProposal(DESK_A, id, deps())).toEqual({ id, status: "stale" });
    expect(readFileSync(path.join(box.folder, "fresh.txt"), "utf8")).toBe("theirs");
  });

  it("answers stale when the file was deleted after the proposal", async () => {
    box.put("a.txt", "old");
    const id = await propose("a.txt", "new");
    rmSync(path.join(box.folder, "a.txt"));
    expect(await approveProposal(DESK_A, id, deps())).toEqual({ id, status: "stale" });
    expect(existsSync(path.join(box.folder, "a.txt"))).toBe(false);
  });

  it("answers stale when the file grew past the limit after the proposal", async () => {
    box.put("a.txt", "old");
    const id = await propose("a.txt", "new");
    writeFileSync(path.join(box.folder, "a.txt"), "x".repeat(2 * 1024 * 1024 + 5));
    expect((await approveProposal(DESK_A, id, deps())).status).toBe("stale");
  });

  it("is refused with not_found for an id that does not exist", async () => {
    expect(await codeOf(approveProposal(DESK_A, "no-such-id", deps()))).toEqual({ code: "not_found", status: 404 });
  });

  it("is refused, leaving the proposal pending, when the desk has no folder any more", async () => {
    const id = await propose("a.txt", "x");
    clearMount(DESK_A.workspaceId);
    expect(await codeOf(approveProposal(DESK_A, id, deps()))).toEqual({ code: "folder_not_mounted", status: 409 });
    expect(statusOf(id)).toBe("pending");
  });
});

describe("approve a delete", () => {
  it("removes the file", async () => {
    box.put("gone.txt", "bye");
    const id = await proposeDelete("gone.txt");
    expect(existsSync(path.join(box.folder, "gone.txt"))).toBe(true);
    expect(await approveProposal(DESK_A, id, deps())).toEqual({ id, status: "applied" });
    expect(existsSync(path.join(box.folder, "gone.txt"))).toBe(false);
  });

  it("answers stale and keeps the file when it changed after the proposal", async () => {
    box.put("gone.txt", "bye");
    const id = await proposeDelete("gone.txt");
    writeFileSync(path.join(box.folder, "gone.txt"), "edited");
    expect(await approveProposal(DESK_A, id, deps())).toEqual({ id, status: "stale" });
    expect(readFileSync(path.join(box.folder, "gone.txt"), "utf8")).toBe("edited");
  });

  it("answers stale when the file is already gone", async () => {
    box.put("gone.txt", "bye");
    const id = await proposeDelete("gone.txt");
    rmSync(path.join(box.folder, "gone.txt"));
    expect(await approveProposal(DESK_A, id, deps())).toEqual({ id, status: "stale" });
  });
});

describe("a failed apply", () => {
  it("is marked failed with a fixed reason and names no path", async () => {
    const id = await propose("sub/new.txt", "x");
    writeFileSync(path.join(box.folder, "sub"), "a file where a folder must go");
    const outcome = await approveProposal(DESK_A, id, deps());
    expect(outcome).toEqual({ id, status: "failed", reason: "denied" });
    expect(JSON.stringify(outcome)).not.toContain(box.base);
    expect(statusOf(id)).toBe("failed");
  });

  it("refuses a tampered path that leaves the folder, and writes nothing outside it", async () => {
    insertRaw("tampered-1", "../outside/pwned.txt", "write", null);
    const outcome = await approveProposal(DESK_A, "tampered-1", deps());
    expect(outcome).toEqual({ id: "tampered-1", status: "failed", reason: "denied" });
    expect(readdirSync(box.outside)).toEqual([]);
  });

  it("refuses a tampered proposal for a denied name", async () => {
    insertRaw("tampered-2", ".env", "write", null);
    expect(await approveProposal(DESK_A, "tampered-2", deps())).toEqual({
      id: "tampered-2",
      status: "failed",
      reason: "denied",
    });
    expect(existsSync(path.join(box.folder, ".env"))).toBe(false);
  });
});

describe("reject", () => {
  it("records the decision and leaves the disk alone", async () => {
    box.put("a.txt", "old");
    const id = await propose("a.txt", "new");
    expect(await rejectProposal(DESK_A, id, deps())).toEqual({ id, status: "rejected" });
    expect(readFileSync(path.join(box.folder, "a.txt"), "utf8")).toBe("old");
    expect(statusOf(id)).toBe("rejected");
    expect(await codeOf(approveProposal(DESK_A, id, deps()))).toEqual({ code: "proposal_not_pending", status: 409 });
    expect(await codeOf(rejectProposal(DESK_A, id, deps()))).toEqual({ code: "proposal_not_pending", status: 409 });
  });

  it("cannot reject what was already applied", async () => {
    const id = await propose("a.txt", "x");
    await approveProposal(DESK_A, id, deps());
    expect(await codeOf(rejectProposal(DESK_A, id, deps()))).toEqual({ code: "proposal_not_pending", status: 409 });
  });
});

describe("list and diff", () => {
  it("lists a desk's proposals, newest first, filtered by status", async () => {
    const first = await propose("a.txt", "1");
    const second = await propose("b.txt", "2");
    await rejectProposal(DESK_A, first, deps());
    const all = await listProposals(DESK_A, undefined, deps());
    expect(all.map((item) => [item.id, item.path, item.kind, item.status, item.runId])).toEqual([
      [second, "b.txt", "write", "pending", "run-1"],
      [first, "a.txt", "write", "rejected", "run-1"],
    ]);
    expect((await listProposals(DESK_A, "pending", deps())).map((item) => item.id)).toEqual([second]);
    expect(JSON.stringify(all)).not.toContain("afterBody");
  });

  it("returns the current text beside the proposed text", async () => {
    box.put("a.txt", "old\n");
    const id = await propose("a.txt", "new\n");
    expect(await getProposalDiff(DESK_A, id, deps())).toEqual({
      id,
      path: "a.txt",
      kind: "write",
      status: "pending",
      before: "old\n",
      after: "new\n",
      stale: false,
    });
    writeFileSync(path.join(box.folder, "a.txt"), "moved on\n");
    expect(await getProposalDiff(DESK_A, id, deps())).toMatchObject({
      before: "moved on\n",
      after: "new\n",
      stale: true,
    });
  });

  it("shows an empty before for a new file and an empty after for a delete", async () => {
    const created = await propose("fresh.txt", "hello");
    expect(await getProposalDiff(DESK_A, created, deps())).toMatchObject({ before: "", after: "hello", stale: false });
    box.put("gone.txt", "bye");
    const deleted = await proposeDelete("gone.txt");
    expect(await getProposalDiff(DESK_A, deleted, deps())).toMatchObject({
      kind: "delete",
      before: "bye",
      after: "",
      stale: false,
    });
  });
});

describe("desks", () => {
  it("answers not_found for another desk's proposal on every decision", async () => {
    box.put("a.txt", "old");
    const id = await propose("a.txt", "new");
    const notFound = { code: "not_found", status: 404 };
    expect(await codeOf(getProposalDiff(DESK_B, id, deps()))).toEqual(notFound);
    expect(await codeOf(approveProposal(DESK_B, id, deps()))).toEqual(notFound);
    expect(await codeOf(rejectProposal(DESK_B, id, deps()))).toEqual(notFound);
    expect(await listProposals(DESK_B, undefined, deps())).toEqual([]);
    expect(statusOf(id)).toBe("pending");
    expect(readFileSync(path.join(box.folder, "a.txt"), "utf8")).toBe("old");
  });

  it("keeps one pending proposal per path per desk, not per path overall", async () => {
    await propose("a.txt", "one");
    const otherBox = makeSandbox();
    try {
      await mountFolder(DESK_B, otherBox.folder, deps());
      const other = await createFolderRoot(DESK_B, AGENT, deps());
      if ("ok" in other) {
        throw new Error("expected a root");
      }
      await other.write("a.txt" as never, "two", AGENT);
      expect(fx.db.prepare("SELECT COUNT(*) AS n FROM file_proposals WHERE status = 'pending'").get()).toEqual({
        n: 2,
      });
    } finally {
      otherBox.dispose();
    }
  });
});

describe("mount changes", () => {
  it("rejects pending proposals when the folder is unmounted", async () => {
    const id = await propose("a.txt", "x");
    await unmountFolder(DESK_A, deps());
    expect(statusOf(id)).toBe("rejected");
  });

  it("rejects pending proposals when a different folder is picked, and keeps them for the same one", async () => {
    const id = await propose("a.txt", "x");
    await mountFolder(DESK_A, box.folder, deps());
    expect(statusOf(id)).toBe("pending");
    const elsewhere = path.join(box.base, "elsewhere");
    mkdirSync(elsewhere);
    await mountFolder(DESK_A, elsewhere, deps());
    expect(statusOf(id)).toBe("rejected");
  });
});

describe("server mode", () => {
  it("refuses every decision with folder_unavailable", async () => {
    const id = await propose("a.txt", "x");
    vi.stubEnv("AGENTFORGE_SERVER", "1");
    const unavailable = { code: "folder_unavailable", status: 403 };
    expect(await codeOf(listProposals(DESK_A, undefined, deps()))).toEqual(unavailable);
    expect(await codeOf(getProposalDiff(DESK_A, id, deps()))).toEqual(unavailable);
    expect(await codeOf(approveProposal(DESK_A, id, deps()))).toEqual(unavailable);
    expect(await codeOf(rejectProposal(DESK_A, id, deps()))).toEqual(unavailable);
    expect(await codeOf(mountFolder(DESK_A, box.folder, deps()))).toEqual(unavailable);
    expect(await codeOf(unmountFolder(DESK_A, deps()))).toEqual(unavailable);
    expect(statusOf(id)).toBe("pending");
  });
});
