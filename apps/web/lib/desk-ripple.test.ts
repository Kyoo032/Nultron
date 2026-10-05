import { describe, expect, it } from "vitest";
import { type BackgroundNode, type BackgroundProbe, isBackgroundTarget } from "./desk-ripple";

/**
 * What counts as the empty desk, against a fake tree: the browser's own answers (cursor, painted surface,
 * scrollbar) come from a probe, so every rule is a plain assertion. The live drive is in
 * `.cursor/skills/verify-agentforge/features/chat.md`, "Desk background".
 */

type Spec = {
  tag?: string;
  attrs?: Record<string, string>;
  text?: string;
  cursor?: string;
  paints?: boolean;
  scrollbar?: boolean;
};

type Fake = BackgroundNode & { spec: Spec };

/** A chain from the desk down: `chain([a, b, c])` is desk > a > b > c, and returns every node, target last. */
function chain(specs: Spec[]): { desk: Fake; nodes: Fake[] } {
  const desk: Fake = { nodeType: 1, parentNode: null, tagName: "DIV", spec: {} };
  let parent: Fake = desk;
  const nodes: Fake[] = [];
  for (const spec of specs) {
    const node: Fake = {
      nodeType: 1,
      parentNode: parent,
      tagName: (spec.tag ?? "div").toUpperCase(),
      childNodes: spec.text ? [{ nodeType: 3, nodeValue: spec.text }] : [],
      getAttribute: (name: string) => spec.attrs?.[name] ?? null,
      spec,
    };
    nodes.push(node);
    parent = node;
  }
  return { desk, nodes };
}

const probe: BackgroundProbe = (node) => {
  const { cursor = "auto", paints = false, scrollbar = false } = (node as Fake).spec;
  return { cursor, paints, scrollbar };
};

const at = { x: 10, y: 10 };
const bare = (specs: Spec[]) => {
  const { desk, nodes } = chain(specs);
  return isBackgroundTarget(nodes[nodes.length - 1] ?? desk, desk, probe, at);
};

describe("isBackgroundTarget", () => {
  it("is true for plain layout all the way up", () => {
    expect(bare([{}, {}, {}])).toBe(true);
  });

  it("is true for the desk itself, which is the backdrop", () => {
    const { desk } = chain([]);
    expect(isBackgroundTarget(desk, desk, probe, at)).toBe(true);
  });

  it("is false without a target, or for one that is not inside the desk", () => {
    const { desk } = chain([{}]);
    expect(isBackgroundTarget(null, desk, probe, at)).toBe(false);
    const stranger: Fake = { nodeType: 1, parentNode: null, tagName: "DIV", spec: {} };
    expect(isBackgroundTarget(stranger, desk, probe, at)).toBe(false);
  });

  it("is false on a control, a link, a field or a piece of media, whatever sits above it", () => {
    for (const tag of ["button", "a", "input", "select", "textarea", "summary", "label", "video", "img", "svg", "canvas"]) {
      expect(bare([{}, { tag }]), tag).toBe(false);
    }
  });

  it("is false inside a control: a press on the icon in a button is a press on the button", () => {
    expect(bare([{ tag: "button" }, { tag: "span" }, { tag: "svg" }])).toBe(false);
  });

  it("is false for an ARIA widget, an editable region, a tab stop and an opt-out", () => {
    expect(bare([{ attrs: { role: "tab" } }])).toBe(false);
    expect(bare([{ attrs: { role: "menuitem" } }])).toBe(false);
    expect(bare([{ attrs: { contenteditable: "true" } }])).toBe(false);
    expect(bare([{ attrs: { tabindex: "0" } }])).toBe(false);
    expect(bare([{ attrs: { "data-no-ripple": "" } }])).toBe(false);
  });

  it("is true for a region that is explicitly not a tab stop or not editable", () => {
    expect(bare([{ attrs: { tabindex: "-1" } }])).toBe(true);
    expect(bare([{ attrs: { contenteditable: "false" } }])).toBe(true);
  });

  it("is false when the target holds text of its own, and true when only a child does", () => {
    expect(bare([{ text: "Documents" }])).toBe(false);
    expect(bare([{ text: "   \n " }])).toBe(true);
    // The text is in a child, so the wrapper above it is bare layout: a press on the wrapper's own padding.
    const { desk, nodes } = chain([{}, { text: "A heading" }]);
    expect(isBackgroundTarget(nodes[0] as Fake, desk, probe, at)).toBe(true);
  });

  it("is false on anything that paints a surface, and on its padding", () => {
    expect(bare([{ paints: true }])).toBe(false);
    // A card with a transparent wrapper inside it: the press is on the card.
    expect(bare([{ paints: true }, {}, {}])).toBe(false);
  });

  it("is false on a pointer cursor, which is how a clickable div says so", () => {
    expect(bare([{ cursor: "pointer" }])).toBe(false);
    expect(bare([{ cursor: "pointer" }, {}])).toBe(false);
  });

  it("is false on a scrollbar", () => {
    expect(bare([{ scrollbar: true }])).toBe(false);
  });

  it("does not read nodes above the desk", () => {
    const { desk, nodes } = chain([{}]);
    // Something above the desk would fail every rule; the walk must stop at the desk.
    desk.parentNode = { nodeType: 1, parentNode: null, tagName: "BUTTON", getAttribute: () => null };
    expect(isBackgroundTarget(nodes[0] as Fake, desk, probe, at)).toBe(true);
  });
});
