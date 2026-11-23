/**
 * Bundles the portal HTTP server and operator CLIs into `dist/*.mjs` with Node's own runtime
 * requirements kept external (`pg`, `nodemailer`, etc.), so the production container never needs
 * `tsx` or dev dependencies.
 */
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const portalRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromPortal = createRequire(join(portalRoot, "package.json"));
const tsxPackageJson = requireFromPortal.resolve("tsx/package.json");
const esbuild = createRequire(tsxPackageJson)("esbuild");

const entryPoints = {
  main: join(portalRoot, "src", "main.ts"),
  "scripts/migrate": join(portalRoot, "scripts", "migrate.ts"),
  "scripts/seed": join(portalRoot, "scripts", "seed.ts"),
  "scripts/otp": join(portalRoot, "scripts", "otp.ts"),
  "scripts/invite": join(portalRoot, "scripts", "invite.ts"),
  "scripts/account": join(portalRoot, "scripts", "account.ts"),
};

await esbuild.build({
  entryPoints,
  outdir: join(portalRoot, "dist"),
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  tsconfigRaw: "{}",
  sourcemap: true,
  logLevel: "info",
});

console.log(`Built ${Object.keys(entryPoints).length} portal entrypoints into dist/`);
