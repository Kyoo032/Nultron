import { describe, expect, it } from "vitest";
import { ASK_NULTRON_TOOL, ASK_NULTRON_TOOL_NAME } from "./ask";
import {
  ACK_SENTENCE,
  ASK_NULTRON_GATEWAY_TOOL,
  gatewayTools,
  HEAR_SHORT_INSTRUCTIONS,
  KEEP_LISTENING_GATEWAY_TOOL,
  KEEP_LISTENING_NAME,
  OFFER_KEEP_LISTENING,
  TALKER_INSTRUCTIONS,
} from "./talker-prompt";

describe("talker prompt", () => {
  it("has fixed instructions and acknowledgement sentences in en and id", () => {
    expect(TALKER_INSTRUCTIONS.en).toContain("ask_nultron");
    expect(TALKER_INSTRUCTIONS.id).toContain("ask_nultron");
    expect(TALKER_INSTRUCTIONS.en.toLowerCase()).toContain("never say a tool's name");
    expect(TALKER_INSTRUCTIONS.id).toContain("Jangan pernah menyebut nama alat");
    expect(TALKER_INSTRUCTIONS.en).toContain("one or two short sentences");
    expect(TALKER_INSTRUCTIONS.id).toContain("satu atau dua kalimat pendek");
    expect(ACK_SENTENCE.en).toBe("One moment, let me check.");
    expect(ACK_SENTENCE.id).toBe("Sebentar, saya cek dulu.");
    expect(HEAR_SHORT_INSTRUCTIONS.en).toBe("Write exactly what the person said.");
    expect(HEAR_SHORT_INSTRUCTIONS.id.length).toBeGreaterThan(0);
    expect(typeof OFFER_KEEP_LISTENING.on).toBe("boolean");
  });

  it("declares ask_nultron the way the gateway wants it, matching the realtime tool", () => {
    expect(ASK_NULTRON_GATEWAY_TOOL.type).toBe("function");
    expect(ASK_NULTRON_GATEWAY_TOOL.function.name).toBe(ASK_NULTRON_TOOL_NAME);
    expect(ASK_NULTRON_GATEWAY_TOOL.function.name).toBe(ASK_NULTRON_TOOL.name);
    expect(ASK_NULTRON_GATEWAY_TOOL.function.description).toBe(ASK_NULTRON_TOOL.description);
    expect(ASK_NULTRON_GATEWAY_TOOL.function.parameters).toEqual(ASK_NULTRON_TOOL.parameters);
  });

  it("describes keep_listening as an unfinished sentence and offers it only when allowed", () => {
    expect(KEEP_LISTENING_GATEWAY_TOOL.function.name).toBe(KEEP_LISTENING_NAME);
    expect(KEEP_LISTENING_GATEWAY_TOOL.function.description).toContain("yang");
    expect(KEEP_LISTENING_GATEWAY_TOOL.function.description).toContain("say nothing");
    const saved = OFFER_KEEP_LISTENING.on;
    try {
      OFFER_KEEP_LISTENING.on = true;
      const names = (tools: readonly object[]) =>
        tools.map((tool) => (tool as { function: { name: string } }).function.name);
      expect(names(gatewayTools(false))).toEqual(["ask_nultron", "keep_listening"]);
      expect(names(gatewayTools(true))).toEqual(["ask_nultron"]);
      OFFER_KEEP_LISTENING.on = false;
      expect(names(gatewayTools(false))).toEqual(["ask_nultron"]);
    } finally {
      OFFER_KEEP_LISTENING.on = saved;
    }
  });
});
