import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { AGENTS_HUB_PATHS, AGENTS_TABS, AgentsShell, isAgentsHubPath } from "@/components/agents-shell";
import { applyLocale, resetLocaleForTests } from "./i18n";

beforeEach(() => {
  resetLocaleForTests();
  applyLocale("en");
});

function renderAt(path: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <AgentsShell>
        <div data-testid="agents-body">Body</div>
      </AgentsShell>
    </MemoryRouter>,
  );
}

describe("AgentsShell", () => {
  it("renders Agents and Team tabs with the Agents header", () => {
    const html = renderAt("/workspaces");
    expect(html).toContain('data-testid="agents-shell"');
    expect(html).toContain('data-testid="agents-tabs"');
    expect(html).toContain('data-testid="agents-body"');
    expect(AGENTS_HUB_PATHS).toEqual(["/workspaces", "/team"]);
    for (const tab of AGENTS_TABS) {
      expect(html).toContain(`data-testid="${tab.testId}"`);
      expect(html).toContain(`href="${tab.href}"`);
    }
    expect(html).toContain(">Agents<");
    expect(html).toContain(">Team<");
  });

  it.each(AGENTS_TABS.map((tab) => [tab.href, tab.testId]))(
    "marks only the active tab as current page for %s",
    (path, expectedTestId) => {
      const html = renderAt(path);
      const links = html.match(/<a [^>]*>/g) ?? [];
      const current = links.filter((tag) => tag.includes('aria-current="page"'));
      expect(current).toHaveLength(1);
      expect(current[0]).toContain(`data-testid="${expectedTestId}"`);
    },
  );

  it("translates tab labels in Bahasa Indonesia", () => {
    applyLocale("id");
    const html = renderAt("/workspaces");
    expect(html).toContain(">Agen<");
    expect(html).toContain(">Tim<");
  });

  it("matches /workspaces and /team paths and excludes settings and studio paths", () => {
    for (const path of ["/workspaces", "/team", "/workspaces/more", "/team/new"]) {
      expect(isAgentsHubPath(path), path).toBe(true);
    }
    for (const path of ["/chat", "/dashboard", "/settings", "/channels", "/customers", "/mcp", "/usage", "/knowledge"]) {
      expect(isAgentsHubPath(path), path).toBe(false);
    }
  });
});
