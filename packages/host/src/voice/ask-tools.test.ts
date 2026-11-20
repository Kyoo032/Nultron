/**
 * The decision this file guards: which of Chat's tools a voice ask may run, and which become a card.
 * It fails the day `DEFAULT_CHAT_TOOLS` gains a tool that neither list names, so the person adding it
 * has to decide here, on purpose, whether voice may run it by itself.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_CHAT_TOOLS,
  DELEGATE_TOOL_KEY,
  GENERALIST_EXTRA_TOOLS,
  GENERALIST_WORKER_TOOLS,
  getTool,
  type ToolBindingRecord,
} from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";
import {
  REQUEST_TAP_TOOL_KEY,
  VOICE_DELEGATE_TOOLS,
  VOICE_READ_TOOLS,
  VOICE_TAP_TOOLS,
  ensureVoiceToolsRegistered,
  isVoiceReadTool,
  isVoiceRunTool,
  unclassifiedChatTools,
  voiceBindings,
} from "./ask-tools";

function binding(toolKey: string): ToolBindingRecord {
  return { id: `b-${toolKey}`, agentVersionId: "v1", organizationId: "org1", toolKey, config: {}, enabled: true };
}

/** Writes, sends, spends on media or starts long work. None of these may ever be offered to a voice ask. */
const MUST_NOT_RUN_FROM_VOICE = [
  "write_file",
  "edit_file",
  "delete_file",
  "image_generate",
  "video_generate",
  "build_deck",
  "run_code",
] as const;

describe("which Chat tools a voice ask may run", () => {
  it("has a decision for every tool Chat binds", () => {
    expect(
      unclassifiedChatTools(),
      "DEFAULT_CHAT_TOOLS gained a tool that voice has not decided on: add it to VOICE_READ_TOOLS (reads only) or VOICE_TAP_TOOLS (writes, sends, costs money or takes long) in ask-tools.ts",
    ).toEqual([]);
  });

  it("would catch a Chat tool nobody classified", () => {
    expect(unclassifiedChatTools([...DEFAULT_CHAT_TOOLS, "brand_new_tool"])).toEqual(["brand_new_tool"]);
  });

  it("never lists a tool on both sides", () => {
    const reads = new Set<string>(VOICE_READ_TOOLS);
    expect(VOICE_TAP_TOOLS.filter((key) => reads.has(key))).toEqual([]);
  });

  it("keeps every writing, paid or long tool off the read list", () => {
    for (const key of MUST_NOT_RUN_FROM_VOICE) {
      expect(isVoiceReadTool(key), key).toBe(false);
      expect(VOICE_TAP_TOOLS, key).toContain(key);
    }
  });

  it("keeps every generalist worker off the read list and on the tap list", () => {
    for (const key of GENERALIST_WORKER_TOOLS) {
      expect(isVoiceReadTool(key), key).toBe(false);
      expect(isVoiceRunTool(key), key).toBe(false);
      expect(VOICE_TAP_TOOLS, key).toContain(key);
    }
  });

  it("lets voice run delegate itself, off both the read and the tap lists", () => {
    expect(VOICE_DELEGATE_TOOLS).toEqual([DELEGATE_TOOL_KEY]);
    expect(isVoiceReadTool(DELEGATE_TOOL_KEY)).toBe(false);
    expect(isVoiceRunTool(DELEGATE_TOOL_KEY)).toBe(true);
    expect(VOICE_TAP_TOOLS).not.toContain(DELEGATE_TOOL_KEY);
    // Nothing else moved: the extras are the workers plus delegate, and only delegate runs.
    for (const key of GENERALIST_EXTRA_TOOLS.filter((entry) => entry !== DELEGATE_TOOL_KEY)) {
      expect(isVoiceRunTool(key), key).toBe(false);
    }
  });

  it("offers the Knowledge Base and the desk's files for reading", () => {
    for (const key of ["knowledge_search", "past_sessions", "list_files", "read_file", "search_files"]) {
      expect(isVoiceReadTool(key), key).toBe(true);
    }
  });

  it("treats a tool nobody has heard of as not allowed", () => {
    expect(isVoiceReadTool("brand_new_tool")).toBe(false);
    expect(isVoiceReadTool("")).toBe(false);
    expect(isVoiceRunTool("brand_new_tool")).toBe(false);
    expect(isVoiceRunTool("")).toBe(false);
  });
});

describe("voiceBindings", () => {
  const everything = [...DEFAULT_CHAT_TOOLS, ...GENERALIST_EXTRA_TOOLS, "brand_new_tool"].map(binding);

  it("keeps only the read tools and delegate, and adds request_tap", () => {
    const keys = voiceBindings(everything).map((item) => item.toolKey);
    expect(keys.filter((key) => key !== REQUEST_TAP_TOOL_KEY).sort()).toEqual(
      [...VOICE_READ_TOOLS, ...VOICE_DELEGATE_TOOLS]
        .filter((key) => [...DEFAULT_CHAT_TOOLS, ...GENERALIST_EXTRA_TOOLS].includes(key as never))
        .sort(),
    );
    expect(keys).toContain(REQUEST_TAP_TOOL_KEY);
    expect(keys).toContain(DELEGATE_TOOL_KEY);
    for (const key of MUST_NOT_RUN_FROM_VOICE) {
      expect(keys, key).not.toContain(key);
    }
    for (const key of GENERALIST_WORKER_TOOLS) {
      expect(keys, key).not.toContain(key);
    }
    expect(keys).not.toContain("brand_new_tool");
  });

  it("still offers request_tap to an agent that binds no tool at all", () => {
    expect(voiceBindings([]).map((item) => item.toolKey)).toEqual([REQUEST_TAP_TOOL_KEY]);
  });

  it("carries the version and organization of the agent's own bindings", () => {
    const tap = voiceBindings(everything).find((item) => item.toolKey === REQUEST_TAP_TOOL_KEY);
    expect(tap).toMatchObject({ agentVersionId: "v1", organizationId: "org1", enabled: true });
  });
});

describe("request_tap", () => {
  beforeAll(() => {
    ensureVoiceToolsRegistered();
  }, ROUTER_IMPORT_BUDGET_MS);

  it("is registered, in the voice pack, and says what to do with it", () => {
    const tool = getTool(REQUEST_TAP_TOOL_KEY);
    expect(tool).toBeDefined();
    expect(tool?.pack).toBe("voice");
    expect(tool?.description).toContain("Do not do it");
    expect(tool?.description).toContain("one line saying what will start");
  });

  it("takes one line of summary, and a call without one still counts", () => {
    const tool = getTool(REQUEST_TAP_TOOL_KEY);
    expect(tool?.schema.safeParse({ summary: "Make a deck" }).success).toBe(true);
    expect(tool?.schema.safeParse({}).success).toBe(true);
    expect(tool?.schema.safeParse({ summary: 42 }).success).toBe(false);
  });

  it("is safe to register twice", () => {
    ensureVoiceToolsRegistered();
    expect(getTool(REQUEST_TAP_TOOL_KEY)).toBeDefined();
  });
});
