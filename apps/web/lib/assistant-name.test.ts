import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRODUCT_BRAND,
  WEB_LOGO_SRC,
  assistantNameOf,
  brandFromUnknown,
  mergePingBrand,
  type ProductBrand,
} from "@/lib/product-brand";
import { virtualAgentName } from "@/lib/virtual-agents";

/**
 * The default virtual agent is the brand's own character (owner, 2026-10-09). The host answers its
 * name on `/api/v1/ping`; a brand that names none gets the product's name. The names below are made up.
 */
const web: ProductBrand = { ...DEFAULT_PRODUCT_BRAND, logoSrc: WEB_LOGO_SRC };

describe("the default agent's name on screen", () => {
  it("is the product's name when the brand names no character", () => {
    expect(assistantNameOf(web)).toBe(DEFAULT_PRODUCT_BRAND.productName);
    expect(assistantNameOf({ productName: "Acme Desk" })).toBe("Acme Desk");
    expect(assistantNameOf({ productName: "Acme Desk", assistantName: "  " })).toBe("Acme Desk");
  });

  it("is the character's name when the host's ping names one", () => {
    const brand = mergePingBrand(web, { productName: "Acme Desk", assistantName: "Mika", gatewayName: "Acme Gate" });
    expect(brand.productName).toBe("Acme Desk");
    expect(assistantNameOf(brand)).toBe("Mika");
    expect(virtualAgentName({ id: "chat", generalist: true }, assistantNameOf(brand))).toBe("Mika");
    // Every other agent is named for its mode, whatever the brand.
    expect(virtualAgentName({ id: "research", generalist: false }, assistantNameOf(brand))).toBe("Research");
  });

  it("reads the character from a ping body", () => {
    expect(brandFromUnknown({ productName: "Acme Desk", assistantName: " Mika " }, web).assistantName).toBe("Mika");
    expect(brandFromUnknown({ productName: "Acme Desk" }, web).assistantName).toBeUndefined();
  });

  it("keeps a preloaded flavor's character when a late default ping arrives", () => {
    const flavor: ProductBrand = { ...web, productName: "Acme Desk", assistantName: "Mika", logoSrc: "data:logo" };
    const merged = mergePingBrand(flavor, {
      productName: DEFAULT_PRODUCT_BRAND.productName,
      assistantName: DEFAULT_PRODUCT_BRAND.productName,
    });
    expect(merged.productName).toBe("Acme Desk");
    expect(assistantNameOf(merged)).toBe("Mika");
  });

  it("follows the product's name through a ping that names no character", () => {
    const merged = mergePingBrand(web, { productName: "Acme Desk" });
    expect(assistantNameOf(merged)).toBe("Acme Desk");
  });
});
