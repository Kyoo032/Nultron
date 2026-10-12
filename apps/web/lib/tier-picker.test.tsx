/**
 * The tier picker: the three choices that replace the model picker in Chat (model-tiers spec, section 5).
 *
 * The environment is node with no DOM (see `model-picker.test.tsx`), so this holds what can be held there:
 * the closed markup the trigger renders, the option list the panel is made of (rendered on its own,
 * without the portal), the key decisions the panel makes (a pure function), and the shape of the
 * stylesheet. The click, Escape and focus-return sequence is driven live: `features/model-tiers.md`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { MODEL_TIERS } from "@agentforge/core/tiers";
import { TierOptionList, TierPicker, tierKeyAction } from "@/components/tier-picker";
import { applyLocale, resetLocaleForTests } from "./i18n";
import type { ChatTierInfo } from "./chat-tier-pref";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(web, "components", "tier-picker.tsx"), "utf8").replace(/\r\n/g, "\n");
const css = readFileSync(join(web, "components", "tier-picker.css"), "utf8").replace(/\r\n/g, "\n");

function tier(id: ChatTierInfo["id"], available = true): ChatTierInfo {
  return { id, available, inputModalities: ["text"], contextLength: null };
}

const ALL: ChatTierInfo[] = [tier("daily"), tier("fast"), tier("reasoning")];
const NO_REASONING: ChatTierInfo[] = [tier("daily"), tier("fast"), tier("reasoning", false)];

afterEach(() => resetLocaleForTests());

describe("the trigger, closed", () => {
  it("is a listbox button showing only the current tier's label", () => {
    const html = renderToStaticMarkup(<TierPicker tiers={ALL} value="fast" onChange={() => {}} />);
    expect(html).toContain('data-testid="tier-picker"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-testid="tier-picker-panel"');
    const visible = /<button[^>]*data-testid="tier-picker"[^>]*>([\s\S]*?)<\/button>/.exec(html)?.[1] ?? "";
    expect(visible.replace(/<[^>]*>/g, "").trim()).toBe("Fastest");
  });

  it("names itself for assistive technology and keeps the visible words inside that name", () => {
    const html = renderToStaticMarkup(<TierPicker tiers={ALL} value="daily" onChange={() => {}} />);
    const label = /<button[^>]*aria-label="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(label).toContain("Daily");
    expect(label.length).toBeGreaterThan("Daily".length);
  });

  it("shows the label for each tier in both languages", () => {
    const english = { daily: "Daily", fast: "Fastest", reasoning: "Reasoning" } as const;
    const indonesian = { daily: "Harian", fast: "Tercepat", reasoning: "Penalaran" } as const;
    for (const id of MODEL_TIERS) {
      const html = renderToStaticMarkup(<TierPicker tiers={ALL} value={id} onChange={() => {}} />);
      expect(html).toContain(`>${english[id]}<`);
    }
    applyLocale("id");
    for (const id of MODEL_TIERS) {
      const html = renderToStaticMarkup(<TierPicker tiers={ALL} value={id} onChange={() => {}} />);
      expect(html).toContain(`>${indonesian[id]}<`);
    }
  });

  it("has no model prefix and no model-picker testid", () => {
    const html = renderToStaticMarkup(<TierPicker tiers={ALL} value="daily" onChange={() => {}} />);
    expect(html).not.toContain("Model:");
    expect(html).not.toContain('data-testid="model-picker"');
    expect(html).not.toContain("model-picker-prefix");
  });

  it("is disabled when told to be, and when the host listed no tiers", () => {
    const tag = (html: string) =>
      (html.match(/<button[^>]*>/g) ?? []).find((open) => open.includes('data-testid="tier-picker"')) ?? "";
    const off = renderToStaticMarkup(<TierPicker tiers={ALL} value="daily" onChange={() => {}} disabled />);
    expect(tag(off)).toContain('disabled=""');
    const empty = renderToStaticMarkup(<TierPicker tiers={[]} value="daily" onChange={() => {}} />);
    expect(tag(empty)).toContain('disabled=""');
    expect(empty).toContain(">Daily<");
    const on = renderToStaticMarkup(<TierPicker tiers={ALL} value="daily" onChange={() => {}} />);
    expect(tag(on)).not.toContain('disabled=""');
  });

  it("keeps the composer grid's hooks, so the layout the toolbar already has places it", () => {
    const html = renderToStaticMarkup(<TierPicker tiers={ALL} value="daily" onChange={() => {}} />);
    expect(html).toContain('class="tier-picker model-picker"');
    const trigger =
      (html.match(/<button[^>]*>/g) ?? []).find((open) => open.includes('data-testid="tier-picker"')) ?? "";
    expect(trigger).toMatch(/class="[^"]*\bmodel-picker-trigger\b/);
  });
});

describe("the options", () => {
  function list(value: ChatTierInfo["id"], tiers: ChatTierInfo[] = ALL, highlight = 0): string {
    return renderToStaticMarkup(
      <TierOptionList
        listId="t"
        tiers={tiers}
        value={value}
        highlight={highlight}
        onPick={() => {}}
        onHover={() => {}}
      />,
    );
  }

  it("has one option per tier, each with its own testid", () => {
    const html = list("daily");
    expect(html.match(/role="option"/g)).toHaveLength(3);
    for (const id of MODEL_TIERS) {
      expect(html).toContain(`data-testid="tier-option-${id}"`);
    }
    expect(html).toContain('role="listbox"');
  });

  it("marks the current tier selected and no other", () => {
    const html = list("fast");
    const options = html.match(/<li[^>]*>/g) ?? [];
    const selected = options.filter((li) => li.includes('aria-selected="true"'));
    expect(selected).toHaveLength(1);
    expect(selected[0]).toContain('data-testid="tier-option-fast"');
  });

  it("says what each choice is for, from the catalog", () => {
    const html = list("daily");
    expect(html).toContain("Good answers at a sensible speed");
    expect(html).toContain("Answers first, for short questions and drafts");
    expect(html).toContain("Thinks before it answers, for hard problems");
    applyLocale("id");
    const id = list("daily");
    expect(id).toContain("Harian");
    expect(id).toContain("Tercepat");
    expect(id).toContain("Penalaran");
    expect(id).not.toContain("Good answers");
  });

  it("marks an unavailable tier disabled and says so, and does not mark an available one", () => {
    const html = list("daily", NO_REASONING);
    const options = html.match(/<li[^>]*>/g) ?? [];
    const reasoning = options.find((li) => li.includes('data-testid="tier-option-reasoning"')) ?? "";
    const daily = options.find((li) => li.includes('data-testid="tier-option-daily"')) ?? "";
    expect(reasoning).toContain('aria-disabled="true"');
    expect(daily).not.toContain("aria-disabled");
    expect(html.match(/Unavailable/g)).toHaveLength(1);
    applyLocale("id");
    expect(list("daily", NO_REASONING)).toContain("Tidak tersedia");
  });

  it("points assistive technology at the highlighted option", () => {
    expect(list("daily", ALL, 1)).toContain('aria-activedescendant="t-opt-fast"');
    expect(list("daily", ALL, 2)).toContain('id="t-opt-reasoning"');
  });

  it("is labelled, and never prints a model id", () => {
    const html = list("daily");
    expect(html).toMatch(/<ul[^>]*aria-label="[^"]+"/);
    expect(html).not.toMatch(/gpt|claude|gemini|deepseek|kimi|glm|qwen/i);
  });
});

describe("tierKeyAction", () => {
  const state = (highlight: number, tiers: readonly { available: boolean }[] = ALL) => ({ highlight, tiers });

  it("moves down and wraps at the end", () => {
    expect(tierKeyAction("ArrowDown", state(0))).toEqual({ kind: "move", index: 1 });
    expect(tierKeyAction("ArrowDown", state(2))).toEqual({ kind: "move", index: 0 });
  });

  it("moves up and wraps at the start", () => {
    expect(tierKeyAction("ArrowUp", state(2))).toEqual({ kind: "move", index: 1 });
    expect(tierKeyAction("ArrowUp", state(0))).toEqual({ kind: "move", index: 2 });
  });

  it("jumps to the ends", () => {
    expect(tierKeyAction("Home", state(2))).toEqual({ kind: "move", index: 0 });
    expect(tierKeyAction("End", state(0))).toEqual({ kind: "move", index: 2 });
  });

  it("selects the highlighted tier on Enter or Space", () => {
    expect(tierKeyAction("Enter", state(1))).toEqual({ kind: "select", index: 1 });
    expect(tierKeyAction(" ", state(2))).toEqual({ kind: "select", index: 2 });
  });

  it("does not select a tier that is unavailable", () => {
    expect(tierKeyAction("Enter", state(2, NO_REASONING))).toEqual({ kind: "none" });
    expect(tierKeyAction(" ", state(2, NO_REASONING))).toEqual({ kind: "none" });
  });

  it("closes on Escape and on Tab", () => {
    expect(tierKeyAction("Escape", state(1))).toEqual({ kind: "close" });
    expect(tierKeyAction("Tab", state(1))).toEqual({ kind: "close" });
  });

  it("ignores every other key", () => {
    for (const key of ["a", "Shift", "ArrowLeft", "ArrowRight", "Backspace"]) {
      expect(tierKeyAction(key, state(0))).toEqual({ kind: "none" });
    }
  });

  it("copes with an empty list", () => {
    expect(tierKeyAction("ArrowDown", state(0, []))).toEqual({ kind: "none" });
    expect(tierKeyAction("ArrowUp", state(0, []))).toEqual({ kind: "none" });
    expect(tierKeyAction("Enter", state(0, []))).toEqual({ kind: "none" });
    expect(tierKeyAction("Escape", state(0, []))).toEqual({ kind: "close" });
  });

  it("copes with a highlight that is out of range", () => {
    expect(tierKeyAction("Enter", state(9))).toEqual({ kind: "none" });
    expect(tierKeyAction("ArrowDown", state(9))).toEqual({ kind: "move", index: 0 });
    expect(tierKeyAction("ArrowUp", state(-3))).toEqual({ kind: "move", index: 2 });
  });
});

describe("the component's source", () => {
  it("imports its own stylesheet and nothing from globals.css", () => {
    expect(source).toContain('import "@/components/tier-picker.css"');
  });

  it("opens from the keyboard the way a button does, and also from an arrow key", () => {
    expect(source).toContain('event.key === "ArrowDown"');
    expect(source).toContain('data-testid="tier-picker"');
    expect(source).toContain('data-testid="tier-picker-panel"');
    expect(source).toContain("data-testid={`tier-option-${");
  });

  it("returns focus to the trigger on Escape and closes on a click outside", () => {
    expect(source).toContain("focusAfterClose");
    expect(source).toContain('closePanel("escape")');
    expect(source).toContain('closePanel("outside")');
    expect(source).toContain('document.addEventListener("mousedown"');
  });

  it("has no search box, no group and no model id", () => {
    expect(source).not.toMatch(/type="search"|role="combobox"|pickerGroups|\.id\.toLowerCase/);
    expect(source).not.toMatch(/gpt-|claude-|gemini-|deepseek|kimi-/);
  });
});

describe("the stylesheet", () => {
  it("draws a visible keyboard focus state on the trigger and the active option", () => {
    expect(css).toMatch(/\.tier-picker-trigger:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/);
    expect(css).toMatch(/\.tier-picker-list:focus-visible \.tier-picker-option\[data-active="true"\]\s*\{[^}]*outline/);
  });

  it("paints from the theme's variables, so it works in light and dark", () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\(/);
    for (const token of ["--line", "--surface", "--text", "--text-3", "--accent-soft"]) {
      expect(css, token).toContain(`var(${token})`);
    }
  });

  it("gives an option a 44px touch target and lets the hint wrap on a phone", () => {
    expect(css).toMatch(/\.tier-picker-option\s*\{[^}]*min-height:\s*2\.75rem/);
    expect(css).toMatch(/\.tier-picker-hint\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  it("dims an unavailable option and shows it is not clickable", () => {
    expect(css).toMatch(/\.tier-picker-option\[aria-disabled="true"\]\s*\{[^}]*cursor:\s*not-allowed/);
    expect(css).toMatch(/\.tier-picker-option\[aria-disabled="true"\]\s*\{[^}]*opacity:/);
  });

  it("does not animate: no keyframes, no loop, no literal duration", () => {
    expect(css).not.toMatch(/@keyframes|animation|infinite/);
    expect(css).not.toMatch(/\d(ms|s)\b/);
  });
});
