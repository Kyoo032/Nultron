import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRail } from "@/components/agent-rail";
import { AppShell } from "@/components/app-shell";
import { buddyAllowedAt } from "./buddy-routes";
import { applyLocale, resetLocaleForTests } from "./i18n";
import { BrandContext, DEFAULT_PRODUCT_BRAND, type ProductBrand } from "./product-brand";

vi.mock("@/components/desk-buddy-reactions", () => ({
  DeskBuddyReactions: () => <i data-testid="buddy-reactions" />,
}));

const ENTERPRISE: ProductBrand = { ...DEFAULT_PRODUCT_BRAND, productName: "Acme Desk", shell: "enterprise" };
const DEFAULT: ProductBrand = { ...DEFAULT_PRODUCT_BRAND, shell: "opc" };

function shellAt(path: string, brand: ProductBrand): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <BrandContext.Provider value={brand}>
        <AppShell workspaceName="Desk" visibleModes={[]}>
          <div>page</div>
        </AppShell>
      </BrandContext.Provider>
    </MemoryRouter>,
  );
}

function railAt(path: string, brand: ProductBrand): string {
  const node: ReactNode = (
    <MemoryRouter initialEntries={[path]}>
      <BrandContext.Provider value={brand}>
        <AgentRail visibleModes={[]} />
      </BrandContext.Provider>
    </MemoryRouter>
  );
  return renderToStaticMarkup(node);
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
    const html = railAt("/docs/art_123", DEFAULT);
    expect(html).not.toContain("agent-rail-buddy-dock");
    expect(html).not.toContain("desk-buddy");
  });

  it("is still in the rail on a chat page", () => {
    const html = railAt("/chat", DEFAULT);
    expect(html).toContain("agent-rail-buddy-dock");
  });

  it("stands down in the shell: no reactions on the document page", () => {
    expect(shellAt("/docs/art_123", DEFAULT)).not.toContain("buddy-reactions");
  });

  it("keeps the reactions on a chat page in the default shell", () => {
    expect(shellAt("/chat", DEFAULT)).toContain("buddy-reactions");
  });

  it("has no reactions anywhere in the enterprise shell", () => {
    expect(shellAt("/chat", ENTERPRISE)).not.toContain("buddy-reactions");
    expect(shellAt("/docs/art_123", ENTERPRISE)).not.toContain("buddy-reactions");
  });

  it("has no dock in the enterprise rail on any page", () => {
    expect(railAt("/chat", ENTERPRISE)).not.toContain("agent-rail-buddy-dock");
    expect(railAt("/docs/art_123", ENTERPRISE)).not.toContain("agent-rail-buddy-dock");
  });
});
