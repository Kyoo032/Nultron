import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

  it("removes a deleted child thread from its parent's ledger and team prompt, keeping the siblings", async () => {
    const store = await import("./session-store");
    const parentFile = join(dataDir, "delegations", "ws-a", "user-a", "thread_parent_team.json");

    for (const child of ["thread_child_alpha", "thread_child_beta"]) {
      store.recordDelegationStart(tenantA, {
        parentThreadId: "thread_parent_team",
        childThreadId: child,
        agentKey: "research",
        agentKind: "mode",
        agentName: "Research",
        task: `Task of ${child}`,
      });
      store.recordDelegationFinish(tenantA, "thread_parent_team", child, {
        status: "completed",
        summary: `Findings of ${child}: unique marker ${child}.`,
      });
    }
    expect(store.listDelegatedSessions(tenantA, "thread_parent_team")).toHaveLength(2);
    expect(existsSync(parentFile)).toBe(true);

    // Deleting the child thread, which is what `deleteThread` hands this function: the record
    // leaves the parent's ledger even though the parent's own file is not the deleted thread's.
    store.dropDelegationsForThread(tenantA, "thread_child_alpha");

    const remaining = store.listDelegatedSessions(tenantA, "thread_parent_team");
    expect(remaining.map((record) => record.childThreadId)).toEqual(["thread_child_beta"]);
    // The sibling's record survived the rewrite, and the file stayed because it did.
    expect(existsSync(parentFile)).toBe(true);
    const prompt = store.formatTeamSessionsPrompt(tenantA, "thread_parent_team");
    expect(prompt).not.toContain("thread_child_alpha");
    expect(prompt).toContain("Findings of thread_child_beta");

    // When the last child goes, the ledger file goes with it: nothing orphaned on disk.
    store.dropDelegationsForThread(tenantA, "thread_child_beta");
    expect(store.listDelegatedSessions(tenantA, "thread_parent_team")).toEqual([]);
    expect(existsSync(parentFile)).toBe(false);
  });

  it("spends the team prompt budget newest-first, so the latest session is never crowded out", async () => {
    const store = await import("./session-store");
    const parentThread = "thread_parent_budget";
    // Eight long sessions: each rendered line is close to the per-session cap, so the whole set
    // is far over TEAM_PROMPT_MAX_CHARS and something has to be dropped.
    const filler = "the market analysis shows steady growth across every measured segment quarter after quarter ";
    for (let index = 1; index <= 8; index += 1) {
      const child = `thread_child_budget_${index}`;
      store.recordDelegationStart(tenantA, {
        parentThreadId: parentThread,
        childThreadId: child,
        agentKey: "research",
        agentKind: "mode",
        agentName: "Research",
        task: `Budget task ${index}: ${filler.repeat(2)}`,
      });
      store.recordDelegationFinish(tenantA, parentThread, child, {
        status: "completed",
        summary: `SESSION_MARKER_${index} ${filler.repeat(7)}`,
      });
    }
    expect(store.listDelegatedSessions(tenantA, parentThread)).toHaveLength(8);

    const prompt = store.formatTeamSessionsPrompt(tenantA, parentThread);
    expect(prompt.length).toBeLessThanOrEqual(4_200);
    // The newest session is always retained, however full the budget is.
    expect(prompt).toContain("SESSION_MARKER_8");
    // The oldest ones are what the budget drops.
    expect(prompt).not.toContain("SESSION_MARKER_1");
    expect(prompt).not.toContain("SESSION_MARKER_2");
    // And what survives renders oldest-first, as a conversation reads.
    const retained = [3, 4, 5, 6, 7, 8].filter((index) => prompt.includes(`SESSION_MARKER_${index}`));
    expect(retained.length).toBeGreaterThanOrEqual(2);
    const positions = retained.map((index) => prompt.indexOf(`SESSION_MARKER_${index}`));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});
