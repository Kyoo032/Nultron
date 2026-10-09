/**
 * The Finance studio's answer to a refused call, drawn on the hosted build.
 *
 * A refused parse, rewrite or write-up leaves the needs-key sentence in the studio's error state. The
 * banner hides that sentence (it would say the same thing with no link), so the calm needs-key note
 * with a Settings link has to stand in for it, even when the shared gate flag has cleared. Rendered
 * statically, like `needs-key-states.test.tsx`: the studio's error is its own state, so the view is
 * driven with the props the studio would pass.
 */
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
    readNeedsKey: false,
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
