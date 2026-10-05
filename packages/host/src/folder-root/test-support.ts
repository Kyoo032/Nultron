/** Test-only helpers for the folder root. Not imported by product code. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { TenantContext } from "@agentforge/core";
import { wrappingKeyFromSecret } from "@agentforge/core";
import { ensureSchema } from "@agentforge/db/ensure-schema";
import { createProposalStore, type ProposalStore } from "./proposal-store";

export type ProposalsFixture = {
  readonly db: Database.Database;
  readonly store: ProposalStore;
};

const KEY = wrappingKeyFromSecret("c".repeat(64));

export function openProposalsFixture(): ProposalsFixture {
  const db = new Database(":memory:");
  ensureSchema(db);
  return { db, store: createProposalStore(db, () => KEY) };
}

export const DESK_A: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org",
  workspaceId: "desk-a",
  userId: "local",
  role: "owner",
};

export const DESK_B: TenantContext = { ...DESK_A, workspaceId: "desk-b" };

export type Sandbox = {
  /** Real path of a scratch folder holding `folder/` (the mounted one), `outside/` and `data/`. */
  readonly base: string;
  readonly folder: string;
  readonly outside: string;
  readonly data: string;
  put(relPath: string, content: string | Uint8Array): string;
  dispose(): void;
};

/** Scratch directories under the OS temp dir, resolved to real paths the way the mount check does. */
export function makeSandbox(): Sandbox {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "folder-root-")));
  const folder = path.join(base, "folder");
  const outside = path.join(base, "outside");
  const data = path.join(base, "data");
  for (const dir of [folder, outside, data]) {
    mkdirSync(dir, { recursive: true });
  }
  return {
    base,
    folder,
    outside,
    data,
    put(relPath, content) {
      const target = path.join(folder, ...relPath.split("/"));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
      return target;
    },
    dispose() {
      rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}
