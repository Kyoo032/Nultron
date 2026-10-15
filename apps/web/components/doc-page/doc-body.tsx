import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import type { DocBlock, DocPage, DocSection, DocSheet, SectionAuthors } from "@/lib/docs-client";
import type { SectionEditing } from "@/lib/doc-section-editing";
import { AuthorMark } from "./doc-author-mark";
import type { DocPeople } from "./doc-format";
import { AddSection, SectionEditor, SectionTools } from "./section-editor";

export type SectionActions = (sectionId: string) => ReactNode;

type BodyProps = {
  readonly doc: DocPage;
  readonly people: DocPeople;
  readonly renderSectionActions?: SectionActions;
  readonly editing?: SectionEditing;
};

type CellInput = string | number | null | undefined;

function cellText(value: CellInput): string {
  return value === null || value === undefined ? "" : String(value);
}

function markFor(authors: SectionAuthors, id: string, people: DocPeople): ReactNode {
  const entry = authors[id];
  return entry ? <AuthorMark author={entry.author} people={people} /> : null;
}

function SectionFrame({
  id,
  heading,
  mark,
  actions,
  testId,
  children,
}: {
  readonly id: string;
  readonly heading: string | null;
  readonly mark: ReactNode;
  readonly actions: ReactNode;
  readonly testId: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="doc-section" data-section-id={id} data-testid={testId}>
      <header className="doc-section-head">
        {heading ? <h2 className="doc-section-heading">{heading}</h2> : <span />}
        {mark}
      </header>
      <div className="doc-section-body">{children}</div>
      <div className="doc-section-actions" data-slot="section-actions">
        {actions}
      </div>
    </section>
  );
}

function BlockView({ block }: { readonly block: DocBlock }) {
  switch (block.type) {
    case "paragraph":
      return <p className="doc-p">{block.text}</p>;
    case "bullets":
      return (
        <ul className="doc-list">
          {block.items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      );
    case "numbered":
      return (
        <ol className="doc-list">
          {block.items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ol>
      );
    case "quote":
      return <blockquote className="doc-quote">{block.text}</blockquote>;
    case "pageBreak":
      return <div className="doc-page-break" role="separator" aria-label={t("docpage.pageBreak")} />;
    case "table":
      return (
        <div className="doc-table-wrap">
          <table className="doc-table">
            <thead>
              <tr>
                {block.columns.map((column, index) => (
                  <th key={index} scope="col">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {block.columns.map((_, columnIndex) => (
                    <td key={columnIndex}>{cellText(row[columnIndex])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

const NUMERIC = new Set(["number", "currency", "percent"]);

function SheetTable({ sheet }: { readonly sheet: DocSheet }) {
  return (
    <div className="doc-table-wrap">
      <table className="doc-table">
        <thead>
          <tr>
            {sheet.columns.map((column) => (
              <th key={column.key} scope="col" className={NUMERIC.has(column.type) ? "doc-num" : undefined}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sheet.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {sheet.columns.map((column) => (
                <td key={column.key} className={NUMERIC.has(column.type) ? "doc-num" : undefined}>
                  {cellText(row[column.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DocBody({ doc, people, renderSectionActions, editing }: BodyProps) {
  const authors = doc.sectionAuthors;
  const actionsFor = (id: string): ReactNode => (renderSectionActions ? renderSectionActions(id) : null);
  const actionsForSection = (section: DocSection, open: boolean): ReactNode => {
    if (editing === undefined) {
      return actionsFor(section.id);
    }
    if (open) {
      return null;
    }
    return (
      <>
        {actionsFor(section.id)}
        <SectionTools section={section} headVersion={doc.headVersion} editing={editing} />
      </>
    );
  };

  if (doc.spec.kind === "workbook") {
    return (
      <article className="doc-paper doc-paper-sheets" data-testid="docpage-paper" data-kind="workbook">
        <h1 className="doc-title">{doc.spec.title}</h1>
        {doc.spec.sheets.map((sheet) => (
          <SectionFrame
            key={sheet.id}
            id={sheet.id}
            heading={sheet.name}
            mark={markFor(authors, sheet.id, people)}
            actions={actionsFor(sheet.id)}
            testId="docpage-sheet"
          >
            <SheetTable sheet={sheet} />
          </SectionFrame>
        ))}
      </article>
    );
  }

  return (
    <article className="doc-paper" data-testid="docpage-paper" data-kind="document">
      <h1 className="doc-title">{doc.spec.title}</h1>
      {doc.spec.sections.map((section) => {
        const open = editing !== undefined && editing.openId === section.id;
        return (
          <SectionFrame
            key={section.id}
            id={section.id}
            heading={open ? null : section.heading}
            mark={markFor(authors, section.id, people)}
            actions={actionsForSection(section, open)}
            testId="docpage-section"
          >
            {open && editing !== undefined ? (
              <SectionEditor
                section={section}
                headVersion={doc.headVersion}
                editing={editing}
                renderBlock={(block) => <BlockView block={block} />}
              />
            ) : (
              section.blocks.map((block, index) => <BlockView key={index} block={block} />)
            )}
          </SectionFrame>
        );
      })}
      {editing !== undefined ? (
        <AddSection
          afterSectionId={doc.spec.sections.at(-1)?.id}
          sectionIds={doc.spec.sections.map((section) => section.id)}
          headVersion={doc.headVersion}
          editing={editing}
        />
      ) : null}
    </article>
  );
}
