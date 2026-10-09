import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");

function source(relative: string): string {
  return readFileSync(join(web, relative), "utf8");
}

describe("finance chooser mascot", () => {
  it("mounts the finance mascot on /finance with no task, in the prompt-first page's empty state", () => {
    const studio = source("components/finance-studio.tsx");
    const view = source("components/finance-studio-view.tsx");
    const auto = source("components/finance-auto.tsx");
    expect(studio).toContain('const showChooser = onFinance && (taskQuery == null || taskQuery.trim() === "");');
    // The view hands the no-task branch to the prompt-first page; it no longer draws the chooser itself.
    const branch = view.slice(view.indexOf("showChooser ? ("), view.indexOf(") : ("));
    expect(branch).toContain("chooser");
    expect(branch).not.toContain("<FinanceChooser");
    expect(studio).toContain("<FinanceAuto");
    // The empty state is the scene the old chooser opened with.
    const empty = auto.slice(auto.indexOf('data-testid="finance-auto-empty"'));
    expect(empty).toContain('<ModeIllustration mode="finance" />');
  });

  it("keeps the five task cards, now inside the closed More section", () => {
    const parts = source("components/finance-auto-parts.tsx");
    const more = parts.slice(parts.indexOf('data-testid="finance-more"'));
    expect(more).toContain("<FinanceChooser />");
    // A <details> with no `open` attribute is closed until the reader asks.
    const opening = parts.slice(parts.lastIndexOf("<details", parts.indexOf('data-testid="finance-more"')));
    expect(opening.slice(0, opening.indexOf(">") + 1)).not.toMatch(/\sopen[\s=>]/);
  });
});
