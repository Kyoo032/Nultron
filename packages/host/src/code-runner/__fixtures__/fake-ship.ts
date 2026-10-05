import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A ship directory in the layout `ship.ts` documents, whose child entry scripts are the fake child
 * (`fake-child.mjs`). Each test gets its own, so a tampered one cannot leak into the next.
 */
export type FakeShip = {
  /** The ship directory itself: what `--allow-fs-read` grants. */
  readonly dir: string;
  /** A readable file one level ABOVE the ship directory, which the sandbox must not be able to read. */
  readonly outsideFile: string;
  /** A file inside the ship directory the manifest pins. */
  readonly pinnedFile: string;
  /** Removes the directory. A killed child holds its working directory for a moment on Windows, so this retries. */
  cleanup(): Promise<void>;
};

export type FakeShipOptions = {
  readonly boot?: "ok" | "fatal" | "exit" | "hang";
  /** `none` omits the Pyodide manifest (Python becomes unavailable), `root` adds a ship-root manifest. */
  readonly manifest?: "pyodide" | "none" | "root";
  readonly withQuickJs?: boolean;
};

const FAKE_CHILD = fileURLToPath(new URL("./fake-child.mjs", import.meta.url));

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function makeFakeShip(options: FakeShipOptions = {}): FakeShip {
  const parent = mkdtempSync(join(tmpdir(), "agentforge-fake-ship-"));
  const dir = join(parent, "ship");
  const pyodide = join(dir, "vendor", "pyodide");
  mkdirSync(pyodide, { recursive: true });
  const outsideFile = join(parent, "outside.txt");
  writeFileSync(outsideFile, "host secret");

  copyFileSync(FAKE_CHILD, join(dir, "py-child.mjs"));
  copyFileSync(FAKE_CHILD, join(dir, "qjs-child.mjs"));
  if (options.boot && options.boot !== "ok") {
    writeFileSync(join(dir, "boot-mode.txt"), options.boot);
  }
  const pinnedFile = join(pyodide, "pyodide-lock.json");
  writeFileSync(pinnedFile, '{"packages":{}}');
  if (options.manifest !== "none") {
    writeFileSync(
      join(pyodide, "MANIFEST.json"),
      JSON.stringify({ files: [{ name: "pyodide-lock.json", sha256: sha256('{"packages":{}}') }] }),
    );
  }
  if (options.withQuickJs !== false) {
    mkdirSync(join(dir, "node_modules", "quickjs-emscripten-core"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "quickjs-emscripten-core", "package.json"), "{}");
  }
  if (options.manifest === "root") {
    const entry = readFileSync(join(dir, "py-child.mjs"), "utf8");
    writeFileSync(
      join(dir, "MANIFEST.json"),
      JSON.stringify({ files: [{ name: "py-child.mjs", sha256: sha256(entry) }] }),
    );
  }
  return {
    dir,
    outsideFile,
    pinnedFile,
    cleanup: async () => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          rmSync(parent, { recursive: true, force: true });
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      // A leftover directory under the OS temp dir is harmless; do not fail a test for it.
    },
  };
}
