import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, ensurePortalOwner, sql } from "@agentforge/db";
import type { TenantContext } from "@agentforge/core";
import { replaceSection, type Section } from "../doc-model";
import { createDocumentForTenant } from "../doc-tools/create-document";
import { sampleDocInput } from "../doc-tools/doc-tools-fixtures";
import { addProjectMember, createProject, removeProjectMember } from "../projects/service";
import { setFileProject } from "../projects/store";
import "../tenant-storage-db";
import { getTenant } from "../tenant";
import { pendingBaseVersions } from "./pending-bases";
import { createDocVersionStore, docVersionStore } from "./store";
import { createProposalStore, proposalStore } from "./proposals";
import type { AppendVersionInput } from "./types";

process.env.AGENTFORGE_SECRETS_KEY = "9c2e4a6b8d0f1a3c5e7b9d1f3a5c7e9b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a1c";
process.env.AGENTFORGE_SERVER = "1";

const TENANT = "doc-proposals-partner";
const DAY_MS = 24 * 60 * 60 * 1000;

let alice: TenantContext;
let ben: TenantContext;
let cara: TenantContext;
let dina: TenantContext;
let erik: TenantContext;

async function person(orgId: string, userId: string, role: "owner" | "member"): Promise<TenantContext> {
  await ensurePortalOwner(db, { tenantId: TENANT, orgId, userId, role });
  return getTenant({ session: { id: `session-${userId}`, tenantId: TENANT, orgId, userId } });
}

async function workspaceDocument(): Promise<{ projectId: string; artifactId: string }> {
  const project = createProject(alice, { name: `Room ${Math.random()}` });
  addProjectMember(alice, project.id, "ben");
  const made = await createDocumentForTenant({ format: "docx", spec: sampleDocInput() }, alice);
  if (!made.ok) {
    throw new Error(made.message);
  }
  setFileProject(alice, made.artifactId, project.id);
  return { projectId: project.id, artifactId: made.artifactId };
}

function section(id: string, text: string): Section {
  return { id, heading: id, blocks: [{ type: "paragraph", text }] };
}

function rewrite(id: string, text: string, baseVersion: number): AppendVersionInput {
  return {
    baseVersion,
    author: { kind: "person" },
    edit: (head) => {
      if (head.kind !== "document") {
        throw new Error("a document");
      }
      return { kind: "document", spec: replaceSection(head.spec, id, section(id, text)) };
    },
  };
}

function statusOf(proposalId: string): string | undefined {
  return (
    sql.prepare("SELECT status FROM doc_proposals WHERE id = ?").get(proposalId) as { status: string } | undefined
  )?.status;
}

function proposalOrThrow<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) {
    throw new Error(`expected a proposal, got ${JSON.stringify(result)}`);
  }
  return result as Extract<T, { ok: true }>;
}

beforeAll(async () => {
  alice = await person("org-1", "alice", "owner");
  ben = await person("org-1", "ben", "member");
  cara = await person("org-1", "cara", "member");
  dina = await person("org-1", "dina", "member");
  erik = await person("org-2", "erik", "owner");
});

afterAll(() => {
  delete process.env.AGENTFORGE_SERVER;
  sql.close();
});

describe("one pending proposal per section", () => {
  it("holds one pending row for each section, and lets two sections be pending together", async () => {
    const { artifactId } = await workspaceDocument();
    const store = proposalStore();
    const numbers = store.createProposal(ben, artifactId, {
      sectionId: "numbers",
      section: section("numbers", "Ben's numbers"),
      baseVersion: 1,
      agentId: "documents",
    });
    store.createProposal(ben, artifactId, {
      sectionId: "intro",
      section: section("intro", "An intro"),
      baseVersion: 1,
      agentId: "documents",
    });
    expect(numbers.ok).toBe(true);
    expect(store.listPending(ben, artifactId)?.map((proposal) => proposal.sectionId)).toEqual(["numbers", "intro"]);
    expect(() =>
      sql
        .prepare(
          "INSERT INTO doc_proposals (id, workspace_id, artifact_id, section_id, base_version, section, agent_id, asked_by_user_id, status, kept_version, created_at, updated_at) VALUES ('raw', ?, ?, 'numbers', 1, '{}', 'documents', 'ben', 'pending', NULL, 1, 1)",
        )
        .run(ben.workspaceId, artifactId),
    ).toThrow(/UNIQUE/);
  });

  it("a retry replaces the pending proposal for that section and keeps the old one as discarded", async () => {
    const { artifactId } = await workspaceDocument();
    const store = proposalStore();
    const first = proposalOrThrow(
      store.createProposal(ben, artifactId, {
        sectionId: "numbers",
        section: section("numbers", "try one"),
        baseVersion: 1,
        agentId: "documents",
      }),
    );
    const second = proposalOrThrow(
      store.createProposal(ben, artifactId, {
        sectionId: "numbers",
        section: section("numbers", "try two"),
        baseVersion: 1,
        agentId: "documents",
      }),
    );
    const pending = store.listPending(ben, artifactId);
    expect(pending?.map((proposal) => proposal.id)).toEqual([second.proposal.id]);
    expect(pending?.[0]?.section).toEqual(section("numbers", "try two"));
    expect(statusOf(first.proposal.id)).toBe("discarded");
    expect(store.discard(ben, first.proposal.id)).toEqual({ ok: false, reason: "not_pending" });
  });

  it("refuses a base outside the history, a section the document does not have, and a missing artifact", async () => {
    const { artifactId } = await workspaceDocument();
    const store = proposalStore();
    expect(
      store.createProposal(ben, artifactId, {
        sectionId: "intro",
        section: section("intro", "x"),
        baseVersion: 9,
        agentId: "documents",
      }),
    ).toEqual({ ok: false, reason: "bad_base" });
    expect(
      store.createProposal(ben, artifactId, {
        sectionId: "no-such-section",
        section: section("no-such-section", "x"),
        baseVersion: 1,
        agentId: "documents",
      }),
    ).toEqual({ ok: false, reason: "bad_section" });
    expect(
      store.createProposal(ben, "not-an-artifact", {
        sectionId: "intro",
        section: section("intro", "x"),
        baseVersion: 1,
        agentId: "documents",
      }),
    ).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("keeping a proposal", () => {
  it("writes a version that replaces only that section, attributed to the agent and to the person who asked", async () => {
    const { artifactId } = await workspaceDocument();
    const versions = docVersionStore();
    const store = proposalStore();
    versions.ensureFirstVersion(alice, artifactId);
    const made = proposalOrThrow(
      store.createProposal(ben, artifactId, {
        sectionId: "numbers",
        section: section("numbers", "The agent's numbers"),
        baseVersion: 1,
        agentId: "documents",
      }),
    );

    const kept = store.keep(alice, made.proposal.id);
    expect(kept).toMatchObject({ ok: true, proposal: { status: "kept", keptVersion: 2 } });
    expect(versions.listVersions(alice, artifactId)?.[0]).toMatchObject({
      version: 2,
      changedSectionIds: ["numbers"],
      baseVersion: 1,
      author: { kind: "agent", agentId: "documents", askedByUserId: "ben" },
    });
    const head = versions.getVersion(alice, artifactId, 2)?.spec;
    expect(head?.kind === "document" ? head.spec.sections.map((part) => part.id) : []).toEqual([
      "intro",
      "numbers",
      "close",
    ]);
    expect(
      head?.kind === "document" ? head.spec.sections.find((part) => part.id === "numbers")?.blocks[0] : undefined,
    ).toEqual({ type: "paragraph", text: "The agent's numbers" });
    expect(store.listPending(alice, artifactId)).toEqual([]);
    expect(store.keep(alice, made.proposal.id)).toEqual({ ok: false, reason: "not_pending" });
  });

  it("refuses section_changed when another person changed the section after the base, and leaves the proposal pending", async () => {
    const { artifactId } = await workspaceDocument();
    const versions = docVersionStore();
    const store = proposalStore();
    versions.ensureFirstVersion(alice, artifactId);
    const made = proposalOrThrow(
      store.createProposal(ben, artifactId, {
        sectionId: "numbers",
        section: section("numbers", "The agent's numbers"),
        baseVersion: 1,
        agentId: "documents",
      }),
    );
    expect(versions.appendVersion(alice, artifactId, rewrite("numbers", "Alice took it", 1))).toMatchObject({
      ok: true,
      head: { version: 2 },
    });

    expect(store.keep(alice, made.proposal.id)).toEqual({
      ok: false,
      reason: "section_changed",
      sectionIds: ["numbers"],
    });
    expect(statusOf(made.proposal.id)).toBe("pending");
    expect(store.listPending(alice, artifactId)?.map((proposal) => proposal.id)).toEqual([made.proposal.id]);
    expect(versions.listVersions(alice, artifactId)?.map((version) => version.version)).toEqual([2, 1]);
  });

  it("refuses section_changed when the section was removed after the base", async () => {
    const { artifactId } = await workspaceDocument();
    const versions = docVersionStore();
    const store = proposalStore();
    versions.ensureFirstVersion(alice, artifactId);
    const made = proposalOrThrow(
      store.createProposal(ben, artifactId, {
        sectionId: "close",
        section: section("close", "The agent's close"),
        baseVersion: 1,
        agentId: "documents",
      }),
    );
    expect(
      versions.appendVersion(alice, artifactId, {
        baseVersion: 1,
        author: { kind: "person" },
        edit: (head) =>
          head.kind === "document"
            ? { kind: "document", spec: { ...head.spec, sections: head.spec.sections.slice(0, 2) } }
            : head,
      }),
    ).toMatchObject({ ok: true, head: { version: 2 } });

    expect(store.keep(alice, made.proposal.id)).toEqual({
      ok: false,
      reason: "section_changed",
      sectionIds: ["close"],
    });
    expect(statusOf(made.proposal.id)).toBe("pending");
  });
});

describe("discarding a proposal", () => {
  it("marks it discarded once; a second discard or a keep after it is refused as not pending", async () => {
    const { artifactId } = await workspaceDocument();
    const store = proposalStore();
    const made = proposalOrThrow(
      store.createProposal(ben, artifactId, {
        sectionId: "intro",
        section: section("intro", "Not wanted"),
        baseVersion: 1,
        agentId: "documents",
      }),
    );
    expect(store.discard(ben, made.proposal.id)).toMatchObject({ ok: true, proposal: { status: "discarded" } });
    expect(store.listPending(ben, artifactId)).toEqual([]);
    expect(store.discard(ben, made.proposal.id)).toEqual({ ok: false, reason: "not_pending" });
    expect(store.keep(alice, made.proposal.id)).toEqual({ ok: false, reason: "not_pending" });
  });
});

describe("the cap spares the base of a pending proposal", () => {
  it("keeps the base of a pending proposal through prunes, and the proposal can still be kept", async () => {
    const { artifactId } = await workspaceDocument();
    let clock = Date.UTC(2026, 0, 1);
    const versions = createDocVersionStore({
      db: sql,
      now: () => clock,
      cap: { keepNewest: 1, keepDays: 1 },
      protectedVersions: pendingBaseVersions(sql),
    });
    const store = createProposalStore({ db: sql, docVersions: versions, now: () => clock });
    versions.ensureFirstVersion(alice, artifactId);
    const made = proposalOrThrow(
      store.createProposal(ben, artifactId, {
        sectionId: "intro",
        section: section("intro", "The agent's intro"),
        baseVersion: 1,
        agentId: "documents",
      }),
    );
    for (const [index, id] of ["numbers", "close", "numbers"].entries()) {
      clock += 40 * DAY_MS;
      expect(versions.appendVersion(alice, artifactId, rewrite(id, `edit ${index}`, index + 1))).toMatchObject({
        ok: true,
      });
    }
    expect(versions.listVersions(alice, artifactId)?.map((version) => version.version)).toEqual([4, 1]);

    expect(store.keep(alice, made.proposal.id)).toMatchObject({ ok: true, proposal: { keptVersion: 5 } });
  });
});

describe("who may read and decide: the Workspace member rule", () => {
  it("a removed member, a stranger and another company get not_found, the same as a missing id", async () => {
    const { projectId, artifactId } = await workspaceDocument();
    addProjectMember(alice, projectId, "dina");
    docVersionStore().ensureFirstVersion(alice, artifactId);
    const store = proposalStore();
    const made = proposalOrThrow(
      store.createProposal(dina, artifactId, {
        sectionId: "close",
        section: section("close", "Dina's close"),
        baseVersion: 1,
        agentId: "documents",
      }),
    );
    removeProjectMember(alice, projectId, "dina");

    for (const stranger of [cara, erik, dina]) {
      expect(
        store.createProposal(stranger, artifactId, {
          sectionId: "close",
          section: section("close", "no"),
          baseVersion: 1,
          agentId: "documents",
        }),
        stranger.userId,
      ).toEqual({ ok: false, reason: "not_found" });
      expect(store.listPending(stranger, artifactId), stranger.userId).toBeNull();
      expect(store.keep(stranger, made.proposal.id), stranger.userId).toEqual({ ok: false, reason: "not_found" });
      expect(store.discard(stranger, made.proposal.id), stranger.userId).toEqual({ ok: false, reason: "not_found" });
      expect(store.keep(stranger, "no-such-proposal"), stranger.userId).toEqual({ ok: false, reason: "not_found" });
    }
    expect(statusOf(made.proposal.id)).toBe("pending");
    expect(store.listPending(ben, artifactId)?.map((proposal) => proposal.id)).toEqual([made.proposal.id]);
  });
});
