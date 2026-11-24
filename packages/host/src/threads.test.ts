import { afterAll, describe, expect, it } from "vitest";
import { isEnvelope } from "@agentforge/core";
import { sql } from "@agentforge/db";
import { agentService, getTenant } from "./tenant";
import {
  createThread,
  getThread,
  insertMessage,
  listPastSessionsForAgent,
  listThreads,
  listWorkspaceThreads,
  setThreadTitleFromParts,
} from "./threads";

describe("threads.title encryption at rest", () => {
  afterAll(() => {
    sql.close();
  });

  it("seals threads.title in SQLite and returns plaintext on read", async () => {
    const tenant = await getTenant();
    const ready = await agentService.ensureDefaultChat(tenant);

    // Explicit title
    const named = await createThread(tenant, ready.agent.id, "Q4 Secret Acquisition Plan");
    expect(named.title).toBe("Q4 Secret Acquisition Plan");

    const rawNamed = sql.prepare("SELECT title FROM threads WHERE id = ?").get(named.id) as { title: string };
    expect(rawNamed.title).not.toContain("Q4 Secret Acquisition Plan");
    expect(isEnvelope(JSON.parse(rawNamed.title))).toBe(true);

    expect((await getThread(tenant, named.id))?.title).toBe("Q4 Secret Acquisition Plan");
    expect((await listThreads(tenant, ready.agent.id)).find((t) => t.id === named.id)?.title).toBe(
      "Q4 Secret Acquisition Plan",
    );
    expect((await listWorkspaceThreads(tenant)).find((t) => t.id === named.id)?.title).toBe(
      "Q4 Secret Acquisition Plan",
    );

    // Default title, then updated via setThreadTitleFromParts
    const unnamed = await createThread(tenant, ready.agent.id);
    const rawUnnamed = sql.prepare("SELECT title FROM threads WHERE id = ?").get(unnamed.id) as { title: string };
    expect(isEnvelope(JSON.parse(rawUnnamed.title))).toBe(true);

    // Excluded from listPastSessionsForAgent while still a default title
    const current = await createThread(tenant, ready.agent.id, "Current session");
    const pastBefore = await listPastSessionsForAgent(tenant, ready.agent.id, current.id);
    expect(pastBefore.some((s) => s.id === unnamed.id)).toBe(false);
    expect(pastBefore.some((s) => s.id === named.id)).toBe(true);

    await setThreadTitleFromParts(tenant, unnamed.id, [{ type: "text", text: "Board Briefing Notes" }]);
    const rawUpdated = sql.prepare("SELECT title FROM threads WHERE id = ?").get(unnamed.id) as { title: string };
    expect(rawUpdated.title).not.toContain("Board Briefing Notes");
    expect(isEnvelope(JSON.parse(rawUpdated.title))).toBe(true);
    expect((await getThread(tenant, unnamed.id))?.title).toBe("Board Briefing Notes");

    await insertMessage(tenant, unnamed.id, "user", [{ type: "text", text: "Summarize board notes" }]);
    const pastAfter = await listPastSessionsForAgent(tenant, ready.agent.id, current.id);
    const found = pastAfter.find((s) => s.id === unnamed.id);
    expect(found?.title).toBe("Board Briefing Notes");
    expect(found?.preview).toBe("Summarize board notes");
  });

  it("reads legacy plaintext titles cleanly as fallback", async () => {
    const tenant = await getTenant();
    const ready = await agentService.ensureDefaultChat(tenant);
    const thread = await createThread(tenant, ready.agent.id, "placeholder");
    const legacyDefault = await createThread(tenant, ready.agent.id, "placeholder2");

    // Simulate pre-encryption rows stored directly as plaintext
    sql.prepare("UPDATE threads SET title = ? WHERE id = ?").run("Legacy Plaintext Title", thread.id);
    sql.prepare("UPDATE threads SET title = ? WHERE id = ?").run("New thread", legacyDefault.id);

    expect((await getThread(tenant, thread.id))?.title).toBe("Legacy Plaintext Title");
    expect((await listThreads(tenant, ready.agent.id)).find((t) => t.id === thread.id)?.title).toBe(
      "Legacy Plaintext Title",
    );
    expect((await listWorkspaceThreads(tenant)).find((t) => t.id === thread.id)?.title).toBe("Legacy Plaintext Title");

    // Updating a legacy default title seals the new title
    await setThreadTitleFromParts(tenant, legacyDefault.id, [{ type: "text", text: "Upgraded From Legacy" }]);
    const rawAfter = sql.prepare("SELECT title FROM threads WHERE id = ?").get(legacyDefault.id) as { title: string };
    expect(isEnvelope(JSON.parse(rawAfter.title))).toBe(true);
    expect((await getThread(tenant, legacyDefault.id))?.title).toBe("Upgraded From Legacy");
  });
});
