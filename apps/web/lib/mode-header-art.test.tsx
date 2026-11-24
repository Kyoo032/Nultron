/**
 * The decorative art of a mode header is a column of its own, never a layer over the header (2026-10-01
 * UI pass). It used to be an absolute strip over the header's right 30%, so a squiggle, a ring or a
 * triangle lay on the outcome line and on the actions (the saved-dossier toggle, Run matter, the usage
 * range, the Knowledge tabs) at every desk width from 1024 up. Now the art takes space in the header's
 * flow, beside a text row that keeps the rest, and it appears only when the header is wide enough.
 *
 * Node has no layout engine, so this holds the structure, the stylesheet's contract and the shape
 * geometry. The live check is `overlap` over every route at 1440, 1280, 1100 and 1024 px (zero shape
 * boxes on a text rect or a control) with `.mode-header-art` visible from 1280.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModeHeader } from "@/components/mode-header";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(join(web, ...parts), "utf8").replace(/\r\n/g, "\n");
const css = read("app", "globals.css");

const REM = 16;
/** `width` of `.mode-header-art`, which the shape percentages are read against. */
const ART_PX = 12 * REM;

function header(props: { shapes?: boolean } = {}): string {
  return renderToStaticMarkup(
    <ModeHeader
      icon="research"
      title="Research"
      outcome="You get a dossier."
      actions={<button type="button">Reopen</button>}
      {...props}
    />,
  );
}

/** The body of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
}

describe("mode header structure", () => {
  it("puts the art after the text and the actions, in a column of its own", () => {
    const html = header();
    const art = html.indexOf('class="mode-header-art"');
    expect(art, "the art column is rendered").toBeGreaterThan(-1);
    expect(art).toBeGreaterThan(html.indexOf('data-testid="expected-inputs"'));
    expect(art).toBeGreaterThan(html.indexOf("Reopen"));
    expect(html.slice(art)).toContain("float-shapes");
    expect(html.slice(0, art), "no shapes before the text").not.toContain("float-shapes");
  });

  it("hides the shapes from assistive tech, leaves Nultron reachable, and keeps six shapes", () => {
    const html = header();
    expect(html).toMatch(/class="mode-header-art-shapes" aria-hidden="true"/);
    // Nultron hosts the page from the art column (`BuddyStage`): a named button, not decoration.
    expect(html).toContain('data-testid="buddy-stage-header"');
    expect(html).toContain('data-testid="buddy-stage-header-tap"');
    // A shape is a box (span.float-shape) around the <svg>, and the box carries the place and the size.
    expect(html.match(/<span\b[^>]*class="float-shape(?: float-shape-spin)?"/g)).toHaveLength(6);
  });

  it("does not stretch the shapes over the header with an inline style", () => {
    // The old layer set `left: auto; width: min(30%, 320px)` on the shapes' wrapper.
    expect(header()).not.toMatch(/class="float-shapes[^"]*" style=/);
  });

  it("draws no art at all for a header that is never wide enough", () => {
    const html = header({ shapes: false });
    expect(html).not.toContain("mode-header-art");
    expect(html).not.toContain("float-shapes");
    expect(html).toContain('data-testid="mode-header"');
    expect(html).toContain('data-testid="expected-inputs"');
  });

  it("opts Workspaces out of header art and keeps Settings free of decorative ModeHeader art", () => {
    expect(read("components", "workspaces-page.tsx")).toMatch(/<ModeHeader[^>]*\bshapes=\{false\}/);
    expect(read("components", "settings-page.tsx")).not.toContain("<ModeHeader");
  });
});

describe("mode header stylesheet", () => {
  it("makes the header the size container, unnamed (a name is the composer's alone)", () => {
    const body = rule(".mode-header");
    expect(body).toContain("container-type: inline-size");
    expect(body).not.toContain("container-name");
    expect(read("components", "mode-header.tsx")).toMatch(/className="mode-header\b/);
  });

  it("keeps the header's dropdowns above the page body now that it is a stacking context", () => {
    expect(rule(".mode-header")).toMatch(/z-index:\s*1;/);
  });

  it("keeps the art in the flow, out of the way when the header is narrow", () => {
    const body = rule(".mode-header-art");
    expect(body).toContain("display: none");
    expect(body).toContain("position: relative");
    expect(body).toContain("flex: none");
    expect(body).toContain("width: 12rem");
    expect(body, "never absolute: a layer over the header is the bug").not.toMatch(/position:\s*absolute/);
  });

  it("shows the art, and lets the title give up width, from 60rem of header", () => {
    const query = /@container \(min-width: 60rem\) \{([\s\S]*?)\n\}\n/.exec(css)?.[1] ?? "";
    expect(query).toMatch(/\.mode-header-art \{\s*display: flex;/);
    expect(query).toMatch(/\.mode-header-title \{\s*flex: 1 1 36rem;/);
  });

  it("thickens no shape's motion: the art settles once and never loops", () => {
    expect(rule(".mode-header-art")).not.toContain("animation");
    expect(rule(".mode-header")).not.toContain("animation");
  });
});

describe("header art geometry", () => {
  const html = renderToStaticMarkup(<ModeHeader icon="research" title="Research" />);
  const placed = [...html.matchAll(/<span\b[^>]*class="float-shape(?: float-shape-spin)?"[^>]*>/g)].map(([tag]) => ({
    size: Number(/--s:(\d+)/.exec(tag)?.[1]),
    right: Number(/right:([\d.]+)%/.exec(tag)?.[1] ?? Number.NaN),
    left: Number(/left:([\d.]+)%/.exec(tag)?.[1] ?? Number.NaN),
  }));

  it("finds its six shapes", () => {
    expect(placed).toHaveLength(6);
  });

  it("keeps every shape inside the art column, so overflow never clips one", () => {
    for (const shape of placed) {
      // Nultron stands in the middle, so the shapes keep to the two edges: each is placed from one of them.
      const edge = Number.isNaN(shape.right) ? shape.left : shape.right;
      expect(edge, "positioned from an edge").not.toBeNaN();
      const inset = (edge / 100) * ART_PX;
      expect(inset + shape.size).toBeLessThanOrEqual(ART_PX);
    }
  });
});
