import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { TenantContext } from "@agentforge/core";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-delegation-sessions-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_SECRETS_KEY = "b".repeat(64);
delete process.env.AGENTFORGE_SERVER;

const tenantA: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org-a",
  workspaceId: "ws-a",
  userId: "user-a",
  role: "owner",
};

const tenantOtherUser: TenantContext = {
  ...tenantA,
  userId: "user-b",
};

const tenantOtherDesk: TenantContext = {
  ...tenantA,
  workspaceId: "ws-b",
};

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("delegation session store", () => {
  it("tracks running and completed subagent sessions sealed at rest and synthesizes one-bot team knowledge", async () => {
    const store = await import("./session-store");
    const started = store.recordDelegationStart(tenantA, {
      parentThreadId: "thread_parent_1",
      childThreadId: "thread_child_1",
      agentKey: "research",
      agentKind: "mode",
      agentName: "Research",
      task: "Analyze Q4 market share for Jakarta coffee chains",
    });

    expect(started.status).toBe("running");
    expect(store.summarizeDelegationCounts(tenantA, ["thread_parent_1"]).get("thread_parent_1")).toEqual({
      total: 1,
      active: 1,
    });

    const rawOnDisk = readFileSync(join(dataDir, "delegations", "ws-a", "user-a", "thread_parent_1.json"), "utf8");
    expect(rawOnDisk).not.toContain("Jakarta coffee chains");

    const finished = store.recordDelegationFinish(tenantA, "thread_parent_1", "thread_child_1", {
      status: "completed",
      summary: "Top 3 chains grew 18% YoY in Jakarta Q4.",
      truncated: false,
      toolsUsed: ["web_search", "research_dossier"],
    });
    expect(finished?.status).toBe("completed");
    expect(finished?.finishedAt).toBeTruthy();

    expect(store.summarizeDelegationCounts(tenantA, ["thread_parent_1"]).get("thread_parent_1")).toEqual({
      total: 1,
      active: 0,
    });

    const prompt = store.formatTeamSessionsPrompt(tenantA, "thread_parent_1");
    expect(prompt).toContain("Team sessions completed in this conversation");
    expect(prompt).toContain("Research (research)");
    expect(prompt).toContain("Top 3 chains grew 18% YoY");

    // Isolation: another user writing the same thread id never clobbers tenantA's records.
    store.recordDelegationStart(tenantOtherUser, {
      parentThreadId: "thread_parent_1",
      childThreadId: "thread_child_other",
      agentKey: "finance",
      agentKind: "mode",
      agentName: "Finance",
      task: "Other user task",
    });
    expect(store.listDelegatedSessions(tenantA, "thread_parent_1")).toHaveLength(1);
    expect(store.listDelegatedSessions(tenantOtherUser, "thread_parent_1")).toHaveLength(1);
    expect(store.listDelegatedSessions(tenantOtherDesk, "thread_parent_1")).toEqual([]);

    store.dropDelegationsForThread(tenantA, "thread_parent_1");
    expect(store.listDelegatedSessions(tenantA, "thread_parent_1")).toEqual([]);
    expect(store.listDelegatedSessions(tenantOtherUser, "thread_parent_1")).toHaveLength(1);
  });
});
