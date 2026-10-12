import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dossierBodyForView } from "@/components/tool-rows/dossier-result";

const here = dirname(fileURLToPath(import.meta.url));

describe("the dossier as a person reads it", () => {
  it("drops the saved file's front-matter block and starts at the title", () => {
    const saved = [
      "---",
      'question: "When was it built?"',
      'created: "2026-10-09T08:16:04.117Z"',
      'models: ["some-model"]',
      'agentforge: "dossier v1"',
      "---",
      "",
      "# The title",
      "",
      "## Question",
    ].join("\n");
    expect(dossierBodyForView(saved)).toBe("# The title\n\n## Question");
  });

  it("reads Windows line endings and a byte-order mark the same way", () => {
    expect(dossierBodyForView('﻿---\r\nquestion: "q"\r\n---\r\n# Title\r\n')).toBe("# Title\r\n");
  });

  it("leaves a dossier with no front matter exactly as it is", () => {
    const plain = "# Title\n\nA finding.\n\n---\n\nA rule further down is not front matter.\n";
    expect(dossierBodyForView(plain)).toBe(plain);
  });

  it("leaves a block that never closes alone, so nothing is cut by mistake", () => {
    const open = "---\nquestion: q\n# Title\n";
    expect(dossierBodyForView(open)).toBe(open);
  });

  it("is what the card puts on screen", () => {
    const card = readFileSync(resolve(here, "../components/chat-dossier-card.tsx"), "utf8");
    expect(card).toContain("dossierBodyForView(record.body)");
  });
});
