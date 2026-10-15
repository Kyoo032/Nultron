/**
 * The four document tools as the model sees them: registered, internal, shaped by a schema that sets no
 * ceiling, and bound to every virtual agent's conversation.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CHAT_TOOLS, getTool, VIRTUAL_AGENTS, virtualAgentMayCall } from "@agentforge/core";
import { harnessSpecFor } from "@agentforge/core/harness";
import { ensureToolsRegistered } from "../register-tools";
import { createDocumentTool, DOC_TOOLS, reviseDocumentTool } from "./doc-tools";
import { createDocumentSchema, reviseDocumentSchema } from "./doc-tool-schemas";

const DOC_TOOL_KEYS = ["create_document", "create_workbook", "revise_document", "import_document"];

describe("the document tools", () => {
  it("are the four keys the model is told about, in the order the prompt lists them", () => {
    expect(DOC_TOOLS.map((tool) => tool.key)).toEqual(DOC_TOOL_KEYS);
  });

  it("are internal tools: the answer is computed by the host, never text a page or file wrote", () => {
    for (const tool of DOC_TOOLS) {
      expect(tool.trust).toBe("internal");
    }
  });

  it("are registered by ensureToolsRegistered, so the chat run can find them by key", () => {
    ensureToolsRegistered();
    for (const key of DOC_TOOL_KEYS) {
      expect(getTool(key)?.key).toBe(key);
    }
  });

  it("accept a create_document call with a spec and reject nothing the SDK would end the turn for", () => {
    const parsed = createDocumentSchema.safeParse({
      format: "word",
      spec: { title: "Plan", sections: [{ id: "one", blocks: [] }] },
    });
    expect(parsed.success).toBe(true);
    const tooLong = createDocumentSchema.safeParse({
      format: "pdf",
      spec: { title: "Plan", sections: Array.from({ length: 500 }, (_, index) => ({ id: `s${index}`, blocks: [] })) },
    });
    expect(tooLong.success).toBe(true);
  });

  it("tell the model the caps and the id rule in words, and that the revision needs the artifact id", () => {
    expect(createDocumentTool.description).toMatch(/Word \(docx\) or PDF/);
    expect(createDocumentTool.description).toMatch(/artifactId/);
    expect(createDocumentTool.description).not.toMatch(/download button/i);
    expect(reviseDocumentSchema.safeParse({ artifactId: "abc" }).success).toBe(true);
  });

  it("tell the model a Workspace section change waits for Keep, and that any other revision saves a copy", () => {
    expect(reviseDocumentTool.description).toMatch(
      /In a Workspace, a one-section change to a document waits for a member to press Keep/,
    );
    expect(reviseDocumentTool.description).toMatch(
      /Elsewhere, and for a sheet, theme or format change, a revised copy is saved/,
    );
    expect(reviseDocumentTool.description).toMatch(/pending true/);
  });
});

describe("the document tools in the chat tool sets", () => {
  it("are in DEFAULT_CHAT_TOOLS, so every agent that binds Chat's tools binds them", () => {
    for (const key of DOC_TOOL_KEYS) {
      expect(DEFAULT_CHAT_TOOLS).toContain(key);
    }
  });

  it("have a per-turn ceiling in the Chat harness, like build_deck", () => {
    for (const key of DOC_TOOL_KEYS) {
      expect(harnessSpecFor("chat").budget.perTool?.[key]).toBe(4);
    }
  });

  it("are callable by every virtual agent", () => {
    expect(VIRTUAL_AGENTS.length).toBeGreaterThan(0);
    for (const agent of VIRTUAL_AGENTS) {
      for (const key of DOC_TOOL_KEYS) {
        expect(virtualAgentMayCall(agent, key)).toBe(true);
      }
    }
  });
});
