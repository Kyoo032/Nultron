import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentChatDetails, contextNearlyFull } from "@/components/agent-chat-details";
import { applyLocale, resetLocaleForTests } from "./i18n";
import { SessionFixture, type SessionSnapshot } from "./session";

vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return { ...actual, createPortal: (children: ReactNode) => children };
});

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(join(web, ...parts), "utf8").replace(/\r\n/g, "\n");

const SIGNED_IN: SessionSnapshot = {
  status: "signed-in",
  identity: { userId: "usr_1", orgId: "org_1", tenantId: "tnt_1", expiresAt: 0 },
  reason: null,
};

function details(target: HTMLElement | null): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <SessionFixture value={SIGNED_IN}>
        <AgentChatDetails target={target} usedTokens={1200} contextLength={1_050_000} parts={[]} />
      </SessionFixture>
    </MemoryRouter>,
  );
}

afterEach(() => {
  resetLocaleForTests();
});

describe("contextNearlyFull", () => {
  it("is true from 80% of the window", () => {
    expect(contextNearlyFull(79_999, 100_000)).toBe(false);
    expect(contextNearlyFull(80_000, 100_000)).toBe(true);
    expect(contextNearlyFull(120_000, 100_000)).toBe(true);
  });

  it("is false when the window is unknown", () => {
    expect(contextNearlyFull(80_000)).toBe(false);
    expect(contextNearlyFull(80_000, 0)).toBe(false);
  });
});

describe("AgentChatDetails", () => {
  it("renders nothing without a panel to land in", () => {
    expect(details(null)).toBe("");
  });

  it("puts Context and Usage under one heading in the panel", () => {
    const html = details({} as HTMLElement);
    expect(html).toContain('data-testid="agent-harness-this-chat"');
    expect(html).toContain(">Context and usage</h3>");
    expect(html).toContain('data-testid="chat-context"');
    expect(html).toContain('data-testid="chat-usage"');
  });

  it("unfolds the breakdown inline instead of opening a popover", () => {
    const html = details({} as HTMLElement);
    expect(html).not.toMatch(/data-testid="chat-context"[^>]*aria-haspopup/);
  });

  it("reads the heading in Indonesian", () => {
    applyLocale("id");
    expect(details({} as HTMLElement)).toContain(">Konteks dan pemakaian</h3>");
  });
});

describe("agent chat header", () => {
  const session = read("components", "chat-session.tsx");
  const shellHeader = session.slice(session.indexOf("<AgentChatHeader"), session.indexOf("controls={shell.controls}"));

  it("keeps Usage out of the header and Context only when the chat is nearly full", () => {
    expect(shellHeader).not.toContain("<ChatUsageChip");
    expect(shellHeader).toContain("contextNearlyFull(contextTokens");
    expect(shellHeader).toContain("<ChatAccountChip");
  });

  it("hands the panel a slot at the top of its body", () => {
    const panel = read("components", "agent-harness-panel.tsx");
    const body = panel.slice(panel.indexOf('<div className="agent-harness-body">'));
    expect(body.split("\n")[1]).toContain('className="agent-harness-details-slot"');
    expect(read("components", "agent-chat-pane.tsx")).toContain("detailsRef={setDetailsSlot}");
  });
});
