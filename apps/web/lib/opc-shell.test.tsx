import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentRail, AgentRailView, type AgentRailViewProps } from "@/components/agent-rail";
import { AppShell } from "@/components/app-shell";
import { BrandMark } from "@/components/brand-mark";
import { ChatLauncher } from "@/components/chat-launcher";
import { NultronMascot } from "@/components/nultron/nultron-mascot";
import { applyLocale, resetLocaleForTests } from "./i18n";
import { renderOpcCases } from "./opc-shell-cases";
import { WEB_LOGO_SRC } from "./product-brand";

const GOLDEN = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "opc-shell.golden.json"), "utf8"),
) as Record<string, string>;

const BEFORE_THE_ANSWER: AgentRailViewProps = {
  agents: [],
  loaded: false,
  activeId: null,
  pathname: "/chat",
  productName: "Acme Desk",
  logoSrc: WEB_LOGO_SRC,
  bundledMark: false,
  onToggle: () => undefined,
};

function inRouter(path: string, node: ReactNode): string {
  return renderToStaticMarkup(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>);
}

function testIds(html: string): string[] {
  return [...html.matchAll(/data-testid="([^"]+)"/g)].map((match) => match[1] as string);
}

beforeEach(() => {
  resetLocaleForTests();
  applyLocale("en");
});

describe("the chat-first shell is held to the byte", () => {
  const cases = renderOpcCases({ AgentRailView, AgentRail, AppShell });

  it("covers every case in the committed rail and shell", () => {
    expect(Object.keys(cases).sort()).toEqual(Object.keys(GOLDEN).sort());
  });

  it.each(Object.keys(GOLDEN))("renders %s exactly as the committed rail and shell did", (name) => {
    expect(cases[name]).toBe(GOLDEN[name]);
  });

  it("draws no enterprise marker in any case", () => {
    for (const html of Object.values(cases)) {
      expect(html).not.toContain("data-look");
      expect(html).not.toContain("data-product-shell");
      expect(html).not.toContain("rail-workspaces");
      expect(html).not.toContain("rail-badge");
    }
  });

  it("starts with the names showing", () => {
    expect(cases["rail-no-shell"]).toContain('data-rail="full"');
    expect(cases["rail-opc-shell"]).toContain('data-rail="full"');
  });
});

describe("the chat-first rail before the host answers", () => {
  it("draws the three skeleton tiles while the agents load, as before", () => {
    const html = inRouter("/chat", <AgentRailView {...BEFORE_THE_ANSWER} />);
    expect(html.match(/data-testid="agent-rail-skeleton"/g)).toHaveLength(3);
    expect(html).not.toContain('data-testid="rail-modes-skeleton"');
  });
});

describe("the chat-first home and mark", () => {
  it("keeps the ideas, the hero and the character on the empty chat", () => {
    const ids = testIds(inRouter("/chat", <ChatLauncher />));
    expect(ids).toContain("chat-suggestions");
    expect(ids).toContain("chat-hero");
    expect(ids).toContain("chat-hero-mascot");
  });

  it("still draws the character and the mark", () => {
    expect(renderToStaticMarkup(<NultronMascot state="idle" />)).toContain("chat-mascot");
    expect(renderToStaticMarkup(<BrandMark size={32} />)).toContain("<img");
  });
});
