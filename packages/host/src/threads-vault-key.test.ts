import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DESK_VAULT_KEY_TOO_WEAK } from "@agentforge/db/vault-key";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";

describe("sealed thread messages under a refused wrap key", () => {
  let previousKey: string | undefined;

  afterEach(() => {
    if (previousKey === undefined) {
      delete process.env.AGENTFORGE_SECRETS_KEY;
    } else {
      process.env.AGENTFORGE_SECRETS_KEY = previousKey;
    }
  });

  afterAll(async () => {
    const { sql } = await import("@agentforge/db");
    sql.close();
  });

  it("throws instead of handing the sealed envelope back as the message", { timeout: ROUTER_IMPORT_BUDGET_MS }, async () => {
    const { agentService, getTenant } = await import("./tenant");
    const { createThread, insertMessage, listMessages } = await import("./threads");
    const tenant = await getTenant();
    const ready = await agentService.ensureDefaultChat(tenant);
    const thread = await createThread(tenant, ready.agent.id, "Refused key probe");
    await insertMessage(tenant, thread.id, "user", [{ type: "text", text: "private budget 1842" }]);
    expect(await listMessages(tenant, thread.id)).toHaveLength(1);

    previousKey = process.env.AGENTFORGE_SECRETS_KEY;
    process.env.AGENTFORGE_SECRETS_KEY = "hunter2";
    await expect(listMessages(tenant, thread.id)).rejects.toThrow(DESK_VAULT_KEY_TOO_WEAK);
  });
});
