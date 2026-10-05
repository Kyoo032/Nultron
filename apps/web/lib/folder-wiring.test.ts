/**
 * Where the folder surface is mounted, held by the shape of the source.
 *
 * Node has no layout engine, so this cannot measure the gap above the composer; what it holds is the
 * markup the CSS depends on (the surface is the ledge's first block child, so Nultron stands on it)
 * and the rules the folder code must not break. The gaps and widths are driven live at 1280 and 360.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(join(web, ...parts), "utf8").replace(/\r\n/g, "\n");

const session = read("components", "chat-session.tsx");
const css = read("app", "globals.css");
const surface = read("components", "folder", "folder-surface.tsx");

const folderSources = readdirSync(join(web, "components", "folder"))
  .filter((name) => /\.tsx?$/.test(name))
  .map((name) => ({ name, text: read("components", "folder", name) }));

describe("the mount point in the Chat pane", () => {
  it("imports the surface once and renders it once", () => {
    expect(session.match(/from "@\/components\/folder\/folder-surface"/g)).toHaveLength(1);
    expect(session.match(/<FolderSurface\b/g)).toHaveLength(1);
  });

  it("renders it inside the composer ledge, ahead of the composer, fed the pane's running flag", () => {
    const ledge = session.indexOf('className="chat-composer-ledge"');
    const mount = session.indexOf("<FolderSurface");
    const composer = session.indexOf("<ChatComposer");
    expect(ledge).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(ledge);
    expect(composer).toBeGreaterThan(mount);
    expect(session.slice(mount, composer)).toContain("running={running}");
  });

  it("sits at the ledge's own gap, which the stylesheet defines", () => {
    expect(surface).toContain("var(--ledge-gap");
    expect(css).toMatch(/\.chat-composer-ledge\s*\{[^}]*--ledge-gap:/);
  });
});

describe("the folder components", () => {
  it("reach the shell only through the bridge's picker, never through window", () => {
    for (const { name, text } of folderSources) {
      expect(text, name).not.toMatch(/\bwindow\.|\bwindow\[|typeof window\b/);
      expect(text, name).not.toMatch(/from "electron"/);
    }
    const bridgeUsers = folderSources.filter(({ text }) => text.includes("@/lib/desktop-bridge"));
    expect(bridgeUsers.map(({ name }) => name)).toEqual(["use-folder.ts"]);
  });

  it("show no raw HTML and no hard-coded English in the markup", () => {
    for (const { name, text } of folderSources) {
      expect(text, name).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
      // Text between tags that starts with a capital and has a space is a sentence nobody translated.
      expect(text, name).not.toMatch(/>\s*[A-Z][a-z]+(?: [A-Za-z]+)+[.!?]?\s*</);
    }
  });
});
