import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { isSettingsHubPath, SETTINGS_TABS, SettingsShell } from "@/components/settings-shell";
import { applyLocale, resetLocaleForTests } from "./i18n";

beforeEach(() => {
  resetLocaleForTests();
  applyLocale("en");
});

function renderAt(path: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <SettingsShell>
        <div data-testid="settings-body">Body</div>
      </SettingsShell>
    </MemoryRouter>,
  );
}

describe("SettingsShell", () => {
  it("renders settings hub tabs excluding Agents and Usage", () => {
    const html = renderAt("/settings");
    expect(html).toContain('data-testid="settings-shell"');
    expect(html).toContain('data-testid="settings-tabs"');
    expect(html).toContain('data-testid="settings-body"');
    for (const tab of SETTINGS_TABS) {
      expect(html).toContain(`data-testid="${tab.testId}"`);
      expect(html).toContain(`href="${tab.href}"`);
    }
    expect(html).toContain(">General<");
    expect(html).toContain(">Team<");
    expect(html).toContain(">Channels<");
    expect(html).toContain(">Customers<");
    expect(html).toContain(">Connectors (MCP)<");
    expect(html).not.toContain('data-testid="settings-tab-agents"');
    expect(html).not.toContain('data-testid="settings-tab-usage"');
  });

  it.each(SETTINGS_TABS.map((tab) => [tab.href, tab.testId]))(
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
    const html = renderAt("/settings");
    expect(html).toContain(">Umum<");
    expect(html).toContain(">Tim<");
    expect(html).toContain(">Channel<");
    expect(html).toContain(">Pelanggan<");
    expect(html).toContain(">Konektor (MCP)<");
  });

  it("identifies all Settings hub routes and excludes Agents, Usage, and non-settings routes", () => {
    for (const path of ["/settings", "/team", "/channels", "/customers", "/mcp", "/settings/more"]) {
      expect(isSettingsHubPath(path), path).toBe(true);
    }
    for (const path of ["/chat", "/knowledge", "/workspaces", "/usage", "/images", "/videos", "/market", "/research"]) {
      expect(isSettingsHubPath(path), path).toBe(false);
    }
  });
});
