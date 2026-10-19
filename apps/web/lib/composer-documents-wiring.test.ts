/**
 * The composer's three doors for a file, held to one route.
 *
 * The picker, a drop and a paste must all end in `addFiles`, so a document is classified, counted
 * and read the same way whichever door it came through. The component cannot be rendered with a
 * clipboard in a node environment, so this reads the source the way `chat-thinking-wiring.test.ts`
 * does: it fails if a door is rewired to something else, or a fourth way of adding a file appears.
 * The doors are driven for real in the browser (`features/chat.md`, "Documents").
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(web, "components", "chat-composer.tsx"), "utf8").replace(/\r\n/g, "\n");

describe("chat composer: one route for every attachment", () => {
  it("defines addFiles once", () => {
    expect(source.match(/function addFiles\(/g)).toHaveLength(1);
  });

  it("sends the file picker, a drop and a paste through it", () => {
    expect(source).toContain("onChange={(event) => addFiles(event.target.files)}");
    expect(source).toContain("addFiles(event.dataTransfer.files)");
    expect(source).toMatch(
      /onPaste=\{\(event\) => \{[\s\S]*?pastedFiles\(event\.clipboardData\)[\s\S]*?addFiles\(pasted\)/,
    );
  });

  it("builds the file input's accept list from the shared constant", () => {
    expect(source).toContain("accept={COMPOSER_FILE_ACCEPT}");
  });

  it("adds a file nowhere else", () => {
    // Every push into the held list happens inside addFiles.
    const outside = source.replace(/function addFiles\([\s\S]*?\n {2}\}\n/, "");
    expect(outside).not.toMatch(/next\.push\(/);
    expect(outside).not.toMatch(/setFiles\(\[/);
  });

  it("holds Send while a document is reading or has failed, on the button and on Enter", () => {
    expect(source).toContain("const documentsHoldSend = documentsBlockSend(files);");
    expect(source).toMatch(/const sendDisabled = [^;]*documentsHoldSend;/);
    // Continue is a text turn and does not take the files in the box. A normal send still waits.
    expect(source).toMatch(
      /async function send\(override\?: string, retrying = false\) \{[\s\S]*?const \{ continuing, typed, attached \} = sendSource\(override, text, files\);[\s\S]*?if \(!continuing && documentsHoldSend\) \{[\s\S]*?return;/,
    );
    expect(source).toContain("sendSource(override, text, files)");
  });

  it("inlines every text file and document through inlineBlock, and reads no file as text itself", () => {
    expect(source).toContain("await inlineBlock(held)");
    expect(source).not.toMatch(/\.text\(\)/);
  });

  it("says why when a document cannot be saved as the message is sent, and sends nothing", () => {
    // The save call is a failed send, not a message that goes without the file: the error is shown, the
    // draft stays in the box, and the run is never started.
    expect(source).toContain("ChatDocumentError");
    expect(source).toMatch(
      /catch \(error\) \{\s*if \(error instanceof ChatDocumentError\) \{[\s\S]*?setError\(documentErrorMessage\(error\.key\)\)[\s\S]*?return;/,
    );
    const catchAt = source.indexOf("error instanceof ChatDocumentError");
    const runAt = source.indexOf("/runs/text");
    expect(catchAt).toBeGreaterThan(0);
    expect(catchAt).toBeLessThan(runAt);
  });

  it("draws every attachment through the chip component", () => {
    expect(source).toContain("<ComposerAttachmentChip");
    expect(source).not.toContain('data-testid="composer-attachment"');
  });
});
