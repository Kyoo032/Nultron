import { describe, expect, it } from "vitest";
import { DEFAULT_CHAT_TOOLS, getTool, invokeTool } from "@agentforge/core";
import { harnessSpecFor } from "@agentforge/core/harness";
import { getTenant } from "../tenant";
import { ensureToolsRegistered } from "../register-tools";
import { DECK_MAX_SLIDES } from "./deck-schema";
import { buildDeckTool } from "./build-deck-tool";

const slide = (n: number) => ({ heading: `Claim ${n}`, bullets: [`Point for ${n}`], notes: `Say ${n}` });

describe("the build_deck tool", () => {
  it("is an internal tool: its answer is computed by the host, never text a web page wrote", () => {
    expect(buildDeckTool.key).toBe("build_deck");
    expect(buildDeckTool.trust).toBe("internal");
  });

  it("tells the model to write in the conversation's language and to use only facts it was given", () => {
    expect(buildDeckTool.description).toMatch(/language of the conversation/i);
    expect(buildDeckTool.description).toMatch(/only facts/i);
    expect(buildDeckTool.description).toMatch(/at most 14 slides/i);
  });

  it("takes a title and one to 14 slides, and fills the optional parts", () => {
    const parsed = buildDeckTool.schema.parse({ title: "Plan", slides: [{ heading: "One" }] });
    expect(parsed).toEqual({
      title: "Plan",
      slides: [{ kind: "bullets", heading: "One", subhead: "", bullets: [], aside: "", notes: "" }],
    });
    expect(
      buildDeckTool.schema.safeParse({
        title: "Plan",
        slides: Array.from({ length: DECK_MAX_SLIDES }, (_, i) => slide(i)),
      }).success,
    ).toBe(true);
  });

  it("sets no length, count or emptiness ceiling in the schema the SDK checks", () => {
    // The SDK validates arguments before `execute`, and a failure there ends the whole turn. Every
    // ceiling is the host's to read and explain (`build-deck-limits.test.ts`), so none is here.
    const accepts = (value: unknown) => buildDeckTool.schema.safeParse(value).success;
    const over = (field: string, size: number) =>
      accepts({ title: "T", slides: [{ heading: "H", [field]: "x".repeat(size) }] });
    expect(over("notes", 5000)).toBe(true);
    expect(over("aside", 5000)).toBe(true);
    expect(over("subhead", 5000)).toBe(true);
    expect(over("heading", 5000)).toBe(true);
    expect(accepts({ title: "x".repeat(5000), slides: [{ heading: "H" }] })).toBe(true);
    expect(accepts({ title: "T", slides: [{ heading: "H", bullets: Array(40).fill("b") }] })).toBe(true);
    expect(accepts({ title: "T", slides: [{ heading: "H", bullets: ["b".repeat(5000)] }] })).toBe(true);
    expect(accepts({ title: "T", slides: Array.from({ length: DECK_MAX_SLIDES + 20 }, (_, i) => slide(i)) })).toBe(
      true,
    );
    expect(accepts({ title: "T", slides: [] })).toBe(true);
    expect(accepts({ title: "", slides: [{ heading: "" }] })).toBe(true);
    expect(accepts({ title: "T", slides: [{ heading: "H", bullets: ["", "  "] }] })).toBe(true);
  });

  it("still refuses a call that is not shaped like a deck at all", () => {
    expect(buildDeckTool.schema.safeParse({ title: "T" }).success).toBe(false);
    expect(buildDeckTool.schema.safeParse({ slides: [] }).success).toBe(false);
    expect(buildDeckTool.schema.safeParse({ title: "T", slides: "one slide" }).success).toBe(false);
    expect(buildDeckTool.schema.safeParse({ title: "T", slides: [{ bullets: ["b"] }] }).success).toBe(false);
  });

  it("reads a slide kind it does not know as a plain bullets slide, as the Presentation mode does", () => {
    const parsed = buildDeckTool.schema.parse({ title: "T", slides: [{ kind: "title", heading: "H" }] });
    expect(parsed.slides[0]?.kind).toBe("bullets");
    expect(buildDeckTool.schema.parse({ title: "T", slides: [{ kind: "split", heading: "H" }] }).slides[0]?.kind).toBe(
      "split",
    );
  });

  it("ignores fields a model invents, such as shapes and layouts, rather than refusing the deck", () => {
    const parsed = buildDeckTool.schema.parse({
      title: "T",
      slides: [{ heading: "H", bullets: ["b"], shapes: [{ id: "x" }], layout: "figure" }],
    });
    expect(parsed.slides[0]).not.toHaveProperty("shapes");
    expect(parsed.slides[0]).not.toHaveProperty("layout");
  });

  it("is registered with the other tools, bound by default Chat, and capped per run", () => {
    ensureToolsRegistered();
    expect(getTool("build_deck")).toBe(buildDeckTool);
    expect([...DEFAULT_CHAT_TOOLS]).toContain("build_deck");
    expect(harnessSpecFor("chat").budget.perTool?.build_deck).toBe(4);
  });

  it("runs through invokeTool end to end and answers the card's fields", async () => {
    const tenant = await getTenant();
    const out = await invokeTool(buildDeckTool, { title: "Roadmap", slides: [slide(1), slide(2)] }, tenant);
    expect(out).toEqual({ ok: true, artifactId: expect.any(String), filename: "roadmap.pptx", slideCount: 3 });
  });

  it("refuses arguments that are not a deck by throwing the usual invalid_tool_args", async () => {
    const tenant = await getTenant();
    await expect(invokeTool(buildDeckTool, { title: "Roadmap" }, tenant)).rejects.toMatchObject({
      code: "invalid_tool_args",
    });
  });
});
