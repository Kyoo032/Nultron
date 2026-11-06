const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const { join } = require("node:path");
const { parseBrand, loadBrandFromResources, brandGatewayOverride, DEFAULT_BRAND } = require("./brand-read.cjs");

const kemenkeu = parseBrand({
  productName: "Kemenkeu AI",
  gatewayName: "AIHub",
  gatewayBaseUrl: "https://aihub.metranet.co.id/v1/",
});
assert.equal(kemenkeu.productName, "Kemenkeu AI");
assert.equal(kemenkeu.gatewayName, "AIHub");
assert.equal(kemenkeu.gatewayBaseUrl, "https://aihub.metranet.co.id/v1");

const metranet = parseBrand({
  productName: "AIHub Metranet",
  gatewayName: "AIHub",
  gatewayBaseUrl: "https://aihub.metranet.co.id/v1",
});
assert.equal(metranet.productName, "AIHub Metranet");

const empty = parseBrand({}, DEFAULT_BRAND);
assert.equal(empty.productName, "Nultron");
assert.equal(empty.gatewayName, "Toko Token");

{
  const root = fs.mkdtempSync(join(os.tmpdir(), "brand-read-"));
  try {
    const withBrand = join(root, "with-brand");
    fs.mkdirSync(join(withBrand, "brand"), { recursive: true });
    fs.writeFileSync(
      join(withBrand, "brand", "brand.json"),
      JSON.stringify({
        productName: "Kemenkeu AI",
        gatewayName: "AIHub",
        gatewayBaseUrl: "https://aihub.metranet.co.id/v1/",
      }),
    );
    const fromDisk = loadBrandFromResources(withBrand, root);
    assert.equal(fromDisk.productName, "Kemenkeu AI");
    assert.equal(fromDisk.gatewayName, "AIHub");
    assert.equal(fromDisk.gatewayBaseUrl, "https://aihub.metranet.co.id/v1");

    const withoutBrand = join(root, "without-brand");
    fs.mkdirSync(withoutBrand);
    assert.deepEqual(
      loadBrandFromResources(withoutBrand, withoutBrand),
      DEFAULT_BRAND,
      "no brand.json falls back to the default brand",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

// ---------- brandGatewayOverride: which gateway a packaged build may use instead of the pinned one ----------
//
// main.cjs hands this to the host as AGENTFORGE_BRAND_GATEWAY_URL. The public build never has one, so it
// always talks to the pinned gateway; a flavor keeps the gateway its brand.json names.

assert.equal(brandGatewayOverride(kemenkeu), "https://aihub.metranet.co.id/v1", "Kemenkeu AI keeps its AIHub gateway");
assert.equal(
  brandGatewayOverride(metranet),
  "https://aihub.metranet.co.id/v1",
  "AIHub Metranet keeps its AIHub gateway",
);
assert.equal(brandGatewayOverride(DEFAULT_BRAND), "", "the default brand is the public build: pinned gateway");
assert.equal(
  brandGatewayOverride(parseBrand({ productName: "Nultron", gatewayBaseUrl: "https://evil.example/v1" })),
  "",
  "the public build ignores a gateway written into its brand.json",
);
assert.equal(
  brandGatewayOverride(parseBrand({ productName: "Some Flavor", gatewayName: "X" })),
  "",
  "a flavor whose brand.json names no gateway parses to the pinned one, so there is nothing to override",
);
assert.equal(
  brandGatewayOverride({ productName: "Kemenkeu AI", gatewayBaseUrl: DEFAULT_BRAND.gatewayBaseUrl }),
  "",
  "a flavor that names the pinned gateway needs no override",
);
assert.equal(brandGatewayOverride(undefined), "", "no brand, no override");
assert.equal(brandGatewayOverride(null), "", "no brand, no override");
assert.equal(brandGatewayOverride({ productName: "Kemenkeu AI" }), "", "a brand with no gateway URL has no override");
assert.equal(
  brandGatewayOverride({ productName: "Kemenkeu AI", gatewayBaseUrl: 42 }),
  "",
  "a non-string URL is not one",
);

console.log("brand-read.test.cjs: ok");
