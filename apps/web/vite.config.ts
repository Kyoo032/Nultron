import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { THEME_STORAGE_KEY } from "./lib/theme";
import { THEME_BOOT_FILE, themeBootScript } from "./lib/theme-boot-script";

const dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dir, "../..");

function themeBoot(): Plugin {
  const source = themeBootScript(THEME_STORAGE_KEY);
  return {
    name: "nultron-theme-boot",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || new URL(req.url, "http://localhost").pathname.split("/").pop() !== THEME_BOOT_FILE) {
          next();
          return;
        }
        res.setHeader("Content-Type", "text/javascript; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.end(source);
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: THEME_BOOT_FILE, source });
    },
    transformIndexHtml() {
      return [{ tag: "script", attrs: { src: `./${THEME_BOOT_FILE}` }, injectTo: "head-prepend" }];
    },
  };
}

export default defineConfig({
  root: dir,
  base: "./",
  plugins: [react(), themeBoot()],
  resolve: {
    alias: {
      "@": dir,
    },
  },
  server: {
    host: "127.0.0.1",
    port: 3000,
    fs: { allow: [repoRoot] },
  },
  preview: {
    host: "127.0.0.1",
    port: 3000,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
