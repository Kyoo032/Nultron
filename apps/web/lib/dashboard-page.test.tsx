import { MemoryRouter, Route, Routes } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DASHBOARD_STUDIOS,
  DashboardPage,
  dashboardStudioFromPath,
  dashboardStudioHref,
  isDashboardStudioId,
} from "@/components/dashboard-page";
import { applyLocale, resetLocaleForTests } from "./i18n";

beforeEach(() => {
  resetLocaleForTests();
  applyLocale("en");
});

function renderRoute(path: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/dashboard/:studio" element={<DashboardPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("DashboardPage hub", () => {
  it("renders all 13 built-in studios grouped into Creative & Media and Analysis & Review", () => {
    const html = renderRoute("/dashboard");
    expect(html).toContain('data-testid="dashboard-page"');
    expect(html).toContain('data-mode="dashboard"');
    expect(html).toContain('data-testid="dashboard-section-creative"');
    expect(html).toContain('data-testid="dashboard-section-analysis"');
    expect(html).toContain(">Creative &amp; Media<");
    expect(html).toContain(">Analysis &amp; Review<");
    expect(DASHBOARD_STUDIOS).toHaveLength(13);
    for (const entry of DASHBOARD_STUDIOS) {
      expect(html).toContain(`data-testid="dashboard-card-${entry.id}"`);
      expect(html).toContain(`href="${dashboardStudioHref(entry.id)}"`);
      expect(html).toContain(`data-mode="${entry.id}"`);
    }
    expect(html).toContain(">Image Generation<");
    expect(html).toContain(">Video Generation<");
    expect(html).toContain(">Video Editing<");
    expect(html).toContain(">Market Research<");
    expect(html).toContain(">Finance<");
    expect(html).toContain(">Data Analysis<");
    expect(html).toContain(">Legal Review<");
  });

  it("translates the hub headings and studio titles in Bahasa Indonesia", () => {
    applyLocale("id");
    const html = renderRoute("/dashboard");
    expect(html).toContain(">Dasbor<");
    expect(html).toContain(">Kreatif &amp; Media<");
    expect(html).toContain(">Analisis &amp; Tinjauan<");
    expect(html).toContain(">Pembuatan Gambar<");
    expect(html).toContain(">Riset Pasar<");
  });
});

describe("DashboardPage studio view", () => {
  it("renders the sticky studio switcher bar with back link and marks only the active studio", () => {
    const html = renderRoute("/dashboard/images");
    expect(html).toContain('data-testid="dashboard-studio-shell"');
    expect(html).toContain('data-testid="dashboard-studio-bar"');
    expect(html).toContain('data-testid="dashboard-back"');
    expect(html).toContain('href="/dashboard"');
    const pills = (html.match(/<a [^>]*data-testid="dashboard-pill-[^"]*"[^>]*>/g) ?? []).filter((tag) =>
      tag.includes('aria-current="page"'),
    );
    expect(pills).toHaveLength(1);
    expect(pills[0]).toContain('data-testid="dashboard-pill-images"');
    expect(html).toContain('data-testid="dashboard-studio-body"');
    expect(html).toContain("overflow-y-auto");
  });

  it("preserves /dashboard/finance for internal task chooser links", () => {
    const html = renderRoute("/dashboard/finance");
    expect(html).toContain('data-testid="finance-studio"');
    expect(html).toContain('href="/dashboard/finance?task=brief"');
  });

  it("preserves /dashboard/education for internal task chooser links", () => {
    const html = renderRoute("/dashboard/education");
    expect(html).toContain('data-testid="education-studio"');
    expect(html).toContain('href="/dashboard/education?task=lesson"');
  });

  it("uses overflow-hidden on the studio body for edit so its timeline owns scrolling", () => {
    const html = renderRoute("/dashboard/edit");
    const bodyTag = html.match(/<div [^>]*data-testid="dashboard-studio-body"[^>]*>/)?.[0] ?? "";
    expect(bodyTag).toContain("overflow-hidden");
    expect(bodyTag).not.toContain("overflow-y-auto");
  });

  it("validates studio ids and extracts them from /dashboard/:studio paths", () => {
    expect(isDashboardStudioId("images")).toBe(true);
    expect(isDashboardStudioId("finance")).toBe(true);
    expect(isDashboardStudioId("chat")).toBe(false);
    expect(isDashboardStudioId("unknown")).toBe(false);
    expect(isDashboardStudioId(undefined)).toBe(false);
    expect(dashboardStudioFromPath("/dashboard/images")).toBe("images");
    expect(dashboardStudioFromPath("/dashboard/finance")).toBe("finance");
    expect(dashboardStudioFromPath("/dashboard")).toBeNull();
    expect(dashboardStudioFromPath("/dashboard/chat")).toBeNull();
    expect(dashboardStudioFromPath("/images")).toBeNull();
  });

  it("redirects unknown /dashboard/:studio routes cleanly without mounting a studio shell", () => {
    const html = renderRoute("/dashboard/not-a-studio");
    expect(html).not.toContain('data-testid="dashboard-studio-shell"');
  });
});
