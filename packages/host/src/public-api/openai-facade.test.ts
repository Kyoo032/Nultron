import { describe, expect, it } from "vitest";
import { ApiError } from "@agentforge/core";
import { chatCompletionsHandler } from "./openai-facade";
import type { ServiceIdentity } from "./auth";
import type { ApiKeyRow } from "./keys";
import type { HostRequest } from "../types";

function identity(agentIds: string[] = ["*"]): ServiceIdentity {
  const key: ApiKeyRow = {
    id: "key-1",
    tenant_id: "t1",
    workspace_id: null,
    name: "qa",
    key_prefix: "nk_live_00000000",
    key_hash: Buffer.alloc(32),
    last4: "0000",
    allowed_agents: JSON.stringify(agentIds),
    rate_limit_rpm: null,
    status: "active",
    expires_at: null,
    revoked_at: null,
    last_used_at: null,
    created_by: null,
    created_at: 0,
  };
  return {
    key,
    tenant: {
      tenantId: "t1",
      organizationId: "org",
      workspaceId: "ws",
      userId: "apikey-key-1",
      role: "admin",
    },
  };
}

function request(body: unknown): HostRequest {
  return { method: "POST", path: "/v1/chat/completions", headers: {}, params: {}, query: {}, body };
}

describe("chat completions facade (F5a)", () => {
  it("answers not_found for an agent the desk does not have, never a foreign-key 500", async () => {
    // Regression: the allow-list alone let an unknown agent id reach `createThread`,
    // which failed on the agents FK and surfaced a 500 `internal_error`.
    await expect(
      chatCompletionsHandler(
        request({ model: "no-such-agent", messages: [{ role: "user", content: "hi" }] }),
        identity(),
      ),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it("still refuses an agent outside the key's allow-list before existence is checked", async () => {
    await expect(
      chatCompletionsHandler(
        request({ model: "no-such-agent", messages: [{ role: "user", content: "hi" }] }),
        identity(["other-agent"]),
      ),
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });

  it("requires a model and a non-empty last message", async () => {
    await expect(chatCompletionsHandler(request({ messages: [{ role: "user", content: "hi" }] }), identity())).rejects
      .toBeInstanceOf(ApiError);
    // Existence is checked before the prompt parses, matching `requireAgent` on the
    // sibling routes, so an unknown agent with empty messages is still a 404.
    await expect(
      chatCompletionsHandler(request({ model: "a", messages: [] }), identity()),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
  });
});
