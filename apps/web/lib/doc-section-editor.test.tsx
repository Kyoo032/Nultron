import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocBody } from "@/components/doc-page/doc-body";
import { AddSection, SectionEditor, SectionTools } from "@/components/doc-page/section-editor";
import type { DocPeople } from "@/components/doc-page/doc-format";
import { applyLocale, resetLocaleForTests } from "@/lib/i18n";
import { IDLE_EDIT, type EditState, type SectionEditing } from "@/lib/doc-section-editing";
import { parseDocPage, type DocSection } from "@/lib/docs-client";

const here = dirname(fileURLToPath(import.meta.url));

const PEOPLE: DocPeople = { me: null, nameOf: () => null };

const noop = async () => undefined;

function editingWith(state: Partial<EditState> = {}): SectionEditing {
  return {
    ...IDLE_EDIT,
    ...state,
    open: () => undefined,
    close: () => undefined,
    askRemove: () => undefined,
    save: noop,
    keep: noop,
    reload: noop,
    remove: noop,
    add: noop,
  };
}

const SECTION: DocSection = {
  id: "s1",
  heading: "1. Summary",
  blocks: [
    { type: "paragraph", text: "We hold the Basic tier." },
    { type: "bullets", items: ["Keep Basic", "Raise Pro"] },
    { type: "table", columns: ["Plan", "Now"], rows: [["Basic", 12]] },
  ],
};

const DOCUMENT = parseDocPage({
  artifactId: "art_1",
  title: "Pricing memo",
  kind: "document",
  headVersion: 6,
  spec: {
    kind: "document",
    title: "Pricing memo",
    theme: "plain",
    titlePage: false,
    sections: [SECTION, { id: "s2", heading: null, blocks: [{ type: "paragraph", text: "Second section." }] }],
  },
  sectionAuthors: {},
  proposals: [],
});

const WORKBOOK = parseDocPage({
  artifactId: "art_2",
  title: "Price list",
  kind: "workbook",
  headVersion: 2,
  spec: {
    kind: "workbook",
    title: "Price list",
    theme: "plain",
    sheets: [
      {
        id: "sheet1",
        name: "Plans",
        columns: [{ key: "plan", header: "Plan", type: "text" }],
        rows: [{ plan: "Basic" }],
        totals: false,
        freezeHeader: true,
      },
    ],
  },
  sectionAuthors: {},
  proposals: [],
});

function editorMarkup(editing: SectionEditing): string {
  return renderToStaticMarkup(
    <SectionEditor
      section={SECTION}
      headVersion={6}
      editing={editing}
      renderBlock={() => <span data-testid="table-view">table</span>}
    />,
  );
}

function bodyMarkup(editing?: SectionEditing, doc = DOCUMENT): string {
  return renderToStaticMarkup(<DocBody doc={doc} people={PEOPLE} editing={editing} />);
}

describe("section editor", () => {
  it("opens with the heading and the text, and shows the tables read only with the note", () => {
    resetLocaleForTests();
    applyLocale("en");
    const markup = editorMarkup(editingWith({ openId: "s1" }));
    expect(markup).toContain('value="1. Summary"');
    expect(markup).toContain("We hold the Basic tier.");
    expect(markup).toContain("- Keep Basic");
    expect(markup).toContain("Tables are edited by asking an agent for now");
    expect(markup).toContain('data-testid="table-view"');
    expect(markup).toContain("Save section");
    expect(markup).toContain("Cancel");
  });

  it("shows the conflict sentence and both choices, and keeps the editor", () => {
    const markup = editorMarkup(editingWith({ openId: "s1", notice: { sectionId: "s1", code: "section_changed" } }));
    expect(markup).toContain("Someone changed this section while you were editing");
    expect(markup).toContain("Reload their version");
    expect(markup).toContain("Keep my text and try again");
    expect(markup).toContain('data-testid="docpage-editor-conflict"');
  });

  it("shows the storage sentence for a refused quota", () => {
    const markup = editorMarkup(
      editingWith({ openId: "s1", notice: { sectionId: "s1", code: "storage_quota_exceeded" } }),
    );
    expect(markup).toContain("There is no storage left for this change, so it was not saved.");
    expect(markup).not.toContain("Someone changed this section");
  });

  it("shows a notice that belongs to another section nowhere in this editor", () => {
    const markup = editorMarkup(editingWith({ openId: "s1", notice: { sectionId: "s9", code: "section_changed" } }));
    expect(markup).not.toContain("Someone changed this section");
  });

  it("disables its buttons and says it is saving while a write is in flight", () => {
    const markup = editorMarkup(editingWith({ openId: "s1", busy: true }));
    expect(markup).toContain("Saving…");
    expect(markup.match(/disabled=""/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});

describe("section tools", () => {
  it("offers Edit and Delete on a section, labelled by its heading", () => {
    const markup = renderToStaticMarkup(<SectionTools section={SECTION} headVersion={6} editing={editingWith()} />);
    expect(markup).toContain('data-state="idle"');
    expect(markup).toContain('aria-label="Edit 1. Summary"');
    expect(markup).toContain("Delete section");
  });

  it("asks for confirmation before a delete", () => {
    const markup = renderToStaticMarkup(
      <SectionTools section={SECTION} headVersion={6} editing={editingWith({ confirmingId: "s1" })} />,
    );
    expect(markup).toContain('data-state="confirm"');
    expect(markup).toContain("Delete this section? Its text is removed from the document.");
    expect(markup).toContain("Delete it");
    expect(markup).toContain("Keep it");
  });

  it("says a document keeps at least one section when the last one is refused", () => {
    const markup = renderToStaticMarkup(
      <SectionTools
        section={SECTION}
        headVersion={6}
        editing={editingWith({ notice: { sectionId: "s1", code: "last_section" } })}
      />,
    );
    expect(markup).toContain("A document keeps at least one section, so this one cannot be deleted.");
  });
});

describe("add section", () => {
  it("offers Add section and shows a failed add outside any section", () => {
    const markup = renderToStaticMarkup(
      <AddSection
        afterSectionId="s2"
        sectionIds={["s1", "s2"]}
        headVersion={6}
        editing={editingWith({ notice: { sectionId: null, code: "not_editable" } })}
      />,
    );
    expect(markup).toContain("Add section");
    expect(markup).toContain("The change could not be saved. Try again.");
  });

  it("says Adding while the add is in flight", () => {
    const markup = renderToStaticMarkup(
      <AddSection
        afterSectionId="s2"
        sectionIds={["s1", "s2"]}
        headVersion={6}
        editing={editingWith({ busy: true })}
      />,
    );
    expect(markup).toContain("Adding…");
  });
});

describe("document body with editing", () => {
  it("opens only the section being edited and mounts the tools on the others", () => {
    const markup = bodyMarkup(editingWith({ openId: "s1" }));
    expect(markup.match(/data-testid="docpage-editor"/g)?.length).toBe(1);
    expect(markup.match(/data-testid="docpage-section-tools"/g)?.length).toBe(1);
    expect(markup).toContain('data-section-id="s2"');
    expect(markup).toContain('data-testid="docpage-add-section"');
  });

  it("gives every section its tools when nothing is open", () => {
    const markup = bodyMarkup(editingWith());
    expect(markup.match(/data-testid="docpage-section-tools"/g)?.length).toBe(2);
    expect(markup.match(/data-slot="section-actions"/g)?.length).toBe(2);
  });

  it("shows no editing controls on a workbook, even with editing on", () => {
    const markup = bodyMarkup(editingWith(), WORKBOOK);
    expect(markup).toContain('data-kind="workbook"');
    expect(markup).not.toContain("docpage-section-tools");
    expect(markup).not.toContain("docpage-add-section");
  });

  it("keeps the read-only page as it was when no editing is passed", () => {
    const markup = bodyMarkup(undefined);
    expect(markup).not.toContain("docpage-section-tools");
    expect(markup).not.toContain("docpage-add-section");
    expect(markup.match(/data-slot="section-actions"/g)?.length).toBe(2);
  });
});

describe("the editing UI leaves no Nultron on screen", () => {
  it("renders no Nultron in any text, alt, class, title or aria of the editing markup", () => {
    const markups = [
      editorMarkup(editingWith({ openId: "s1" })),
      editorMarkup(editingWith({ openId: "s1", notice: { sectionId: "s1", code: "section_changed" } })),
      renderToStaticMarkup(
        <SectionTools section={SECTION} headVersion={6} editing={editingWith({ confirmingId: "s1" })} />,
      ),
      renderToStaticMarkup(
        <AddSection afterSectionId="s2" sectionIds={["s1", "s2"]} headVersion={6} editing={editingWith()} />,
      ),
      bodyMarkup(editingWith({ openId: "s1" })),
      bodyMarkup(editingWith()),
    ];
    for (const markup of markups) {
      expect(markup.toLowerCase()).not.toContain("nultron");
    }
  });

  it("names no Nultron in the editing components' source", () => {
    const source = readFileSync(resolve(here, "../components/doc-page/section-editor.tsx"), "utf8");
    expect(source.toLowerCase()).not.toContain("nultron");
  });
});
