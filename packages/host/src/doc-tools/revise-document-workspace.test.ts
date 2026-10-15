import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { virtualAgentFor, type TenantContext } from "@agentforge/core";
import { sql } from "@agentforge/db";
import { artifactStore } from "../artifacts";
import { docVersionStore, proposalStore } from "../doc-versions";
import { addProjectMember, bringProjectAgent, createProject } from "../projects/service";
import { setFileProject } from "../projects/store";
import { forgetTenantJobBytes, resetObjectStoreForTests } from "../tenant-storage";
import "../tenant-storage-db";
import { withToolRun } from "../tool-run-context";
import { createDocumentForTenant, createWorkbookForTenant } from "./create-document";
import { reviseDocumentForTenant, type PendingRevision, type ReviseDocumentResult } from "./revise-document";
import {
  DOC_PERSON,
  DOC_PERSON_B,
  docTenant,
  sampleDocInput,
  sampleWorkbookInput,
  type DocPerson,
} from "./doc-tools-fixtures";

process.env.AGENTFORGE_SECRETS_KEY = "3f8a1c05d97e26b4084fa3c1e5d7290b6c48af13e02d95b7ca6318fd4e7092a5";

const DOC_PERSON_D: DocPerson = { id: "doc-session-d", tenantId: "doc-tenant", orgId: "doc-org", userId: "doc-user-d" };

let owner: TenantContext;
let member: TenantContext;
let outsider: TenantContext;

beforeAll(async () => {
  owner = await docTenant(DOC_PERSON);
  member = await docTenant(DOC_PERSON_B);
  outsider = await docTenant(DOC_PERSON_D);
});

beforeEach(() => {
  process.env.AGENTFORGE_SERVER = "1";
});

afterEach(() => {
  delete process.env.AGENTFORGE_SERVER;
  sql.prepare("DELETE FROM tenant_storage").run();
  resetObjectStoreForTests();
  forgetTenantJobBytes();
});

afterAll(() => {
  sql.close();
});

function pendingOf(result: ReviseDocumentResult): PendingRevision {
  if (!("pending" in result)) {
    throw new Error(`expected a pending proposal, got ${JSON.stringify(result)}`);
  }
  return result;
}

function workspaceCount(): number {
  return (
    sql.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE workspace_id = ?").get(owner.workspaceId) as { n: number }
  ).n;
}

function rowCount(table: "doc_proposals" | "doc_versions", artifactId: string): number {
  return (sql.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE artifact_id = ?`).get(artifactId) as { n: number }).n;
}

async function workspaceDocument(): Promise<{ artifactId: string; projectId: string }> {
  const project = createProject(owner, { name: `Room ${randomUUID()}` });
  addProjectMember(owner, project.id, member.userId);
  const made = await createDocumentForTenant({ format: "docx", spec: sampleDocInput() }, owner);
  if (!made.ok) {
    throw new Error(made.message);
  }
  setFileProject(owner, made.artifactId, project.id);
  return { artifactId: made.artifactId, projectId: project.id };
}

function headOf(artifactId: string): number {
  return docVersionStore().listVersions(owner, artifactId)?.[0]?.version ?? 1;
}

async function changeSectionAsOwner(artifactId: string, sectionId: string): Promise<void> {
  const created = proposalStore().createProposal(owner, artifactId, {
    sectionId,
    section: {
      id: sectionId,
      heading: "Changed by the owner",
      blocks: [{ type: "paragraph", text: "The owner's change." }],
    },
    baseVersion: headOf(artifactId),
    agentId: virtualAgentFor("chat").id,
  });
  if (!created.ok) {
    throw new Error(created.reason);
  }
  const kept = proposalStore().keep(owner, created.proposal.id);
  if (!kept.ok) {
    throw new Error(kept.reason);
  }
}

function sectionChange(artifactId: string, sectionId: string, text: string) {
  return { artifactId, sectionId, section: { blocks: [{ type: "paragraph" as const, text }] } };
}

describe("revise_document in a Workspace: a section change waits for Keep", () => {
  it("a member's section change makes one pending proposal and saves no new file", async () => {
    const { artifactId } = await workspaceDocument();
    const before = workspaceCount();
    const originalBody = artifactStore().get(member, artifactId)?.body;

    const result = await reviseDocumentForTenant(
      {
        artifactId,
        sectionId: "numbers",
        section: { heading: "Numbers, corrected", blocks: [{ type: "paragraph", text: "Revenue was 220." }] },
      },
      member,
    );
    const pending = pendingOf(result);
    expect(pending).toMatchObject({ ok: true, pending: true, artifactId, sectionId: "numbers" });
    expect(pending.summary).toMatch(/Keep/);

    expect(workspaceCount()).toBe(before);
    expect(proposalStore().listPending(member, artifactId)).toMatchObject([
      {
        id: pending.proposalId,
        sectionId: "numbers",
        baseVersion: 1,
        askedByUserId: member.userId,
        agentId: virtualAgentFor("chat").id,
        status: "pending",
      },
    ]);
    expect(artifactStore().get(member, artifactId)?.body).toBe(originalBody);
    expect(
      docVersionStore()
        .listVersions(member, artifactId)
        ?.map((info) => info.version),
    ).toEqual([1]);

    expect(proposalStore().keep(member, pending.proposalId)).toMatchObject({ ok: true, proposal: { keptVersion: 2 } });
    const kept = docVersionStore().getVersion(member, artifactId, 2)?.spec;
    expect(kept?.kind === "document" ? kept.spec.sections[1]?.heading : null).toBe("Numbers, corrected");
  });

  it("refuses a change under an agent the Workspace never brought in, and writes no proposal or version", async () => {
    const { artifactId } = await workspaceDocument();
    const before = workspaceCount();
    const result = await withToolRun({ runId: randomUUID(), mode: "research" }, () =>
      reviseDocumentForTenant(sectionChange(artifactId, "close", "Changed."), member),
    );
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    expect(result.ok === false && result.message).toMatch(/not in this Workspace/);
    expect(workspaceCount()).toBe(before);
    expect(proposalStore().listPending(member, artifactId)).toEqual([]);
    expect(rowCount("doc_proposals", artifactId)).toBe(0);
    expect(rowCount("doc_versions", artifactId)).toBe(0);
  });

  it("records the agent a member brought into the Workspace as the proposal's agent", async () => {
    const { artifactId, projectId } = await workspaceDocument();
    await bringProjectAgent(member, projectId, "research");
    const result = await withToolRun({ runId: randomUUID(), mode: "research" }, () =>
      reviseDocumentForTenant(sectionChange(artifactId, "close", "Changed."), member),
    );
    const pending = pendingOf(result);
    expect(proposalStore().listPending(member, artifactId)).toMatchObject([
      { id: pending.proposalId, agentId: "research", askedByUserId: member.userId, baseVersion: 1 },
    ]);
  });

  it("refuses a section change that also changes the theme, and saves nothing", async () => {
    const { artifactId } = await workspaceDocument();
    const before = workspaceCount();
    const result = await reviseDocumentForTenant(
      {
        artifactId,
        sectionId: "close",
        section: { blocks: [{ type: "paragraph", text: "Changed." }] },
        theme: "modern",
      },
      member,
    );
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(workspaceCount()).toBe(before);
    expect(proposalStore().listPending(member, artifactId)).toEqual([]);
  });

  it("a theme change alone still saves a copy in a Workspace", async () => {
    const { artifactId } = await workspaceDocument();
    const before = workspaceCount();
    const result = await reviseDocumentForTenant({ artifactId, theme: "modern" }, member);
    expect(result).toMatchObject({ ok: true, title: "Quarterly review (revised)" });
    expect(result).not.toHaveProperty("pending");
    expect(workspaceCount()).toBe(before + 1);
    expect(proposalStore().listPending(member, artifactId)).toEqual([]);
  });

  it("a sheet change on a Workspace workbook still saves a copy, and a section id on it is still refused", async () => {
    const project = createProject(owner, { name: `Room ${randomUUID()}` });
    addProjectMember(owner, project.id, member.userId);
    const made = await createWorkbookForTenant({ spec: sampleWorkbookInput() }, owner);
    if (!made.ok) {
      throw new Error(made.message);
    }
    setFileProject(owner, made.artifactId, project.id);

    const copy = await reviseDocumentForTenant(
      {
        artifactId: made.artifactId,
        sheetId: "costs",
        sheet: {
          name: "Costs 2",
          columns: [{ key: "item", header: "Item", type: "text" }],
          rows: [{ item: "Rent" }],
        },
      },
      member,
    );
    expect(copy).toMatchObject({ ok: true, title: "Budget (revised)", format: "xlsx" });
    expect(copy).not.toHaveProperty("pending");

    const section = await reviseDocumentForTenant(
      { artifactId: made.artifactId, sectionId: "costs", section: { blocks: [] } },
      member,
    );
    expect(section).toMatchObject({ ok: false, reason: "invalid" });
    expect(section.ok === false && section.message).toMatch(/workbook/);
    expect(proposalStore().listPending(member, made.artifactId)).toEqual([]);
  });

  it("answers not found to a company member who is not in the Workspace, and makes nothing", async () => {
    const { artifactId } = await workspaceDocument();
    const before = workspaceCount();
    const result = await reviseDocumentForTenant(
      { artifactId, sectionId: "numbers", section: { blocks: [] } },
      outsider,
    );
    expect(result).toMatchObject({ ok: false, reason: "not_found" });
    expect(workspaceCount()).toBe(before);
    expect(proposalStore().listPending(outsider, artifactId)).toBeNull();
    expect(rowCount("doc_proposals", artifactId)).toBe(0);
  });

  it("refuses an unknown section id and names the sections the file has", async () => {
    const { artifactId } = await workspaceDocument();
    const result = await reviseDocumentForTenant({ artifactId, sectionId: "nope", section: { blocks: [] } }, member);
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(result.ok === false && result.message).toMatch(/no section "nope"/);
    expect(rowCount("doc_proposals", artifactId)).toBe(0);
  });

  it("refuses a section that changed after this run first saw the file, and keeps the other sections open", async () => {
    const { artifactId } = await workspaceDocument();
    const run = { runId: randomUUID(), mode: "chat" };
    const first = pendingOf(
      await withToolRun(run, () =>
        reviseDocumentForTenant(sectionChange(artifactId, "close", "Closing, first."), member),
      ),
    );
    expect(first.baseVersion).toBe(1);

    await changeSectionAsOwner(artifactId, "numbers");
    expect(headOf(artifactId)).toBe(2);

    const refused = await withToolRun(run, () =>
      reviseDocumentForTenant(sectionChange(artifactId, "numbers", "Numbers, late."), member),
    );
    expect(refused).toMatchObject({ ok: false, reason: "unavailable" });
    expect(refused.ok === false && refused.message).toMatch(/changed after the version/);
    expect(
      proposalStore()
        .listPending(member, artifactId)
        ?.map((proposal) => proposal.sectionId),
    ).toEqual(["close"]);

    const other = pendingOf(
      await withToolRun(run, () =>
        reviseDocumentForTenant(sectionChange(artifactId, "close", "Closing, again."), member),
      ),
    );
    expect(other.baseVersion).toBe(1);
    expect(
      proposalStore()
        .listPending(member, artifactId)
        ?.map((proposal) => proposal.id),
    ).toEqual([other.proposalId]);
  });

  it("bases a change in a new run on the version that run first saw", async () => {
    const { artifactId } = await workspaceDocument();
    await changeSectionAsOwner(artifactId, "numbers");
    const fresh = pendingOf(
      await withToolRun({ runId: randomUUID(), mode: "chat" }, () =>
        reviseDocumentForTenant(sectionChange(artifactId, "numbers", "Numbers, fresh."), member),
      ),
    );
    expect(fresh.baseVersion).toBe(2);
    expect(proposalStore().listPending(member, artifactId)).toMatchObject([{ id: fresh.proposalId, baseVersion: 2 }]);
  });

  it("checks an explicit baseVersion against the section, and refuses one that is not a version of the file", async () => {
    const { artifactId } = await workspaceDocument();
    await changeSectionAsOwner(artifactId, "numbers");
    const stale = await reviseDocumentForTenant(
      { ...sectionChange(artifactId, "numbers", "Late."), baseVersion: 1 },
      member,
    );
    expect(stale).toMatchObject({ ok: false, reason: "unavailable" });
    const future = await reviseDocumentForTenant(
      { ...sectionChange(artifactId, "numbers", "Late."), baseVersion: 99 },
      member,
    );
    expect(future).toMatchObject({ ok: false, reason: "invalid" });
    expect(future.ok === false && future.message).toMatch(/baseVersion/);
    expect(proposalStore().listPending(member, artifactId)).toEqual([]);
    const current = pendingOf(
      await reviseDocumentForTenant({ ...sectionChange(artifactId, "numbers", "Current."), baseVersion: 2 }, member),
    );
    expect(current.baseVersion).toBe(2);
    expect(proposalStore().listPending(member, artifactId)).toHaveLength(1);
  });
});

describe("revise_document outside a Workspace and on Personal keeps the copy", () => {
  it("a file in no Workspace still gets a (revised) copy, and writes no proposal or version", async () => {
    const made = await createDocumentForTenant({ format: "docx", spec: sampleDocInput() }, owner);
    if (!made.ok) {
      throw new Error(made.message);
    }
    const result = await reviseDocumentForTenant(
      {
        artifactId: made.artifactId,
        sectionId: "numbers",
        section: { heading: "Numbers, corrected", blocks: [{ type: "paragraph", text: "Revenue was 220." }] },
      },
      owner,
    );
    expect(result).toMatchObject({ ok: true, title: "Quarterly review (revised)" });
    expect(result).not.toHaveProperty("pending");
    if (!result.ok) {
      throw new Error(`expected a copy, got ${JSON.stringify(result)}`);
    }
    expect(result.artifactId).not.toBe(made.artifactId);
    expect(rowCount("doc_proposals", made.artifactId)).toBe(0);
    expect(rowCount("doc_versions", made.artifactId)).toBe(0);
  });

  it("on Personal a file in a Workspace still gets a copy, and no proposal", async () => {
    delete process.env.AGENTFORGE_SERVER;
    const project = createProject(owner, { name: `Room ${randomUUID()}` });
    const made = await createDocumentForTenant({ format: "docx", spec: sampleDocInput() }, owner);
    if (!made.ok) {
      throw new Error(made.message);
    }
    setFileProject(owner, made.artifactId, project.id);
    const result = await reviseDocumentForTenant(
      {
        artifactId: made.artifactId,
        sectionId: "close",
        section: { blocks: [{ type: "paragraph", text: "Personal change." }] },
      },
      owner,
    );
    expect(result).toMatchObject({ ok: true, title: "Quarterly review (revised)" });
    expect(result).not.toHaveProperty("pending");
    expect(rowCount("doc_proposals", made.artifactId)).toBe(0);
    expect(rowCount("doc_versions", made.artifactId)).toBe(0);
  });
});
