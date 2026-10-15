import { useState, type ChangeEvent, type ReactNode } from "react";
import { t } from "@/lib/i18n";
import type { DocBlock, DocSection } from "@/lib/docs-client";
import { sectionInputOf, splitBlocks } from "@/lib/doc-section-text";
import { noticeKeyFor, type SectionEditing } from "@/lib/doc-section-editing";

const HEADING_MAX_LENGTH = 300;
const CONFLICT_CODE = "section_changed";

function NoticeLine({ code }: { readonly code: string }) {
  return (
    <p className="doc-error" role="alert">
      {t(noticeKeyFor(code))}
    </p>
  );
}

type EditorProps = {
  readonly section: DocSection;
  readonly headVersion: number;
  readonly editing: SectionEditing;
  readonly renderBlock: (block: DocBlock) => ReactNode;
};

export function SectionEditor({ section, headVersion, editing, renderBlock }: EditorProps) {
  const split = splitBlocks(section.blocks);
  const [heading, setHeading] = useState(section.heading ?? "");
  const [text, setText] = useState(split.text);
  const busy = editing.busy;
  const notice = editing.notice?.sectionId === section.id ? editing.notice.code : null;

  return (
    <div className="doc-edit" data-testid="docpage-editor" data-section-id={section.id}>
      <label className="doc-edit-field">
        <span className="doc-edit-label">{t("docpage.edit.headingLabel")}</span>
        <input
          className="doc-edit-input"
          value={heading}
          maxLength={HEADING_MAX_LENGTH}
          disabled={busy}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setHeading(event.target.value)}
        />
      </label>
      <label className="doc-edit-field">
        <span className="doc-edit-label">{t("docpage.edit.textLabel")}</span>
        <textarea
          className="doc-edit-text"
          rows={10}
          value={text}
          disabled={busy}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value)}
        />
      </label>
      <p className="doc-edit-hint">{t("docpage.edit.hint")}</p>
      {split.tables.length > 0 ? (
        <div className="doc-edit-tables" data-testid="docpage-editor-tables">
          <p className="doc-edit-note">{t("docpage.edit.tablesNote")}</p>
          {split.tables.map((anchor, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: table anchors have no id and the list is derived in order from the document
            <div key={index}>{renderBlock(anchor.block)}</div>
          ))}
        </div>
      ) : null}
      {notice === CONFLICT_CODE ? (
        <div className="doc-edit-conflict" role="alert" data-testid="docpage-editor-conflict">
          <p className="doc-error">{t("docpage.edit.conflict")}</p>
          <div className="doc-edit-actions">
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void editing.reload()}>
              {t("docpage.edit.reloadTheirs")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() =>
                void editing.keep(section.id, (fresh) =>
                  sectionInputOf(heading, text, splitBlocks(fresh.blocks).tables),
                )
              }
            >
              {t("docpage.edit.keepMine")}
            </button>
          </div>
        </div>
      ) : null}
      {notice !== null && notice !== CONFLICT_CODE ? <NoticeLine code={notice} /> : null}
      <div className="doc-edit-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() =>
            void editing.save(
              section.id,
              sectionInputOf(heading, text, splitBlocks(section.blocks).tables),
              headVersion,
            )
          }
        >
          {busy ? t("docpage.edit.saving") : t("docpage.edit.save")}
        </button>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => editing.close()}>
          {t("docpage.edit.cancel")}
        </button>
      </div>
    </div>
  );
}

type ToolsProps = {
  readonly section: DocSection;
  readonly headVersion: number;
  readonly editing: SectionEditing;
};

export function SectionTools({ section, headVersion, editing }: ToolsProps) {
  const busy = editing.busy;
  const confirming = editing.confirmingId === section.id;
  const notice = editing.notice?.sectionId === section.id ? editing.notice.code : null;
  const label = section.heading ? section.heading : t("docpage.edit.untitled");

  return (
    <>
      <div
        className="doc-section-tools"
        data-testid="docpage-section-tools"
        data-state={confirming ? "confirm" : "idle"}
      >
        {confirming ? (
          <>
            <p className="doc-edit-note">{t("docpage.edit.deleteAsk")}</p>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void editing.remove(section.id, headVersion)}
            >
              {busy ? t("docpage.edit.deleting") : t("docpage.edit.deleteYes")}
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => editing.askRemove(null)}>
              {t("docpage.edit.deleteNo")}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              aria-label={t("docpage.edit.editAria", { name: label })}
              onClick={() => editing.open(section.id)}
            >
              {t("docpage.edit.edit")}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => editing.askRemove(section.id)}
            >
              {t("docpage.edit.delete")}
            </button>
          </>
        )}
      </div>
      {notice !== null ? <NoticeLine code={notice} /> : null}
    </>
  );
}

type AddProps = {
  readonly afterSectionId: string | undefined;
  readonly sectionIds: readonly string[];
  readonly headVersion: number;
  readonly editing: SectionEditing;
};

export function AddSection({ afterSectionId, sectionIds, headVersion, editing }: AddProps) {
  const notice = editing.notice?.sectionId === null ? editing.notice.code : null;
  return (
    <div className="doc-add" data-testid="docpage-add-section">
      <button
        type="button"
        className="btn btn-secondary"
        disabled={editing.busy}
        onClick={() => void editing.add(afterSectionId, headVersion, sectionIds)}
      >
        {editing.busy ? t("docpage.edit.adding") : t("docpage.edit.add")}
      </button>
      {notice !== null ? <NoticeLine code={notice} /> : null}
    </div>
  );
}
