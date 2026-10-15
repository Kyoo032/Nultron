import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, ensurePortalOwner, sql } from "@agentforge/db";
import type { TenantContext } from "@agentforge/core";
import { DOCX_MIME } from "@agentforge/core/artifacts";
import { artifactStore, requireArtifact } from "../artifacts";
import { replaceSection, type Section } from "../doc-model";
import { createDocumentForTenant } from "../doc-tools/create-document";
import { docxBodyText, sampleDocInput } from "../doc-tools/doc-tools-fixtures";
import { getTenant } from "../tenant";
import "../tenant-storage-db";
import { BODY_VERSION_META_KEY, refreshHeadBody, staleHeadFile } from "./render-head";
import { docVersionStore } from "./store";
import type { AppendVersionInput } from "./types";

process.env.AGENTFORGE_SECRETS_KEY = "9c2e4a6b8d0f1a3c5e7b9d1f3a5c7e9b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a1c";
process.env.AGENTFORGE_SERVER = "1";

const TENANT = "render-head-partner";

let alice: TenantContext;

async function person(orgId: string, userId: string, role: "owner" | "member"): Promise<TenantContext> {
  await ensurePortalOwner(db, { tenantId: TENANT, orgId, userId, role });
  return getTenant({ session: { id: `session-${userId}`, tenantId: TENANT, orgId, userId } });
}

function section(id: string, text: string): Section {
  return { id, heading: id, blocks: [{ type: "paragraph", text }] };
}

function rewrite(text: string, baseVersion: number): AppendVersionInput {
  return {
    baseVersion,
    author: { kind: "person" },
    edit: (head) => {
      if (head.kind !== "document") {
        throw new Error("a document");
      }
      return { kind: "document", spec: replaceSection(head.spec, "intro", section("intro", text)) };
    },
  };
}

async function freshDocument(): Promise<string> {
  const made = await createDocumentForTenant({ format: "docx", spec: sampleDocInput() }, alice);
  if (!made.ok) {
    throw new Error(made.message);
  }
  expect(docVersionStore().ensureFirstVersion(alice, made.artifactId)).toMatchObject({
    ok: true,
    head: { version: 1 },
  });
  return made.artifactId;
}

function storedRow(artifactId: string): { body: string; meta: string; size_bytes: number; mime: string } {
  return sql.prepare("SELECT body, meta, size_bytes, mime FROM artifacts WHERE id = ?").get(artifactId) as {
    body: string;
    meta: string;
    size_bytes: number;
    mime: string;
  };
}

function markerOf(artifactId: string): unknown {
  return (JSON.parse(storedRow(artifactId).meta) as Record<string, unknown>)[BODY_VERSION_META_KEY];
}

beforeAll(async () => {
  alice = await person("org-1", "alice", "owner");
});

afterAll(() => {
  sql.close();
});

describe("refreshHeadBody records the version its stored body was rendered from", () => {
  it("a successful refresh writes the head version into the metadata with the body", async () => {
    const artifactId = await freshDocument();
    expect(docVersionStore().appendVersion(alice, artifactId, rewrite("Marked.", 1))).toMatchObject({
      ok: true,
      head: { version: 2 },
    });
    expect(await refreshHeadBody(alice, artifactId)).toEqual({ ok: true, version: 2 });
    expect(markerOf(artifactId)).toBe(2);
  });

  it("a newer head written during the render is not stored over: the body and the marker stay as they were", async () => {
    const artifactId = await freshDocument();
    expect(await refreshHeadBody(alice, artifactId)).toEqual({ ok: true, version: 1 });
    const before = storedRow(artifactId);
    let raced: unknown;
    const result = await refreshHeadBody(alice, artifactId, async () => {
      raced = docVersionStore().appendVersion(alice, artifactId, rewrite("Raced.", 1));
      return new Uint8Array([1, 2, 3]);
    });
    expect(raced).toMatchObject({ ok: true, head: { version: 2 } });
    expect(result).toEqual({ ok: false, reason: "stale" });
    expect(storedRow(artifactId).body).toBe(before.body);
    expect(markerOf(artifactId)).toBe(1);
  });
});

describe("staleHeadFile renders a body that is behind its head, and stores nothing", () => {
  it("a body the last refresh never reached serves the head render and leaves the stored row alone", async () => {
    const artifactId = await freshDocument();
    expect(docVersionStore().appendVersion(alice, artifactId, rewrite("Head only.", 1))).toMatchObject({
      ok: true,
      head: { version: 2 },
    });
    const before = storedRow(artifactId);
    const rendered = await staleHeadFile(alice, requireArtifact(alice, artifactId));
    expect(rendered?.mime).toBe(DOCX_MIME);
    if (rendered === null) {
      throw new Error("expected a head render");
    }
    expect(await docxBodyText(rendered.bytes)).toContain("Head only.");
    expect(storedRow(artifactId)).toEqual(before);
    expect(markerOf(artifactId)).toBeUndefined();
  });

  it("a body at the head version is current, and so is a lone version 1 with no marker", async () => {
    const artifactId = await freshDocument();
    expect(await staleHeadFile(alice, requireArtifact(alice, artifactId))).toBeNull();
    expect(docVersionStore().appendVersion(alice, artifactId, rewrite("Refreshed.", 1))).toMatchObject({
      ok: true,
      head: { version: 2 },
    });
    expect(await refreshHeadBody(alice, artifactId)).toEqual({ ok: true, version: 2 });
    expect(await staleHeadFile(alice, requireArtifact(alice, artifactId))).toBeNull();
  });

  it("an artifact with no versions, or no spec, is served as stored and no version is written", async () => {
    const made = await createDocumentForTenant({ format: "docx", spec: sampleDocInput() }, alice);
    if (!made.ok) {
      throw new Error(made.message);
    }
    expect(await staleHeadFile(alice, requireArtifact(alice, made.artifactId))).toBeNull();
    const plain = artifactStore().create(alice, {
      mode: "research",
      kind: "dossier",
      title: "Plain note",
      mime: "text/markdown",
      body: "# Plain\n",
      meta: {},
    });
    expect(await staleHeadFile(alice, requireArtifact(alice, plain.id))).toBeNull();
    expect(sql.prepare("SELECT COUNT(*) AS n FROM doc_versions WHERE artifact_id = ?").get(made.artifactId)).toEqual({
      n: 0,
    });
  });

  it("a render that fails serves nothing, so the caller keeps the stored body", async () => {
    const artifactId = await freshDocument();
    expect(docVersionStore().appendVersion(alice, artifactId, rewrite("Unrendered.", 1))).toMatchObject({
      ok: true,
      head: { version: 2 },
    });
    const rendered = await staleHeadFile(alice, requireArtifact(alice, artifactId), async () => {
      throw new Error("renderer is down");
    });
    expect(rendered).toBeNull();
  });
});
