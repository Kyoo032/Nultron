import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "@agentforge/db";
import { virtualAgentFor, type TenantContext } from "@agentforge/core";
import type { DocSpec, Section } from "../doc-model";
import type { JobAssistantOptions, JobAssistantRun } from "../job-regen";
import { getTenant } from "../tenant";
import {
  agentBrief,
  documentContext,
  readSectionReply,
  sectionPrompt,
  sectionSystemPrompt,
  stubSection,
  writeSectionProposal,
} from "./propose-section";

process.env.AGENTFORGE_SECRETS_KEY = "6b1d3f5a7c9e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d";
delete process.env.AGENTFORGE_SERVER;

const DOCUMENTS = virtualAgentFor("documents");
const CHAT = virtualAgentFor("chat");

const DOC: DocSpec = {
  kind: "document",
  title: "Quarterly review",
  theme: "plain",
  titlePage: false,
  sections: [
    { id: "intro", heading: "Introduction", blocks: [{ type: "paragraph", text: "Sales grew this quarter." }] },
    {
      id: "numbers",
      heading: "Numbers",
      blocks: [
        { type: "bullets", items: ["Revenue up", "Costs flat"] },
        {
          type: "table",
          columns: ["Month", "Sales"],
          rows: [
            ["Jan", 100],
            ["Feb", null],
          ],
        },
      ],
    },
    { id: "close", heading: "Close", blocks: [{ type: "quote", text: "Next quarter we expand." }] },
  ],
};

const TARGET = DOC.sections[1] as Section;

let owner: TenantContext;

beforeAll(async () => {
  owner = await getTenant();
});

afterAll(() => {
  sql.close();
});

describe("the prompt a section rewrite sends", () => {
  it("shows the whole document as text, with the target marked and given in full once", () => {
    const context = documentContext(DOC, "numbers");
    expect(context).toContain("[intro] Introduction\n\nSales grew this quarter.");
    expect(context).toContain("[numbers] (the section to rewrite, given in full below)");
    expect(context).not.toContain("Revenue up");
    expect(context).toContain("[close] Close\n\n> Next quarter we expand.");
  });

  it("cuts a long section in the context and keeps every section id", () => {
    const long: DocSpec = {
      ...DOC,
      sections: [
        ...DOC.sections,
        ...Array.from({ length: 400 }, (_value, index) => ({
          id: `bulk${index}`,
          heading: "Bulk",
          blocks: [{ type: "paragraph" as const, text: "x".repeat(5000) }],
        })),
      ],
    };
    const context = documentContext(long, "intro");
    expect(context.length).toBeLessThan(400 * 500 + 10_000);
    expect(context).toContain("[bulk399]");
    expect(context).toContain("...");
  });

  it("carries the title, the target as JSON and the member's instruction", () => {
    const prompt = sectionPrompt(DOC, TARGET, "Make it one sentence");
    expect(prompt).toContain("Document title: Quarterly review");
    expect(prompt).toContain('The section to rewrite, id "numbers":');
    expect(prompt).toContain('"Revenue up"');
    expect(prompt).toContain("The member's instruction:\nMake it one sentence");
  });

  it("opens with the agent's own role, then the JSON contract, then the output-language rule", () => {
    const english = sectionSystemPrompt(DOCUMENTS, "en");
    expect(english.startsWith("You are the Documents agent on the owner's desk.")).toBe(true);
    expect(english.indexOf("Your specialty is writing documents")).toBeLessThan(
      english.indexOf("Return ONLY valid JSON"),
    );
    expect(english).toContain('{ "type": "table"');
    expect(english).toContain("Write every user-facing title, heading, and body string in English.");

    const indonesian = sectionSystemPrompt(CHAT, "id");
    expect(indonesian.startsWith("You are the general assistant on the owner's desk.")).toBe(true);
    expect(indonesian).toContain("Bahasa Indonesia");
    expect(indonesian).not.toContain("write_file");
  });

  it("takes only the first line of the agent's prompt as its role", () => {
    expect(agentBrief(DOCUMENTS).split("\n")).toHaveLength(1);
    expect(agentBrief(DOCUMENTS).length).toBeLessThanOrEqual(1200);
  });
});

describe("the stub section", () => {
  it("is deterministic, keeps the heading and the id, and shows the instruction", () => {
    const first = stubSection(TARGET, DOCUMENTS, "Shorter");
    expect(first).toEqual(stubSection(TARGET, DOCUMENTS, "Shorter"));
    expect(first).toEqual({
      id: "numbers",
      heading: "Numbers",
      blocks: [{ type: "paragraph", text: "[stub documents] Shorter" }],
    });
    expect(stubSection(TARGET, DOCUMENTS, "Longer")).not.toEqual(first);
  });
});

describe("reading the model's reply", () => {
  it("accepts a fenced reply and forces the id to the target's", () => {
    const reply = readSectionReply(
      '```json\n{"id":"hijack","heading":"Figures","blocks":[{"type":"paragraph","text":"Sales rose."}]}\n```',
      TARGET,
    );
    expect(reply).toEqual({
      ok: true,
      section: { id: "numbers", heading: "Figures", blocks: [{ type: "paragraph", text: "Sales rose." }] },
      model: null,
    });
  });

  it("keeps the target's heading when the reply leaves it out", () => {
    const reply = readSectionReply('{"blocks":[{"type":"bullets","items":["a"]}]}', TARGET);
    expect(reply).toMatchObject({ ok: true, section: { heading: "Numbers" } });
  });

  it.each([
    ["no JSON", "Sure, here is a better section."],
    ["broken JSON", '{"heading": "x", "blocks": [}'],
    ["a block type the model made up", '{"heading":"x","blocks":[{"type":"chart","text":"y"}]}'],
    ["blocks that are not a list", '{"heading":"x","blocks":"text"}'],
    ["a bullets block with no items", '{"heading":"x","blocks":[{"type":"bullets","items":[]}]}'],
    ["a heading over the cap", `{"heading":"${"h".repeat(301)}","blocks":[]}`],
    ["a list instead of an object", "[1, 2]"],
  ])("refuses %s as a value, not a throw", (_label, raw) => {
    expect(readSectionReply(raw, TARGET)).toEqual({ ok: false, reason: "invalid_output" });
  });

  it("refuses an empty reply as its own reason", () => {
    expect(readSectionReply("  \n", TARGET)).toEqual({ ok: false, reason: "empty_output" });
  });
});

describe("writing a proposal", () => {
  const ask = () => ({ tenant: owner, doc: DOC, section: TARGET, instruction: "Tighten it", agent: DOCUMENTS });

  it("makes the stub section and calls no model when the runtime is the stub", async () => {
    const collect = vi.fn();
    const written = await writeSectionProposal(ask(), { live: false, collect });
    expect(written).toEqual({ ok: true, section: stubSection(TARGET, DOCUMENTS, "Tighten it"), model: null });
    expect(collect).not.toHaveBeenCalled();
  });

  it("makes one model call under the documents harness, with no tools, and returns the model that answered", async () => {
    const calls: JobAssistantOptions[] = [];
    const collect = async (options: JobAssistantOptions): Promise<JobAssistantRun> => {
      calls.push(options);
      return {
        text: '{"heading":"Numbers","blocks":[{"type":"paragraph","text":"Tight."}]}',
        model: "stand-in-model",
      };
    };
    const controller = new AbortController();
    const written = await writeSectionProposal(
      { ...ask(), signal: controller.signal },
      { live: true, locale: "id", collect },
    );

    expect(written).toEqual({
      ok: true,
      section: { id: "numbers", heading: "Numbers", blocks: [{ type: "paragraph", text: "Tight." }] },
      model: "stand-in-model",
    });
    expect(calls).toHaveLength(1);
    const call = calls[0] as JobAssistantOptions;
    expect(call.jobMode).toBe("documents");
    expect(call.toolKeys).toBeUndefined();
    expect(call.modelExplicit).toBe(false);
    expect(call.signal).toBe(controller.signal);
    expect(call.systemPrompt).toContain("You are the Documents agent");
    expect(call.systemPrompt).toContain("Bahasa Indonesia");
    expect(call.prompt).toContain("Tighten it");
    expect(call.prompt).toContain("[intro] Introduction");
    expect(typeof call.model).toBe("string");
    expect(call.model.length).toBeGreaterThan(0);
  });

  it("returns a refusal when the model's reply is not a section", async () => {
    const collect = async (): Promise<JobAssistantRun> => ({ text: "I would rather not.", model: "m" });
    expect(await writeSectionProposal(ask(), { live: true, collect })).toEqual({ ok: false, reason: "invalid_output" });
    const empty = async (): Promise<JobAssistantRun> => ({ text: "", model: "m" });
    expect(await writeSectionProposal(ask(), { live: true, collect: empty })).toEqual({
      ok: false,
      reason: "empty_output",
    });
  });
});
