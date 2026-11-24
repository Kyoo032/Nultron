import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { DEFAULT_PRODUCT_NAME, GATEWAY_BASE_URL, GATEWAY_NAME } from "@agentforge/core/gateway";
import { pingOnce } from "@/lib/host-ping";

export type ProductBrand = {
  productName: string;
  gatewayName: string;
  gatewayBaseUrl: string;
  logoSrc: string;
  /**
   * Tester code: the brand's character, which is the name of the default virtual agent. Absent means
   * the brand names none, and the character carries the product's name (`assistantNameOf`).
   */
  assistantName?: string;
};

/**
 * The default virtual agent's name (owner, 2026-10-09): the brand's own character. A brand that
 * names its character says so in its settings (the host answers `assistantName` on `/api/v1/ping`);
 * one that does not gets the product's name. No character is named in this code.
 */
export function assistantNameOf(brand: Pick<ProductBrand, "productName" | "assistantName">): string {
  return brand.assistantName?.trim() || brand.productName;
}

export const DEFAULT_PRODUCT_BRAND: ProductBrand = {
  productName: DEFAULT_PRODUCT_NAME,
  gatewayName: GATEWAY_NAME,
  gatewayBaseUrl: GATEWAY_BASE_URL,
  logoSrc: "",
};

/**
 * The Nultron logo tile at 256 px, served from `apps/web/public/brand/`.
 *
 * The MARK is the only thing the hosted web adds to the brand. The NAME is
 * `DEFAULT_PRODUCT_NAME` -- the same constant `/api/v1/ping` answers `productName` with -- so the
 * shell, the renderer and the host cannot disagree about what the product is called. There used to
 * be a `WEB_PRODUCT_NAME` here saying something else, and `mergePingBrand` spent a branch keeping
 * the two apart; deleting the second name deletes the drift rather than managing it.
 */
export const WEB_LOGO_SRC = "/brand/logo.png";

/**
 * True when the rail, the desk switcher and the sign-in screen draw the mark that ships with the
 * renderer (`BrandMark`, size-tuned for 24 and 32 px) rather than `logoSrc`. That is the default
 * brand on the web (its `logoSrc` is `WEB_LOGO_SRC`, which is the same tile) and the default brand
 * in the packaged desktop, whose preload also hands over the logo as a data URL. A flavor with its
 * own name and its own logo (`branding/kemenkeu`, `branding/metranet`) keeps drawing that logo.
 */
export function usesBundledMark(brand: ProductBrand): boolean {
  return brand.logoSrc === WEB_LOGO_SRC || brand.productName === DEFAULT_PRODUCT_NAME;
}

/**
 * True when the product still carries the public name, so its wordmark (the rail header's "Nultron")
 * may take the Nultron IP colours (`.wordmark-nultron`, the `--nultron-*` tokens). The decision is the
 * NAME and not the logo: a hosted tenant that renames the product keeps the bundled mark
 * (`usesBundledMark`) but must not see its own name in another brand's colours, and a desktop flavor
 * (`kemenkeu`, `metranet`) keeps its plain name and its own logo.
 */
export function usesNultronWordmark(brand: ProductBrand): boolean {
  return brand.productName === DEFAULT_PRODUCT_NAME;
}

const BrandContext = createContext<ProductBrand>(DEFAULT_PRODUCT_BRAND);

export function useProductBrand(): ProductBrand {
  return useContext(BrandContext);
}

export function gatewayHostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function brandFromUnknown(payload: unknown, fallback: ProductBrand): ProductBrand {
  if (!payload || typeof payload !== "object") {
    return fallback;
  }
  const record = payload as Record<string, unknown>;
  const nested =
    record.body && typeof record.body === "object" ? (record.body as Record<string, unknown>) : record;
  const productName =
    typeof nested.productName === "string" && nested.productName.trim()
      ? nested.productName.trim()
      : fallback.productName;
  const gatewayName =
    typeof nested.gatewayName === "string" && nested.gatewayName.trim()
      ? nested.gatewayName.trim()
      : fallback.gatewayName;
  const gatewayBaseUrl =
    typeof nested.gatewayBaseUrl === "string" && nested.gatewayBaseUrl.trim()
      ? nested.gatewayBaseUrl.trim()
      : fallback.gatewayBaseUrl;
  // Only a payload that names a character sets one; without it the character follows the product name.
  const assistantName =
    typeof nested.assistantName === "string" && nested.assistantName.trim()
      ? nested.assistantName.trim()
      : fallback.assistantName;
  return {
    ...fallback,
    productName,
    gatewayName,
    gatewayBaseUrl,
    ...(assistantName ? { assistantName } : {}),
  };
}

export function mergePingBrand(current: ProductBrand, payload: unknown): ProductBrand {
  const next = brandFromUnknown(payload, current);
  const keepPreloadName =
    current.productName !== DEFAULT_PRODUCT_BRAND.productName &&
    next.productName === DEFAULT_PRODUCT_BRAND.productName;
  const keepPreloadGateway =
    current.gatewayName !== DEFAULT_PRODUCT_BRAND.gatewayName &&
    next.gatewayName === DEFAULT_PRODUCT_BRAND.gatewayName;
  // A flavor the preload named keeps its own character too: the ping's is the default product's.
  const { assistantName: pingAssistant, ...rest } = next;
  const assistantName = keepPreloadName ? current.assistantName : pingAssistant;
  return {
    ...rest,
    ...(assistantName ? { assistantName } : {}),
    productName: keepPreloadName ? current.productName : next.productName,
    gatewayName: keepPreloadGateway ? current.gatewayName : next.gatewayName,
    gatewayBaseUrl: keepPreloadName ? current.gatewayBaseUrl : next.gatewayBaseUrl,
    logoSrc: current.logoSrc || next.logoSrc,
  };
}

function preloadBrand(): ProductBrand {
  return { ...DEFAULT_PRODUCT_BRAND, logoSrc: WEB_LOGO_SRC };
}

export function ProductBrandProvider({ children }: { children: ReactNode }) {
  const [brand, setBrand] = useState(preloadBrand);

  useEffect(() => {
    document.title = brand.productName;
  }, [brand.productName]);

  useEffect(() => {
    // Phase 8: one shared `/api/v1/ping`, because the capabilities provider reads the same payload.
    // Two fetches would race to mint the CSRF cookie and one of them would lose its token.
    void pingOnce().then((payload) => {
      if (payload !== null) {
        setBrand((current) => mergePingBrand(current, payload));
      }
      // A null payload is a failed ping: the packaged preload already supplied the flavor and
      // webdev keeps the defaults, exactly as the old `.catch` left them.
    });
  }, []);

  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}
