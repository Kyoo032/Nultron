import { describe, expect, it } from "vitest";
import { AiSdkRuntime } from "./ai-sdk-runtime";
import { startThinkingGateway } from "./__fixtures__/thinking-gateway";
import type { RuntimeEvent } from "./types";

describe.each(["google_generate_content", "responses"] as const)("real %s stream", (wire) => {
  it.each(["A", "B", "unfinished", "clean", "401", "cancel"] as const)("handles %s", async (mode) => {
    let thinkingSeen!: () => void;
    const thinkingArrived = new Promise<void>((resolve) => {
      thinkingSeen = resolve;
    });
    const gateway = await startThinkingGateway(mode === "cancel" ? "A" : mode, { beforeDrop: () => thinkingArrived });
    const caller = new AbortController();
    const events: RuntimeEvent[] = [];
    let failed: unknown;
    try {
      await new AiSdkRuntime({ openai: "sk-local-mock", openaiBaseUrl: gateway.url }).execute({
        tenant: { tenantId: "local-tenant", organizationId: "org", workspaceId: "ws", userId: "user", role: "owner" },
        runId: "stream-drop",
        modality: "text",
        wire,
        bindings: [],
        version: {
          id: "v",
          agentId: "chat",
          organizationId: "org",
          version: 1,
          systemPrompt: "Be helpful.",
          model: wire === "responses" ? "gpt-5.6" : "gemini-3.5-flash",
          inputModalities: ["text"],
          config: {},
          createdAt: new Date(),
        },
        history: [{ role: "user", parts: [{ type: "text", text: "Say ok." }] }],
        thinking: true,
        signal: caller.signal,
        reasoningEffort: "medium",
        onEvent(event) {
          events.push(event);
          if (event.type === "assistant.thinking") {
            thinkingSeen();
            if (mode === "cancel") caller.abort(new Error("Owner cancelled"));
          }
        },
      });
    } catch (error) {
      failed = error;
    } finally {
      await gateway.close();
    }
    expect(gateway.requests()).toBe(mode === "clean" || mode === "401" || mode === "cancel" ? 1 : 2);
    if (mode === "cancel") {
      expect(String(failed)).toContain("Owner cancelled");
      expect(events.filter((event) => event.type === "run.failed" || event.type === "run.completed")).toHaveLength(0);
      return;
    }
    if (mode === "401") {
      expect(String(failed)).toMatch(/Unauthorized|401/);
      expect(events.filter((event) => event.type === "run.failed")).toHaveLength(1);
      expect(events.filter((event) => event.type === "run.completed")).toHaveLength(0);
      return;
    }
    expect(failed).toBeUndefined();
    const thoughts = events.filter((event) => event.type === "assistant.thinking");
    expect(thoughts.filter((event) => event.replace)).toHaveLength(mode === "clean" ? 0 : 1);
    expect(thoughts.reduce((text, event) => (event.replace ? event.text : text + event.text), "")).toBe(
      "Weighing the options.",
    );
    expect(
      events
        .filter((event) => event.type === "assistant.delta")
        .map((event) => event.text)
        .join(""),
    ).toBe(mode === "clean" ? "" : "ok");
    expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "run.failed")).toHaveLength(0);
  });
});
