/**
 * The two-argument form callers use: `createFolderRoot(tenant, author)` with no store handed in, so
 * the proposals land in the app database and are sealed with the local vault key.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTenant } from "../tenant";
import { approveProposal, getProposalDiff } from "./decisions";
import { createFolderRoot } from "./folder-root";
import { mountFilePath } from "./mount-record";
import { mountFolder } from "./mount-service";

let base: string;
let folder: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "folder-root-app-")));
  folder = path.join(base, "project");
  mkdirSync(folder);
});

afterAll(() => {
  rmSync(mountFilePath(), { force: true });
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("against the app database", () => {
  it("proposes, shows the diff and applies with no store handed in", async () => {
    writeFileSync(path.join(folder, "plan.md"), "step 1\n");
    const tenant = await getTenant({ workspaceId: undefined, session: undefined });
    await mountFolder(tenant, folder);

    const author = { kind: "agent", runId: "run-app", mode: "chat" } as const;
    const root = await createFolderRoot(tenant, author);
    if ("ok" in root) {
      throw new Error(`root was refused: ${root.code}`);
    }
    const outcome = await root.write("plan.md" as never, "step 1\nstep 2\n", author);
    if (outcome.status !== "pending_approval") {
      throw new Error("expected a pending proposal");
    }

    expect(await getProposalDiff(tenant, outcome.proposalId)).toMatchObject({
      before: "step 1\n",
      after: "step 1\nstep 2\n",
      stale: false,
    });
    expect(readFileSync(path.join(folder, "plan.md"), "utf8")).toBe("step 1\n");
    expect(await approveProposal(tenant, outcome.proposalId)).toEqual({ id: outcome.proposalId, status: "applied" });
    expect(readFileSync(path.join(folder, "plan.md"), "utf8")).toBe("step 1\nstep 2\n");
  });
});
