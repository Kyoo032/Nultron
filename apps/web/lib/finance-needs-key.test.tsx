/**
 * The Finance studio's answer to a refused call, drawn on the hosted build.
 *
 * A refused parse, rewrite or write-up leaves the needs-key sentence in the studio's error state. The
 * banner hides that sentence (it would say the same thing with no link), so the calm needs-key note
 * with a Settings link has to stand in for it, even when the shared gate flag has cleared. Rendered
 * statically, like `needs-key-states.test.tsx`: the studio's error is its own state, so the view is
 * driven with the props the studio would pass.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FinanceStudioView, type FinanceStudioViewProps } from "@/components/finance-studio-view";
import { gatewayBlockedMessage } from "./gateway-blocked";
import { applyLocale, resetLocaleForTests } from "./i18n";

function view(overrides: Partial<FinanceStudioViewProps> = {}): ReactElement {
  const props: FinanceStudioViewProps = {
    showChooser: false,
    chooser: null,
    task: "brief",
    taskName: "Brief",
    taskTip: "Read a brief",
    locale: "en",
    available: true,
    productName: "Nultron",
    error: null,
    notice: null,
    needsKey: false,
    needsHint: false,
    ready: false,
    canRead: false,
    reading: false,
    result: null,
    landed: 0,
    locked: false,
    running: false,
    generateLabel: "Generate",
    phases: [],
    prompt: "",
    onPrompt: () => {},
    models: [],
    model: "",
    onModel: () => {},
    onSubmit: () => {},
    onCancel: () => {},
    onRead: () => {},
    workspaceId: null,
    regeneratingIndex: null,
    onRegenerate: () => {},
    showProgress: false,
    progress: { phases: [], sources: [], text: "", round: null, done: false, error: null },
    StepInputs: () => null,
    StepResult: () => null,
    stepProps: {
      task: "brief",
      workspaceId: null,
      locked: false,
      model: "",
      onGenerate: () => {},
      draft: {},
      setDraft: () => {},
    },
    ...overrides,
  };
  return (
    <MemoryRouter initialEntries={["/finance?task=brief"]}>
      <FinanceStudioView {...props} />
    </MemoryRouter>
  );
}

function render(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

/** The anchor that carries `testId`, whichever order its attributes came out in. */
function anchor(html: string, testId: string): string {
  return new RegExp(`<a [^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? "";
}

beforeEach(() => {
  vi.stubGlobal("__AGENTFORGE_SERVER__", "1");
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetLocaleForTests();
});

describe("a refused call on the hosted build", () => {
  it("shows the needs-key note with a Settings link in place of the error, even with the gate flag cleared", () => {
    const html = render(view({ error: gatewayBlockedMessage(), needsKey: false }));

    expect(html).toContain('data-testid="finance-needs-key"');
    expect(anchor(html, "finance-needs-key-settings")).toContain('href="/settings"');
    expect(html).not.toContain('data-testid="finance-error"');
    expect(html).not.toContain(gatewayBlockedMessage());
  });

  it("shows the same note when the shared gate says no key, and no error banner", () => {
    const html = render(view({ error: null, needsKey: true }));

    expect(html).toContain('data-testid="finance-needs-key"');
    expect(html).not.toContain('data-testid="finance-error"');
  });

  it("keeps any other failure as the red banner, with no key note", () => {
    const html = render(view({ error: "Could not read those figures", needsKey: false }));

    expect(html).toContain('data-testid="finance-error"');
    expect(html).toContain("Could not read those figures");
    expect(html).not.toContain('data-testid="finance-needs-key"');
  });

  it("speaks Indonesian on an id desk", () => {
    applyLocale("id");
    const html = render(view({ error: gatewayBlockedMessage(), locale: "id" }));

    expect(html).toContain('data-testid="finance-needs-key"');
    expect(html).toContain("Pengaturan");
  });
});

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const DISABLED = /\sdisabled=""/;

/** The opening tag of a read button. Fails loudly when the button is not drawn, so a `not.toMatch` cannot pass by accident. */
function readButton(html: string, testId: string): string {
  const tag = new RegExp(`<button [^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? "";
  expect(tag, `button ${testId} is drawn`).not.toBe("");
  return tag;
}

describe("the read-the-numbers button follows the gate on every task", () => {
  // Ratios and budget register their own read, which used to stay enabled on a closed gate: the studio
  // dropped the gate for any task with its own read. The host refuses their parse too, so the read is
  // disabled before any call, on every task.
  it("ratios: a closed gate disables the read before any call, with the note already up", () => {
    const html = render(view({ task: "ratios", needsKey: true, canRead: true }));

    expect(readButton(html, "finance-ratios-parse")).toMatch(DISABLED);
    expect(html).toContain('data-testid="finance-needs-key"');
  });

  it("budget: a closed gate disables the read before any call, with the note already up", () => {
    const html = render(view({ task: "budget", needsKey: true, canRead: true }));

    expect(readButton(html, "finance-parse")).toMatch(DISABLED);
    expect(html).toContain('data-testid="finance-needs-key"');
  });

  it.each(["cashflow", "appraisal"] as const)("%s: the shared read is disabled on a closed gate", (task) => {
    const html = render(view({ task, needsKey: true, canRead: true }));

    expect(readButton(html, "finance-parse")).toMatch(DISABLED);
  });

  // Personal parity: the gate is advisory there, so `needsKey` is false and every read stays as it was.
  // The stub runtime reports `allowed: true`, which `hostWithholdsLiveModel` already maps to false
  // (`use-desk-needs-key.test.ts`), so it reaches this same state.
  it.each(["ratios", "budget", "cashflow", "appraisal"] as const)(
    "%s with no closed gate: the read stays enabled and no note is drawn",
    (task) => {
      const html = render(view({ task, needsKey: false, canRead: true }));
      const testId = task === "ratios" ? "finance-ratios-parse" : "finance-parse";

      expect(readButton(html, testId)).not.toMatch(DISABLED);
      expect(html).not.toContain('data-testid="finance-needs-key"');
    },
  );
});

describe("the studio gives every task's read the same gate", () => {
  const studio = readFileSync(join(WEB, "components/finance-studio.tsx"), "utf8");

  it("has no per-task gate switch: the read follows needsKey alone", () => {
    expect(studio).not.toContain("needsKey && !customRead");
    expect(studio).not.toContain("readNeedsKey");
  });

  it("checks the gate before a registered read runs, so a closed gate never reaches the task's own call", () => {
    const body = studio.slice(studio.indexOf("function onRead()"), studio.indexOf("async function onGenerate"));
    const gate = body.indexOf("if (locked || needsKey)");

    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(body.indexOf("customRead.run()"));
  });
});
