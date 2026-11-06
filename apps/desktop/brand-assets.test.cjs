/**
 * The logo files the desktop shell ships, checked as bytes.
 *
 * Owner ruling, 2026-09-29: the logo is the painted Nultron head in a blue tile. The Windows icon
 * (`icon.ico`), the macOS icon (`icon.icns`), the icon sources (`icon.png`) and the display logo
 * (`logo.png`, on the splash page and inlined by the preload) all come from one brand kit. A swap
 * that copies one file and forgets a twin passes every type check, so this reads them.
 */
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const { join } = require("node:path");

const PNG_MAGIC = "89504e470d0a1a0a";
const MAX_DISPLAY_LOGO_BYTES = 200 * 1024;

const buildDir = join(__dirname, "build");
const splashDir = join(__dirname, "splash");
const webBrandDir = join(__dirname, "..", "web", "public", "brand");

const read = (file) => fs.readFileSync(file);

function pngSize(bytes, label) {
  assert.equal(bytes.subarray(0, 8).toString("hex"), PNG_MAGIC, `${label} is a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function icoSizes(bytes, label) {
  assert.equal(bytes.readUInt16LE(0), 0, `${label}: ICO reserved word`);
  assert.equal(bytes.readUInt16LE(2), 1, `${label}: ICO type is icon`);
  return Array.from({ length: bytes.readUInt16LE(4) }, (_, index) => bytes[6 + index * 16] || 256);
}

function icnsEntries(bytes, label) {
  assert.equal(bytes.toString("ascii", 0, 4), "icns", `${label}: ICNS magic`);
  assert.equal(bytes.readUInt32BE(4), bytes.length, `${label}: ICNS length field is the file size`);
  const entries = [];
  for (let offset = 8; offset < bytes.length; ) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32BE(offset + 4);
    assert.ok(length >= 8 && offset + length <= bytes.length, `${label}: ICNS entry ${type} fits`);
    entries.push({ type, data: bytes.subarray(offset + 8, offset + length) });
    offset += length;
  }
  return entries;
}

// ---------- Windows: icon.ico, one file in two places ----------

{
  const source = read(join(buildDir, "icon.ico"));
  assert.ok(read(join(splashDir, "icon.ico")).equals(source), "splash/icon.ico is the build copy");
  assert.deepEqual(icoSizes(source, "icon.ico"), [16, 24, 32, 48, 64, 128, 256]);
}

// ---------- macOS: icon.icns, the file electron-builder's mac.icon names ----------

{
  const source = read(join(buildDir, "icon.icns"));
  const entries = icnsEntries(source, "icon.icns");
  assert.deepEqual(
    entries.map((entry) => entry.type),
    ["icp4", "icp5", "icp6", "ic07", "ic08", "ic09", "ic10"],
  );
  const sizes = { icp4: 16, icp5: 32, icp6: 64, ic07: 128, ic08: 256, ic09: 512, ic10: 1024 };
  for (const { type, data } of entries) {
    const { width, height } = pngSize(data, type);
    // ic10 is the 1024 px image; the others are stored at their own size.
    assert.deepEqual({ width, height }, { width: sizes[type], height: sizes[type] }, `${type} size`);
  }
  const config = JSON.parse(fs.readFileSync(join(__dirname, "package.json"), "utf8")).build;
  assert.equal(config.mac.icon, "icon.icns");
  assert.equal(config.win.icon, "icon.ico");
  assert.equal(config.directories.buildResources, "build");
}

// ---------- pack-brand copies the .icns, and removes one a flavor does not ship ----------

{
  const source = fs.readFileSync(join(__dirname, "scripts", "pack-brand.mjs"), "utf8");
  assert.match(source, /icon\.icns/);
  assert.match(source, /unlinkSync\(buildIcns\)/);
}

// ---------- icon source: 1024 px ----------

assert.deepEqual(pngSize(read(join(buildDir, "icon.png")), "icon.png"), { width: 1024, height: 1024 });

// ---------- display logo: small, and the same file as the web app's ----------

{
  const source = read(join(splashDir, "logo.png"));
  assert.ok(read(join(webBrandDir, "logo.png")).equals(source), "splash/logo.png is the web app's logo.png");
  const { width, height } = pngSize(source, "logo.png");
  assert.equal(width, height, "logo.png is square");
  assert.ok(width >= 128 && width <= 512, `logo.png is ${width} px; the splash shows it at 88 CSS px`);
  // The preload inlines this file as base64 on every launch (brand-read.cjs `loadBrandLogo`).
  assert.ok(
    source.length <= MAX_DISPLAY_LOGO_BYTES,
    `logo.png is ${source.length} bytes, over the ${MAX_DISPLAY_LOGO_BYTES} the preload should carry`,
  );
}

// ---------- the splash page draws that logo and names the product ----------

{
  const html = fs.readFileSync(join(splashDir, "index.html"), "utf8");
  assert.match(html, /<img class="logo" src="\.\/logo\.png"/);
  assert.match(html, /<title>Nultron<\/title>/);
  assert.ok(!/\.svg/.test(html), "the splash draws no SVG logo");
}

// ---------- the public wordmark follows the Nultron IP colours; a flavor's title stays plain ----------

{
  const html = fs.readFileSync(join(splashDir, "index.html"), "utf8");
  const css = fs.readFileSync(join(__dirname, "..", "web", "app", "globals.css"), "utf8");
  const dark = css.slice(css.indexOf("\n.dark {"));
  const token = (name) => {
    const match = new RegExp(`${name}:\\s*(#[0-9a-f]{6});`, "i").exec(dark);
    assert.ok(match, `${name} is declared for the dark desk in globals.css`);
    return match[1].toLowerCase();
  };
  // The splash is a dark page, so it paints the renderer's dark-desk wordmark stops.
  const blue = token("--nultron-blue-text");
  const cyan = token("--nultron-cyan-text");
  assert.match(html, /<h1 class="wordmark">Nultron<\/h1>/);
  assert.ok(html.includes(`linear-gradient(100deg, ${blue} 0%, ${blue} 38%, ${cyan} 100%)`), "wordmark gradient");
  assert.ok(html.includes(`color: ${blue};`), "wordmark falls back to the helmet blue");

  // The generator that rewrites this page for every flavor emits the wordmark for the public name only.
  const packer = fs.readFileSync(join(__dirname, "scripts", "pack-brand.mjs"), "utf8");
  assert.match(packer, /const nultron = config\.productName === "Nultron";/);
  assert.match(packer, /\$\{nultron \? NULTRON_WORDMARK_CSS : ""\}/);
  assert.match(packer, /<h1\$\{nultron \? ' class="wordmark"' : ""\}>/);
  assert.ok(
    packer.includes(`color: ${blue};`) && packer.includes(`${cyan} 100%)`),
    "the generator carries the same stops",
  );
}

{
  const source = fs.readFileSync(join(__dirname, "scripts", "pack-brand.mjs"), "utf8");
  const guard = source.indexOf("existsSync(publicBrandFile)");
  const firstWrite = source.indexOf("mkdirSync(buildDir");
  assert.ok(guard > -1, "pack-brand.mjs checks for the public brand.json");
  assert.ok(firstWrite > -1 && guard < firstWrite, "the check comes before the first write");
}

{
  const root = fs.mkdtempSync(join(os.tmpdir(), "pack-brand-guard-"));
  try {
    fs.mkdirSync(join(root, "scripts"));
    fs.copyFileSync(join(__dirname, "scripts", "pack-brand.mjs"), join(root, "scripts", "pack-brand.mjs"));
    fs.mkdirSync(join(root, "branding", "kemenkeu"), { recursive: true });
    fs.writeFileSync(join(root, "branding", "kemenkeu", "brand.json"), JSON.stringify({ productName: "Kemenkeu AI" }));
    const before = fs.readdirSync(root).sort();
    const result = spawnSync(process.execPath, [join(root, "scripts", "pack-brand.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, AGENTFORGE_BRAND: "kemenkeu" },
    });
    assert.equal(result.status, 1, "a flavor pack without the public kit exits 1");
    assert.match(result.stderr, /branding[\\/]agentforge[\\/]brand\.json/);
    assert.deepEqual(fs.readdirSync(root).sort(), before, "it writes nothing before it stops");
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

console.log("brand-assets.test.cjs: ok");
