import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The proxy compresses only text. An SSE stream (job progress, SR-174) compressed or buffered would
 * arrive in one lump at the end of the run, and a video or audio file is already compressed.
 * Parses every `encode` block in the reviewed Caddyfile and in the k8s copy of the app site.
 */
const reviewed = readFileSync(fileURLToPath(new URL("../../../webapp-deploy/Caddyfile", import.meta.url)), "utf8");
const k8sCopy = readFileSync(
  fileURLToPath(new URL("../../../webapp-deploy/k8s/base/caddy/security.caddy", import.meta.url)),
  "utf8",
);

/**
 * For each `encode zstd gzip { match { … } }` block, the Content-Type values its match names. Caddy
 * takes one value per `header` line and ORs repeated lines, so each line must carry exactly one.
 */
function encodeMatches(text: string): string[][] {
  const blocks = [...text.matchAll(/encode zstd gzip \{\r?\n\s*match \{\r?\n([\s\S]*?)\r?\n\s*\}/g)];
  return blocks.map((block) =>
    (block[1] ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const parts = line.split(/\s+/);
        expect(parts.slice(0, 2), `not a Content-Type line: ${line}`).toEqual(["header", "Content-Type"]);
        expect(parts, `one value per line: ${line}`).toHaveLength(3);
        return parts[2] as string;
      }),
  );
}

describe("the proxy compresses text and nothing that must stream", () => {
  it.each([
    ["webapp-deploy/Caddyfile", reviewed, 2],
    ["webapp-deploy/k8s/base/caddy/security.caddy", k8sCopy, 1],
  ])("%s has a text-only match on every encode block", (_name, text, expected) => {
    const blocks = encodeMatches(text);
    expect(blocks).toHaveLength(expected);
    for (const types of blocks) {
      expect(types).toEqual(expect.arrayContaining(["text/html*", "text/css*", "application/json*", "image/svg+xml*"]));
      for (const type of types) {
        expect(type).not.toMatch(/event-stream/);
        expect(type).not.toMatch(/^(video|audio)\//);
        expect(type).not.toBe("text/*");
      }
    }
  });

  it("never encodes without a match, which would include SSE and media", () => {
    expect(reviewed).not.toMatch(/encode zstd gzip\r?\n/);
    expect(k8sCopy).not.toMatch(/encode zstd gzip\r?\n/);
  });
});
