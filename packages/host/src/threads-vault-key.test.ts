import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { SERVER_VAULT_KEY_TOO_WEAK } from "@agentforge/db/vault-key";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";

describe("sealed thread messages and the wrap key", () => {
  let previousKey: string | undefined;
  let previousServer: string | undefined;

  afterEach(() => {
    if (previousKey === undefined) {
      delete process.env.AGENTFORGE_SECRETS_KEY;
    } else {
      process.env.AGENTFORGE_SECRETS_KEY = previousKey;
    }
    if (previousServer === undefined) {
      delete process.env.AGENTFORGE_SERVER;
    } else {
      process.env.AGENTFORGE_SERVER = previousServer;
    }
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    const { sql } = await import("@agentforge/db");
    sql.close();
  });

  it("opens messages sealed under a short desk key, and throws instead of returning the envelope when the server refuses the key", {
    timeout: ROUTER_IMPORT_BUDGET_MS,
  }, async () => {
    previousKey = process.env.AGENTFORGE_SECRETS_KEY;
    previousServer = process.env.AGENTFORGE_SERVER;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.AGENTFORGE_SECRETS_KEY = "short-pass";

    const { agentService, getTenant } = await import("./tenant");
    const { createThread, insertMessage, listMessages } = await import("./threads");
    const tenant = await getTenant();
    const ready = await agentService.ensureDefaultChat(tenant);
    const thread = await createThread(tenant, ready.agent.id, "Short key probe");
    await insertMessage(tenant, thread.id, "user", [{ type: "text", text: "private budget 1842" }]);
    const opened = await listMessages(tenant, thread.id);
    expect(opened).toHaveLength(1);
    expect(JSON.stringify(opened[0])).toContain("private budget 1842");

    process.env.AGENTFORGE_SERVER = "1";
    await expect(listMessages(tenant, thread.id)).rejects.toThrow(SERVER_VAULT_KEY_TOO_WEAK);
  });
});
