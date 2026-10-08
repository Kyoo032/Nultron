/**
 * The prompt-first Finance page, read from its sources the way the other Finance wiring tests are (this
 * package runs vitest without a DOM). What these pin is the owner's rule from 2026-10-05: on a drop only
 * the free steps run, and the paid write-up runs on the person's press and on nothing else.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");

function source(relative: string): string {
  return readFileSync(join(web, relative), "utf8");
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const studio = source("components/finance-studio.tsx");
const view = source("components/finance-studio-view.tsx");
const auto = source("components/finance-auto.tsx");
const parts = source("components/finance-auto-parts.tsx");
const hook = source("lib/use-finance-auto-read.ts");
const io = source("lib/finance-auto-io.ts");
const client = source("lib/finance-auto-client.ts");

describe("nothing paid runs on a drop", () => {
  it("calls the write-up route from exactly one place, the form's submit handler", () => {
    expect(occurrences(auto, "/api/v1/finance/stream")).toBe(1);
    expect(occurrences(auto, "job.run(")).toBe(1);
    const submit = auto.slice(auto.indexOf("async function onWrite"), auto.indexOf("async function onRegenerate"));
    expect(submit).toContain("job.run(");
    expect(submit).toContain("event.preventDefault()");
    // The one button that submits the form is the Write it up button.
    expect(occurrences(auto, 'type="submit"')).toBe(1);
    expect(auto).toContain('data-testid="finance-auto-write"');
  });

  it("never reaches a paid route from the read, the file step or the helpers", () => {
    for (const [name, text] of [
      ["use-finance-auto-read.ts", hook],
      ["finance-auto-io.ts", io],
      ["finance-auto-client.ts", client],
      ["finance-auto-parts.tsx", parts],
    ] as const) {
      // Comments say which route is the paid one; code must not call it.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, name).not.toContain("/finance/stream");
      expect(code, name).not.toContain("/finance/parse");
      expect(code, name).not.toContain("/finance/regenerate");
      expect(code, name).not.toContain("job.run");
    }
    // The only routes the free read touches are the import and the auto route.
    expect(io).toContain("importFinanceFile");
    expect(client).toContain('"/api/v1/finance/auto"');
  });

  it("drops a file into the free read and the write-up stays quiet until pressed", () => {
    const onFile = auto.slice(auto.indexOf("async function onFile"), auto.indexOf("function onRemove"));
    expect(onFile).toContain("readFinanceFileForAuto(next)");
    expect(onFile).not.toContain("job.run");
    expect(onFile).not.toContain("onWrite");
  });

  it("keeps the write-up button quiet without a preview, while a read is in flight, and on a desk with no key", () => {
    expect(auto).toContain(
      "const writable = answer !== null && canWriteUp(answer) && !read.checking && !locked && !reading && !needsKey;",
    );
    expect(auto).toContain("disabled={!writable}");
  });

  it("shows a write-up failure under the button that was pressed, and a read failure by the inputs", () => {
    const row = auto.slice(auto.indexOf('data-testid="finance-auto-write-row"'), auto.indexOf("{showProgress ?"));
    expect(row).toContain('data-testid="finance-auto-write-error"');
    expect(row).not.toContain('data-testid="finance-auto-error"');
    expect(auto).toContain("const readError = shown(fileError ?? read.error);");
    expect(auto).toContain("const writeError = shown(actionError ?? job.error?.message ?? null);");
    // The refused-for-no-key sentence stays out of both banners: the needs-key note says it calmly.
    expect(auto).toContain("isGatewayBlockedText(message)");
  });

  it("says in one line that the write-up uses the key", () => {
    expect(auto).toContain('data-testid="finance-auto-write-note"');
    expect(auto).toContain('t("finance.auto.writeNote")');
  });
});

describe("the page is the studio's no-task branch", () => {
  it("shows it from the studio and hands it the same model picker the task pages use", () => {
    expect(studio).toContain('import { FinanceAuto } from "@/components/finance-auto";');
    expect(studio).toContain("<FinanceAuto");
    expect(studio).toContain("modelPinned={modelPinned}");
    expect(studio).toContain("onModel={setModel}");
    expect(view).toContain("chooser: ReactNode;");
    expect(view).toContain('outcomeTestId={showChooser ? "finance-guide-lead" : "expected-inputs"}');
  });

  it("stays a shell under the 400 line ceiling, and the page itself is split into parts", () => {
    expect(studio.split(/\r?\n/).length).toBeLessThan(400);
    expect(auto.split(/\r?\n/).length).toBeLessThan(400);
    expect(parts.split(/\r?\n/).length).toBeLessThan(400);
  });

  it("reads a seeded draft when a task page opens, even for the brief whose scope id does not change", () => {
    expect(studio).toMatch(/const draftKey = showChooser \? `\$\{scopeKey\}\|choose` : scopeKey;/);
    expect(studio).toContain("if (lastScopeRef.current === draftKey) {");
    expect(studio).toContain("skipSaveRef.current = true;");
  });
});

describe("the budget limit that is shown is the limit that is sent", () => {
  it("builds every request's parameter bag through the budget defaults", () => {
    expect(studio).toContain('import { budgetRequestParams } from "@/lib/finance-budget";');
    expect(studio).toContain("const requestParams = budgetRequestParams(task, params);");
    expect(studio).toContain("params: requestParams,");
    // inputsBody() is the one place a generate and a rewrite get their inputs from.
    expect(studio).toContain("return { ...briefInputsBody(briefState), task };");
  });
});

describe("what More holds", () => {
  it("keeps the model, the pasted rows, the other tasks, the rows check and the chooser inside the closed section", () => {
    const more = parts.slice(parts.indexOf('data-testid="finance-more"'));
    for (const id of [
      "finance-auto-figures",
      "finance-auto-model",
      "finance-auto-check-rows",
      "finance-auto-switch-",
      "<FinanceChooser />",
    ]) {
      expect(more, id).toContain(id);
    }
  });

  it("opens a task by seeding its draft first, so the task page opens with the figures in its box", () => {
    expect(parts).toContain("onClick={open(answer.task)}");
    expect(parts).toContain("onClick={open(task)}");
    expect(parts).toContain("openTaskWithDraft(workspaceId, task, { prompt, figures })");
  });
});
