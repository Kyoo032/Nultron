import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRail } from "@/components/agent-rail";
import { AppShell } from "@/components/app-shell";
import { buddyAllowedAt } from "./buddy-routes";
import { applyLocale, resetLocaleForTests } from "./i18n";

vi.mock("@/components/desk-buddy-reactions", () => ({
  DeskBuddyReactions: () => <i data-testid="buddy-reactions" />,
}));

function shellAt(path: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <AppShell workspaceName="Desk" visibleModes={[]}>
        <div>page</div>
      </AppShell>
    </MemoryRouter>,
  );
}

function railAt(path: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <AgentRail visibleModes={[]} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetLocaleForTests();
  applyLocale("en");
});

describe("buddyAllowedAt", () => {
  it("refuses the document page and everything under it", () => {
    expect(buddyAllowedAt("/docs")).toBe(false);
    expect(buddyAllowedAt("/docs/art_123")).toBe(false);
    expect(buddyAllowedAt("/docs/art_123/versions")).toBe(false);
  });

  it("allows every other page, including names that only start alike", () => {
    expect(buddyAllowedAt("/chat")).toBe(true);
    expect(buddyAllowedAt("/")).toBe(true);
    expect(buddyAllowedAt("/projects")).toBe(true);
    expect(buddyAllowedAt("/docsets")).toBe(true);
    expect(buddyAllowedAt("/documents")).toBe(true);
  });
});

describe("the desk buddy on a document page", () => {
  it("stands down in the rail: no dock and no chip", () => {
    const html = railAt("/docs/art_123");
    expect(html).not.toContain("agent-rail-buddy-dock");
    expect(html).not.toContain("desk-buddy");
  });

  it("is still in the rail on a chat page", () => {
    expect(railAt("/chat")).toContain("agent-rail-buddy-dock");
  });

  it("stands down in the shell: no reactions on the document page", () => {
    expect(shellAt("/docs/art_123")).not.toContain("buddy-reactions");
  });

  it("keeps the reactions on a chat page", () => {
    expect(shellAt("/chat")).toContain("buddy-reactions");
  });
});
