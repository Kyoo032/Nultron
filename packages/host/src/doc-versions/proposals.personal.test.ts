import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "@agentforge/db";
import type { TenantContext } from "@agentforge/core";
import { createDocumentForTenant } from "../doc-tools/create-document";
import { sampleDocInput } from "../doc-tools/doc-tools-fixtures";
import "../tenant-storage-db";
import { getTenant } from "../tenant";
import { docVersionStore } from "./store";
import { proposalStore } from "./proposals";

process.env.AGENTFORGE_SECRETS_KEY = "6b1d3f5a7c9e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d";
delete process.env.AGENTFORGE_SERVER;

let owner: TenantContext;

beforeAll(async () => {
  owner = await getTenant();
});

afterAll(() => {
  sql.close();
});

describe("Personal: one person, no server mode", () => {
  it("proposes, keeps and attributes a section the same way the hosted app does", async () => {
    const made = await createDocumentForTenant({ format: "docx", spec: sampleDocInput() }, owner);
    if (!made.ok) {
      throw new Error(made.message);
    }
    const proposals = proposalStore();
    const proposal = proposals.createProposal(owner, made.artifactId, {
      sectionId: "close",
      section: { id: "close", heading: "Close", blocks: [{ type: "paragraph", text: "Agent close" }] },
      baseVersion: 1,
      agentId: "documents",
    });
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) {
      throw new Error("the proposal was refused");
    }
    expect(proposals.listPending(owner, made.artifactId)?.map((item) => item.id)).toEqual([proposal.proposal.id]);

    expect(proposals.keep(owner, proposal.proposal.id)).toMatchObject({ ok: true, proposal: { keptVersion: 2 } });
    expect(docVersionStore().listVersions(owner, made.artifactId)?.[0]).toMatchObject({
      version: 2,
      changedSectionIds: ["close"],
      author: { kind: "agent", agentId: "documents", askedByUserId: owner.userId },
    });
    const head = docVersionStore().getVersion(owner, made.artifactId, 2)?.spec;
    expect(head?.kind === "document" ? head.spec.sections.find((part) => part.id === "close")?.blocks : null).toEqual([
      { type: "paragraph", text: "Agent close" },
    ]);
  });
});
