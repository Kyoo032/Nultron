/**
 * The narrow-pane layout rules of the job desks, held by the shape of their markup.
 *
 * Node has no layout engine, so this cannot measure a width; it holds the rules the widths depend on.
 * The widths themselves are driven live at 390, 768, 1024 and 1440 on webdev
 * (`.cursor/skills/verify-agentforge/features/shell-scroll.md`).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROMPT_ACTIONS, PROMPT_INPUT, PROMPT_ROW, PROMPT_SUBMIT } from "./prompt-row";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const component = (name: string) => readFileSync(join(web, "components", name), "utf8").replace(/\r\n/g, "\n");

describe("prompt row classes", () => {
  it("makes the row a container and answers to its width, not the window's", () => {
    expect(PROMPT_ROW).toContain("flex-wrap");
    expect(PROMPT_ROW).toContain("[container-type:inline-size]");
    for (const rule of [PROMPT_SUBMIT, PROMPT_ACTIONS]) {
      for (const query of rule.match(/\[@container\([^)]*\)\]/g) ?? []) {
        expect(query).toBe("[@container(max-width:40rem)]");
      }
    }
    expect(PROMPT_ROW.match(/\[@container\([^)]*\)\]/g)).toEqual(["[@container(max-width:26rem)]"]);
  });

  it("keeps Enhance's word for screen readers when the row is narrow, as the composer does", () => {
    expect(PROMPT_ROW).toContain("[&_.enhance-btn-label]:sr-only");
  });

  it("lets the prompt shrink below its placeholder instead of pushing a button out", () => {
    expect(PROMPT_INPUT).toContain("min-w-0");
    expect(PROMPT_INPUT).toContain("flex-1");
  });
});

describe("the desks that share the prompt row", () => {
  it.each([
    "documents-studio.tsx",
    "research-studio.tsx",
    "images-studio.tsx",
    "videos-studio.tsx",
    "music-studio.tsx",
    "data-studio.tsx",
  ])("%s builds its row from PROMPT_ROW", (file) => {
    const source = component(file);
    expect(source).toContain("className={PROMPT_ROW}");
    expect(source).toContain('from "@/lib/prompt-row"');
  });

  it.each(["documents-studio.tsx", "images-studio.tsx", "videos-studio.tsx", "music-studio.tsx"])(
    "%s lets its submit button take its own line when the row is narrow",
    (file) => {
      expect(component(file)).toContain("PROMPT_SUBMIT");
    },
  );

  it.each(["research-studio.tsx", "data-studio.tsx"])(
    "%s groups Cancel with submit so they share that line",
    (file) => {
      expect(component(file)).toContain("className={PROMPT_ACTIONS}");
    },
  );

  it("gives Documents and Research the shared select recipe, not a one-off", () => {
    for (const file of ["documents-studio.tsx", "research-studio.tsx"]) {
      expect(component(file)).toMatch(/className="select-field w-full"/);
    }
  });

  it("lets Data's model select wrap under Enhance instead of overflowing the form", () => {
    expect(component("data-studio.tsx")).toMatch(/className="select-field min-w-0 max-w-md flex-1 basis-48"/);
  });
});

describe("the grid that holds the Legal matter panel", () => {
  it("has a one-column template of its own, so a wide child cannot stretch the track", () => {
    // Measured on 2026-10-01 at 390 px: with no template below `lg` the implicit track is `auto`, which
    // grows to the panel's min-content and put the panel 31 px past the pane.
    expect(component("legal-studio.tsx")).toContain("grid-cols-[minmax(0,1fr)]");
  });
});

describe("Edit before a project is open", () => {
  const source = component("edit-empty-state.tsx");

  it("is a size container, so its columns follow the pane and not the window", () => {
    expect(source).toContain("[container-type:inline-size]");
    expect(source).toContain("[@container(min-width:40rem)]");
    expect(source).toContain("[@container(min-width:64rem)]");
  });

  it("keeps each testid the verify recipe and the e2e spec look for, once", () => {
    for (const id of ["edit-project-list", "edit-preview", "edit-timeline", "edit-agent-panel"]) {
      expect(source.match(new RegExp(`data-testid="${id}"`, "g"))?.length, id).toBe(1);
    }
  });

  it("no longer pins the placeholder columns to a fixed width at every size", () => {
    expect(component("edit-studio.tsx")).not.toMatch(/w-\[320px\]|w-\[280px\]/);
  });
});
