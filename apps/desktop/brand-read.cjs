const fs = require("node:fs");
const path = require("node:path");

const PUBLIC_PRODUCT_NAME = "Nultron";

const DEFAULT_BRAND = {
  productName: PUBLIC_PRODUCT_NAME,
  gatewayName: "Toko Token",
  gatewayBaseUrl: "https://api.tokotokenai.com/v1",
};

function parseBrand(parsed, fallback = DEFAULT_BRAND) {
  const productName =
    typeof parsed?.productName === "string" && parsed.productName.trim()
      ? parsed.productName.trim()
      : fallback.productName;
  const gatewayName =
    typeof parsed?.gatewayName === "string" && parsed.gatewayName.trim()
      ? parsed.gatewayName.trim()
      : fallback.gatewayName;
  const gatewayBaseUrl =
    typeof parsed?.gatewayBaseUrl === "string" && parsed.gatewayBaseUrl.trim()
      ? parsed.gatewayBaseUrl.trim().replace(/\/+$/, "")
      : fallback.gatewayBaseUrl;
  return { productName, gatewayName, gatewayBaseUrl };
}

/**
 * The gateway a packaged build may use instead of the pinned one, or "" for the pinned one.
 *
 * Only a brand flavor (Kemenkeu AI, AIHub Metranet) has one: it is the `gatewayBaseUrl` of the
 * `brand.json` installed beside it. The public Nultron build never does, whatever its `brand.json`
 * says, so it always talks to the pinned gateway. `main.cjs` hands the result to the host as
 * `AGENTFORGE_BRAND_GATEWAY_URL`; the host (`packages/core/src/gateway/pinned.ts`) still insists on https.
 *
 * @param {{ productName?: string, gatewayBaseUrl?: unknown } | null | undefined} brand a parsed brand
 * @returns {string}
 */
function brandGatewayOverride(brand) {
  if (!brand || brand.productName === PUBLIC_PRODUCT_NAME) {
    return "";
  }
  const url = typeof brand.gatewayBaseUrl === "string" ? brand.gatewayBaseUrl.trim().replace(/\/+$/, "") : "";
  return url === DEFAULT_BRAND.gatewayBaseUrl ? "" : url;
}

function loadBrandFromResources(resourcesPath, dirname) {
  const candidates = [
    resourcesPath ? path.join(resourcesPath, "brand", "brand.json") : "",
    dirname ? path.join(dirname, "resources", "brand", "brand.json") : "",
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) {
        continue;
      }
      return parseBrand(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      // try next candidate
    }
  }
  return DEFAULT_BRAND;
}

function loadBrandLogo(resourcesPath, dirname) {
  const candidates = [
    resourcesPath ? path.join(resourcesPath, "brand", "logo.png") : "",
    dirname ? path.join(dirname, "resources", "brand", "logo.png") : "",
    dirname ? path.join(dirname, "splash", "logo.png") : "",
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) {
        continue;
      }
      return `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
    } catch {
      // try next candidate
    }
  }
  return "";
}

module.exports = {
  PUBLIC_PRODUCT_NAME,
  DEFAULT_BRAND,
  parseBrand,
  brandGatewayOverride,
  loadBrandFromResources,
  loadBrandLogo,
};
