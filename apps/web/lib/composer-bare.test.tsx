/**
 * The bare composer (virtual agents): one rounded bar that is a `+`, the message box and a round Send.
 * Everything else (Add files, Enhance, the tier picker) lives in the menu under the `+`.
 *
 * The environment is node with no layout engine, so this holds what a render can show (the markup, the
 * names, the order of the parts, the optional props) and the shape of the stylesheet. The menu's focus,
 * Escape and outside-click behaviour needs a browser; the key decision it makes is a pure function and is
 * tested here. `composer-layout.test.tsx` keeps the testids the drives rely on, and
 * `chat-run-stream.test.ts` holds the `tool.progress` reader.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ChatComposer } from "@/components/chat-composer";
import { menuKeyAction } from "@/components/composer-plus-menu";
import { applyLocale, resetLocaleForTests } from "./i18n";
import type { ChatTierInfo } from "./chat-tier-pref";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(join(web, ...parts), "utf8").replace(/\r\n/g, "\n");
const css = read("components", "composer-bare.css");
const composerSource = read("components", "chat-composer.tsx");

const TIERS: ChatTierInfo[] = (["daily", "fast", "reasoning"] as const).map((id) => ({
  id,
  available: true,
  inputModalities: ["text"],
  contextLength: null,
}));

function markup(extra: Partial<Parameters<typeof ChatComposer>[0]> = {}): string {
  return renderToStaticMarkup(
    <ChatComposer threadId={null} modalities={["text"]} onDelta={() => {}} onComplete={() => {}} {...extra} />,
  );
}

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(match, `${selector} must have a rule in composer-bare.css`).not.toBeNull();
  return match?.[1] ?? "";
}

afterEach(() => resetLocaleForTests());

describe("the bar", () => {
  it("keeps the shell's container class and test id, and gains the bare class", () => {
    const html = markup();
    expect(html).toMatch(/<form class="composer-shell composer-bare[ "][^>]*data-testid="composer"/);
    // The dashed dropzone border is gone; the ring shows only while a file is over the bar.
    expect(html).not.toContain("border-dashed");
    expect(rule('.composer-bare[data-dragover="true"]')).toContain("border-color: var(--accent)");
  });

  it("is a plus, the message box and Send, in that order, in one row", () => {
    const html = markup();
    const row = html.slice(html.indexOf('data-testid="composer-dropzone"'));
    const plus = row.indexOf('data-testid="composer-plus"');
    const text = row.indexOf('data-testid="composer-text"');
    const send = row.indexOf('data-testid="composer-send"');
    expect(plus).toBeGreaterThan(-1);
    expect(text).toBeGreaterThan(plus);
    expect(send).toBeGreaterThan(text);
    expect(html).toMatch(/<div class="composer-bare-row" data-testid="composer-dropzone">/);
  });

  it("is a pill with a hairline border, a surface fill and no heavy shadow", () => {
    const bar = rule(".composer-bare");
    expect(bar).toContain("border-radius: 26px");
    expect(bar).toContain("border: 1px solid var(--line)");
    expect(bar).toContain("background: var(--surface)");
    // Only the focus ring of a drag adds one; the resting bar has none (its transition may name it).
    expect(bar).not.toMatch(/^\s*box-shadow:/m);
  });

  it("grows downward with the text, to about eight lines, and holds one line at every width", () => {
    expect(rule(".composer-bare-text")).toContain("max-height: 10rem");
    // Two classes, so it beats the two-line floor globals.css sets below 600px.
    expect(rule(".composer-bare .composer-bare-text")).toContain("min-height: 36px");
    expect(rule(".composer-bare-row")).toContain("align-items: flex-end");
  });

  it("draws the chips, the notes, the error and the needs-key line under the row, inside the form", () => {
    const html = markup();
    expect(html.indexOf('class="composer-bare-under"')).toBeGreaterThan(html.indexOf('data-testid="composer-send"'));
    expect(html.indexOf("</form>")).toBeGreaterThan(html.indexOf('class="composer-bare-under"'));
  });

  it("keeps the hidden file input in the composer, out of the tab order", () => {
    const html = markup();
    expect(html).toMatch(/<input class="sr-only" type="file"[^>]*tabindex="-1"[^>]*aria-hidden="true"/);
    expect(html).toContain('data-testid="composer-file"');
  });
});

describe("the plus", () => {
  it("is a menu button with a name, closed on first render", () => {
    const html = markup();
    expect(html).toMatch(/data-testid="composer-plus" aria-haspopup="menu" aria-expanded="false"/);
    expect(html).toMatch(/data-testid="composer-plus"[^>]*aria-label="Add"[^>]*title="Add"/);
  });

  it("opens a menu that is hidden while closed and still holds its rows", () => {
    const html = markup();
    expect(html).toMatch(
      /<div id="[^"]+" class="composer-plus-menu[^"]*" role="menu" data-testid="composer-plus-menu" hidden=""/,
    );
    expect(html).toContain('data-testid="composer-attach"');
    expect(html).toContain("<span>Add files</span>");
    expect(html).toContain('data-testid="composer-enhance"');
    // The plus points at its menu.
    const controls = /aria-controls="([^"]+)"/.exec(html)?.[1];
    expect(controls).toBeTruthy();
    expect(html).toContain(`id="${controls}"`);
  });

  it("opens upward, and lets the hidden attribute win over its flex display", () => {
    expect(rule(".composer-plus-menu")).toContain("bottom: calc(100% + 10px)");
    expect(rule(".composer-plus-menu[hidden]")).toContain("display: none");
  });

  it("names itself in Indonesian", () => {
    applyLocale("id");
    const html = markup();
    expect(html).toMatch(/data-testid="composer-plus"[^>]*aria-label="Tambah"/);
    expect(html).toContain("<span>Tambah berkas</span>");
  });
});

describe("the tier picker", () => {
  it("is not drawn when the pane gives no way to change the tier", () => {
    const html = markup();
    expect(html).not.toContain('data-testid="tier-picker"');
    expect(html).not.toContain("tier-picker-trigger");
  });

  it("is the last row of the menu when the pane does", () => {
    const html = markup({ tier: "daily", tiers: TIERS, onTierChange: () => {} });
    const menu = html.slice(
      html.indexOf('data-testid="composer-plus-menu"'),
      html.indexOf('data-testid="composer-text"'),
    );
    expect(menu).toContain('data-testid="tier-picker"');
    // The grid hook the picker wears; `.composer-plus-menu .model-picker` in composer-bare.css styles it.
    expect(menu).toContain('class="tier-picker model-picker"');
    expect(menu.indexOf('data-testid="composer-enhance"')).toBeLessThan(menu.indexOf('data-testid="tier-picker"'));
  });
});

describe("Send", () => {
  it("is a round icon button with a name, quiet while the box is empty", () => {
    const html = markup();
    expect(html).toMatch(/<button type="submit" class="composer-send[^"]*" disabled="" aria-label="Send" title="Send"/);
    expect(html).toMatch(/data-testid="composer-send"><svg[^>]*aria-hidden="true"/);
    expect(rule(".composer-bare .composer-send")).toContain("border-radius: 50%");
    expect(rule(".composer-bare .composer-send")).toContain("width: 36px");
    expect(rule(".composer-bare .composer-send")).toContain("height: 36px");
  });

  it("names itself in Indonesian", () => {
    applyLocale("id");
    expect(markup()).toMatch(/aria-label="Kirim"/);
  });
});

describe("the placeholder", () => {
  it("is Chat's line by default", () => {
    expect(markup()).toContain('placeholder="Ask anything, or drop a screenshot, clip, or document"');
  });

  it("is the one a pane passes", () => {
    expect(markup({ placeholder: "Message Research" })).toContain('placeholder="Message Research"');
  });
});

describe("the menu's keys", () => {
  it("moves between rows, wraps, and jumps to the ends", () => {
    expect(menuKeyAction("ArrowDown", 0, 3)).toEqual({ kind: "move", index: 1 });
    expect(menuKeyAction("ArrowDown", 2, 3)).toEqual({ kind: "move", index: 0 });
    expect(menuKeyAction("ArrowUp", 0, 3)).toEqual({ kind: "move", index: 2 });
    expect(menuKeyAction("Home", 2, 3)).toEqual({ kind: "move", index: 0 });
    expect(menuKeyAction("End", 0, 3)).toEqual({ kind: "move", index: 2 });
  });

  it("lands on the first row going down, and the last going up, when focus is outside the rows", () => {
    expect(menuKeyAction("ArrowDown", -1, 3)).toEqual({ kind: "move", index: 0 });
    expect(menuKeyAction("ArrowUp", -1, 3)).toEqual({ kind: "move", index: 2 });
  });

  it("leaves other keys, and an empty menu, alone", () => {
    expect(menuKeyAction("a", 0, 3)).toEqual({ kind: "none" });
    expect(menuKeyAction("Enter", 0, 3)).toEqual({ kind: "none" });
    expect(menuKeyAction("ArrowDown", -1, 0)).toEqual({ kind: "none" });
  });

  it("closes on Escape, an outside press and a chosen row, and leaves the tier panel's own keys to it", () => {
    const menu = read("components", "composer-plus-menu.tsx");
    expect(menu).toContain('event.key !== "Escape"');
    expect(menu).toContain("event.defaultPrevented");
    expect(menu).toContain('document.addEventListener("mousedown"');
    expect(menu).toContain(".tier-picker-panel");
    // Escape returns focus to the plus.
    expect(menu).toMatch(/close\(true\);\s*\}\s*\n\s*\n\s*function onClick/);
  });
});

describe("the wiring", () => {
  it("imports its stylesheet and the menu, and hands the menu the file picker", () => {
    expect(composerSource).toContain('import "@/components/composer-bare.css";');
    expect(composerSource).toContain("<ComposerPlusMenu");
    expect(composerSource).toContain("onAddFiles={() => fileInputRef.current?.click()}");
  });

  it("passes the tool-progress prop into the live handlers", () => {
    expect(composerSource).toMatch(/const live: RunStreamHandlers = \{[^}]*onToolProgress,/);
    expect(composerSource).toContain("onToolProgress?: (event: { toolKey: string; label: string }) => void;");
  });

  // 773 lines before the bare layout, plus 14 that main's model-fallback wiring (SH-007, PR #150)
  // added in the 2026-10-12 merge. The tester's own changes still may not grow the file.
  it("does not grow: the file stays within 787 lines (773 before the bare layout, plus main's SH-007)", () => {
    expect(composerSource.split("\n").length).toBeLessThanOrEqual(787);
  });
});
