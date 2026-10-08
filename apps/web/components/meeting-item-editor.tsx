"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import type { MeetingActionItem, MeetingDecision, MinutesItemEdit } from "@agentforge/core/meeting";
import { t } from "@/lib/i18n";
import {
  actionDraftOf,
  actionDraftValid,
  actionEdit,
  decisionDraftOf,
  decisionDraftValid,
  decisionEdit,
  submitEdit,
  type ActionDraft,
  type DecisionDraft,
} from "@/lib/meeting-edit";

/**
 * The inline form for one decision or action item.
 *
 * The owner changes the words they are allowed to change; the quote and the evidence verdict stay as they
 * were (the host never takes them). Save sends only what changed, through `onSave`, which answers the
 * host's refusal sentence or null when it took the edit. Editing is free: no model call.
 */
type EditorProps<Item> = {
  readonly index: number;
  readonly item: Item;
  readonly onSave: (edit: MinutesItemEdit) => Promise<string | null>;
  readonly onClose: () => void;
  /** An earlier translation exists: saving clears it, which the form says before the owner commits. */
  readonly clearsTranslation: boolean;
};

const AREA = "mt-1 w-full rounded-lg border border-[var(--line)] bg-transparent px-3 py-2 text-sm text-[var(--text)]";
const LINE = "text-field mt-1 w-full";

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="block text-xs text-[var(--text-2)]">
      {label}
      {children}
    </label>
  );
}

/** The part both forms share: what went wrong, what saving costs, and the two buttons. */
function Footer({
  canSave,
  saving,
  error,
  clearsTranslation,
  onCancel,
}: {
  readonly canSave: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly clearsTranslation: boolean;
  readonly onCancel: () => void;
}) {
  return (
    <>
      {error ? (
        <p className="text-xs text-[var(--danger)]" role="alert" data-testid="meeting-edit-error">
          {error}
        </p>
      ) : null}
      {clearsTranslation ? (
        <p className="text-xs text-[var(--text-3)]" data-testid="meeting-edit-clears-translation">
          {t("meeting.edit.clearsTranslation")}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={!canSave || saving}
          className="btn btn-primary h-8 rounded-pill px-4 text-sm"
          data-testid="meeting-edit-save"
        >
          {saving ? t("meeting.edit.saving") : t("meeting.edit.save")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="inline-flex h-8 items-center rounded-pill border border-[var(--line)] px-4 text-sm text-[var(--text-2)] disabled:opacity-45"
          data-testid="meeting-edit-cancel"
        >
          {t("meeting.edit.cancel")}
        </button>
        <span className="text-xs text-[var(--text-3)]">{t("meeting.edit.free")}</span>
      </div>
    </>
  );
}

/** Draft state and the save round trip, shared by both forms. */
function useEditor<Draft>(initial: Draft, valid: (draft: Draft) => boolean, build: (draft: Draft) => MinutesItemEdit | null, props: Pick<EditorProps<unknown>, "onSave" | "onClose">) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || !valid(draft)) {
      return;
    }
    setSaving(true);
    setError(null);
    const result = await submitEdit(build(draft), props.onSave);
    setSaving(false);
    if (result.done) {
      props.onClose();
    } else {
      setError(result.message);
    }
  }

  return { draft, setDraft, saving, error, submit, canSave: valid(draft) };
}

export function DecisionEditor({ index, item, onSave, onClose, clearsTranslation }: EditorProps<MeetingDecision>) {
  const editor = useEditor<DecisionDraft>(
    decisionDraftOf(item),
    decisionDraftValid,
    (draft) => decisionEdit(index, item, draft),
    { onSave, onClose },
  );
  const { draft, setDraft } = editor;
  return (
    <form className="space-y-2.5" onSubmit={(event) => void editor.submit(event)} data-testid="meeting-item-form">
      <Field label={t("meeting.edit.decision")}>
        <textarea
          value={draft.statement}
          onChange={(event) => setDraft({ ...draft, statement: event.target.value })}
          rows={2}
          className={AREA}
          data-testid="meeting-edit-statement"
        />
      </Field>
      <Field label={t("meeting.edit.context")}>
        <input
          value={draft.context}
          onChange={(event) => setDraft({ ...draft, context: event.target.value })}
          className={LINE}
          data-testid="meeting-edit-context"
        />
      </Field>
      <label className="flex items-center gap-2 text-xs text-[var(--text-2)]">
        <input
          type="checkbox"
          checked={draft.provisional}
          onChange={(event) => setDraft({ ...draft, provisional: event.target.checked })}
          data-testid="meeting-edit-provisional"
        />
        {t("meeting.edit.provisional")}
      </label>
      <Footer
        canSave={editor.canSave}
        saving={editor.saving}
        error={editor.error}
        clearsTranslation={clearsTranslation}
        onCancel={onClose}
      />
    </form>
  );
}

export function ActionEditor({ index, item, onSave, onClose, clearsTranslation }: EditorProps<MeetingActionItem>) {
  const editor = useEditor<ActionDraft>(
    actionDraftOf(item),
    actionDraftValid,
    (draft) => actionEdit(index, item, draft),
    { onSave, onClose },
  );
  const { draft, setDraft } = editor;
  return (
    <form className="space-y-2.5" onSubmit={(event) => void editor.submit(event)} data-testid="meeting-item-form">
      <Field label={t("meeting.edit.task")}>
        <textarea
          value={draft.task}
          onChange={(event) => setDraft({ ...draft, task: event.target.value })}
          rows={2}
          className={AREA}
          data-testid="meeting-edit-task"
        />
      </Field>
      <div className="grid gap-2.5 sm:grid-cols-2">
        <Field label={t("meeting.edit.owner")}>
          <input
            value={draft.owner}
            onChange={(event) => setDraft({ ...draft, owner: event.target.value })}
            className={LINE}
            data-testid="meeting-edit-owner"
          />
        </Field>
        <Field label={t("meeting.edit.due")}>
          <input
            value={draft.due}
            onChange={(event) => setDraft({ ...draft, due: event.target.value })}
            className={LINE}
            data-testid="meeting-edit-due"
          />
        </Field>
      </div>
      <Field label={t("meeting.edit.firstStep")}>
        <input
          value={draft.firstStep}
          onChange={(event) => setDraft({ ...draft, firstStep: event.target.value })}
          className={LINE}
          data-testid="meeting-edit-first-step"
        />
      </Field>
      <Footer
        canSave={editor.canSave}
        saving={editor.saving}
        error={editor.error}
        clearsTranslation={clearsTranslation}
        onCancel={onClose}
      />
    </form>
  );
}
