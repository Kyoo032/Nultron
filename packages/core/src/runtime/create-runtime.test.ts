import { describe, expect, it, vi } from "vitest";
import type { TenantContext } from "../tenancy/types";
import { createRuntime } from "./create-runtime";
import { StubRuntime } from "./stub-runtime";

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org",
  workspaceId: "ws",
  userId: "user",
  role: "builder",
};

describe("createRuntime outbound PII mask", () => {
  it("lets the stub reply on the masked prompt, not the raw email", async () => {
    const previous = process.env.AGENTFORGE_RUNTIME;
    process.env.AGENTFORGE_RUNTIME = "stub";
    try {
      const runtime = createRuntime({}, { image: [], video: [] });
      let seen = "";
      await runtime.execute({
        tenant,
        runId: "run-pii",
        modality: "text",
        version: {
          id: "v1",
          agentId: "a1",
          organizationId: "org",
          version: 1,
          systemPrompt: "You are helpful.",
          model: "stub-model",
          inputModalities: ["text"],
          config: {},
          createdAt: new Date(),
        },
        bindings: [],
        history: [
          {
            role: "user",
            parts: [{ type: "text", text: "Contact me at alex.rivera@example.com please" }],
          },
        ],
        onEvent: (event) => {
          if (event.type === "assistant.delta") {
            seen += event.text;
          }
        },
      });
      expect(seen.startsWith("I need a Toko Token gateway key")).toBe(true);
      expect(seen).not.toContain("alex.rivera@example.com");
      expect(seen).not.toContain("Contact me at");
      expect(seen).not.toMatch(/Stub reply/i);
    } finally {
      if (previous === undefined) {
        delete process.env.AGENTFORGE_RUNTIME;
      } else {
        process.env.AGENTFORGE_RUNTIME = previous;
      }
    }
  });

  it("masks cue-led personal names, emails, and bank accounts before execute sees them", async () => {
    const previous = process.env.AGENTFORGE_RUNTIME;
    process.env.AGENTFORGE_RUNTIME = "stub";
    const executeSpy = vi.spyOn(StubRuntime.prototype, "execute");
    try {
      const runtime = createRuntime({}, { image: [], video: [] });
      await runtime.execute({
        tenant,
        runId: "run-pii-names",
        modality: "text",
        version: {
          id: "v1",
          agentId: "a1",
          organizationId: "org",
          version: 1,
          systemPrompt: "Contact Ibu Siti Rahma at a.n. Budi Santoso.",
          model: "stub-model",
          inputModalities: ["text"],
          config: {},
          createdAt: new Date(),
        },
        bindings: [],
        history: [
          {
            role: "user",
            parts: [
              {
                type: "text",
                text: "Kirim ringkasan ke Rina Wijaya di rina@contoh.id via Rekening BCA 1234567890",
              },
            ],
          },
        ],
        onEvent: () => undefined,
      });

      const passed = executeSpy.mock.calls[0]?.[0];
      // F6: the canary token rides on the masked copy; the person-visible body is still fully masked.
      expect(passed?.version.systemPrompt).toContain("Contact Ibu [name] at a.n. [name].");
      expect(passed?.version.systemPrompt).toContain("[Runtime integrity token:");
      expect(passed?.history[0]?.parts[0]).toEqual({
        type: "text",
        text: "Kirim ringkasan ke [name] di [email] via Rekening BCA [account]",
      });
    } finally {
      executeSpy.mockRestore();
      if (previous === undefined) {
        delete process.env.AGENTFORGE_RUNTIME;
      } else {
        process.env.AGENTFORGE_RUNTIME = previous;
      }
    }
  });
});
