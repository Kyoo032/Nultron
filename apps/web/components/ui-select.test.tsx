import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  normalizeSelectSections,
  UiSelect,
  UiSelectOptionList,
  uiSelectKeyAction,
  type UiSelectGroup,
  type UiSelectOption,
} from "@/components/ui-select";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "ui-select.css"), "utf8").replace(/\r\n/g, "\n");
const source = readFileSync(join(here, "ui-select.tsx"), "utf8").replace(/\r\n/g, "\n");

const FLAT_OPTIONS: UiSelectOption[] = [
  { value: "16:9", label: "16:9", description: "Widescreen landscape" },
  { value: "9:16", label: "9:16", description: "Vertical portrait", badge: "Reels" },
  { value: "1:1", label: "1:1", disabled: true },
];

const GROUPED_OPTIONS: UiSelectGroup[] = [
  {
    key: "recommended",
    label: "Recommended",
    options: [
      { value: "m1", label: "Model One", badge: "$0.02/img" },
      { value: "m2", label: "Model Two", description: "Fast drafts" },
    ],
  },
  {
    key: "all",
    label: "All models",
    options: [{ value: "m3", label: "Model Three" }],
  },
];

describe("UiSelect trigger (closed)", () => {
  it("renders pill variant with prefix, selected label, and accessible listbox attributes", () => {
    const html = renderToStaticMarkup(
      <UiSelect
        options={FLAT_OPTIONS}
        value="9:16"
        onChange={() => {}}
        variant="pill"
        prefix="Aspect"
        ariaLabel="Aspect ratio"
        testId="aspect-select"
      />,
    );
    expect(html).toContain('data-testid="aspect-select"');
    expect(html).toContain('data-value="9:16"');
    expect(html).toContain('data-options="16:9,9:16,1:1"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Aspect ratio: 9:16"');
    expect(html).toContain("ui-select-trigger-pill");
    expect(html).toContain("ui-select-prefix");
    expect(html).toContain(">Aspect<");
    expect(html).toContain(">9:16<");
    expect(html).not.toContain('data-testid="aspect-select-panel"');
  });

  it("renders field variant cleanly for full-width forms", () => {
    const html = renderToStaticMarkup(
      <UiSelect
        options={FLAT_OPTIONS}
        value="16:9"
        onChange={() => {}}
        variant="field"
        testId="field-select"
      />,
    );
    expect(html).toContain("ui-select-field-root");
    expect(html).toContain("ui-select-trigger-field");
    expect(html).not.toContain("ui-select-trigger-pill");
  });

  it("disables the trigger when disabled or empty", () => {
    const off = renderToStaticMarkup(
      <UiSelect options={FLAT_OPTIONS} value="16:9" onChange={() => {}} disabled testId="s" />,
    );
    expect(off).toContain('disabled=""');
    const empty = renderToStaticMarkup(
      <UiSelect options={[]} value="" onChange={() => {}} placeholder="No models" testId="s" />,
    );
    expect(empty).toContain('disabled=""');
    expect(empty).toContain("No models");
  });
});

describe("UiSelectOptionList", () => {
  it("renders flat options with checkmark on selected, descriptions, badges, and disabled state", () => {
    const { sections, flat } = normalizeSelectSections(FLAT_OPTIONS);
    const html = renderToStaticMarkup(
      <UiSelectOptionList
        listId="sel"
        sections={sections}
        flat={flat}
        value="9:16"
        highlight={1}
        ariaLabel="Aspect"
        testId="aspect"
        onPick={() => {}}
        onHover={() => {}}
      />,
    );
    expect(html).toContain('role="listbox"');
    expect(html).toContain('aria-activedescendant="sel-opt-1"');
    expect(html.match(/role="option"/g)).toHaveLength(3);
    expect(html).toContain('data-testid="aspect-option-9:16"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("✓");
    expect(html).toContain("Vertical portrait");
    expect(html).toContain("Reels");
    expect(html).toContain('aria-disabled="true"');
  });

  it("renders grouped options with role=group and group labels", () => {
    const { sections, flat } = normalizeSelectSections(undefined, GROUPED_OPTIONS);
    const html = renderToStaticMarkup(
      <UiSelectOptionList
        listId="grp"
        sections={sections}
        flat={flat}
        value="m3"
        highlight={2}
        ariaLabel="Model"
        onPick={() => {}}
        onHover={() => {}}
      />,
    );
    expect(html.match(/role="group"/g)).toHaveLength(2);
    expect(html).toContain("Recommended");
    expect(html).toContain("All models");
    expect(html).toContain("$0.02/img");
    expect(html).toContain('aria-activedescendant="grp-opt-2"');
  });
});

describe("uiSelectKeyAction", () => {
  const state = (highlight: number, options: readonly { disabled?: boolean }[] = FLAT_OPTIONS) => ({
    highlight,
    options,
  });

  it("moves down and wraps around", () => {
    expect(uiSelectKeyAction("ArrowDown", state(0))).toEqual({ kind: "move", index: 1 });
    expect(uiSelectKeyAction("ArrowDown", state(2))).toEqual({ kind: "move", index: 0 });
  });

  it("moves up and wraps around", () => {
    expect(uiSelectKeyAction("ArrowUp", state(2))).toEqual({ kind: "move", index: 1 });
    expect(uiSelectKeyAction("ArrowUp", state(0))).toEqual({ kind: "move", index: 2 });
  });

  it("jumps with Home and End", () => {
    expect(uiSelectKeyAction("Home", state(2))).toEqual({ kind: "move", index: 0 });
    expect(uiSelectKeyAction("End", state(0))).toEqual({ kind: "move", index: 2 });
  });

  it("selects enabled option on Enter or Space, ignores disabled option", () => {
    expect(uiSelectKeyAction("Enter", state(0))).toEqual({ kind: "select", index: 0 });
    expect(uiSelectKeyAction(" ", state(1))).toEqual({ kind: "select", index: 1 });
    expect(uiSelectKeyAction("Enter", state(2))).toEqual({ kind: "none" });
    expect(uiSelectKeyAction(" ", state(2))).toEqual({ kind: "none" });
  });

  it("closes on Escape and Tab", () => {
    expect(uiSelectKeyAction("Escape", state(1))).toEqual({ kind: "close" });
    expect(uiSelectKeyAction("Tab", state(1))).toEqual({ kind: "close" });
  });

  it("handles empty list safely", () => {
    expect(uiSelectKeyAction("ArrowDown", state(0, []))).toEqual({ kind: "none" });
    expect(uiSelectKeyAction("Escape", state(0, []))).toEqual({ kind: "close" });
  });
});

describe("UiSelect architecture & motion contract", () => {
  it("portals the panel using placePickerPanel and closes on outside click", () => {
    expect(source).toContain("createPortal");
    expect(source).toContain("placePickerPanel");
    expect(source).toContain('document.addEventListener("mousedown"');
  });

  it("uses only theme and motion tokens in ui-select.css (no hex, rgb, literal duration or keyframes)", () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\(/);
    expect(css).not.toMatch(/@keyframes|animation|infinite/);
    expect(css).not.toMatch(/\d(ms|s)\b/);
    expect(css).toContain("var(--motion-hover)");
    expect(css).toContain("var(--accent-soft)");
    expect(css).toContain("var(--surface)");
  });
});
