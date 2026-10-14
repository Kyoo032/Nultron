"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { FormattedText } from "@/components/formatted-text";
import {
  BoardError,
  addComment,
  archiveCard,
  loadCard,
  updateCard,
  type BoardColumn,
  type BoardPerson,
  type CardComment,
  type CardDetail,
} from "@/lib/board-client";
import { changeOf, draftOf, isDirty, rebaseDraft, type CardDraft } from "@/lib/board-draft";
import { boardErrorMessage, columnLabel, mayArchive, personLabel } from "@/lib/board-view";
import { t } from "@/lib/i18n";

type Props = {
  cardId: string;
  columns: readonly BoardColumn[];
  people: readonly BoardPerson[];
  me: string;
  /** An owner or admin may archive any card; anyone else only one they created or are assigned. */
  canAdminister: boolean;
  /** Bumped by the page when the stream reports a change to this card, so the dialog reads it again. */
  refreshKey: number;
  onClose: () => void;
  onChanged: () => void;
};

export function BoardCardDialog({
  cardId,
  columns,
  people,
  me,
  canAdminister,
  refreshKey,
  onClose,
  onChanged,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [card, setCard] = useState<CardDetail | null>(null);
  const [draft, setDraft] = useState<CardDraft | null>(null);
  const [comments, setComments] = useState<CardComment[]>([]);
  const [editingDescription, setEditingDescription] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  // The latest base and draft, for the load effect: it must not re-run when the person types.
  const latest = useRef<{ card: CardDetail | null; draft: CardDraft | null }>({ card: null, draft: null });
  latest.current = { card, draft };

  /** Take a newer card from the host. Untouched boxes follow it; edited boxes keep the person's text. */
  const adopt = (next: CardDetail) => {
    const { card: base, draft: boxes } = latest.current;
    const edited = base !== null && boxes !== null && isDirty(base, boxes);
    setDraft(base && boxes ? rebaseDraft(boxes, base, next) : draftOf(next));
    setCard(next);
    return edited && base !== null && base.version !== next.version;
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && typeof dialog.showModal === "function" && !dialog.open) {
      dialog.showModal();
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `adopt` reads refs; the effect re-runs on the card and on stream nudges only.
  useEffect(() => {
    let cancelled = false;
    loadCard(cardId)
      .then((loaded) => {
        if (cancelled) {
          return;
        }
        setComments(loaded.comments);
        if (adopt(loaded.card)) {
          setMessage(t("board.detail.changedElsewhere"));
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        if (error instanceof BoardError && error.code === "card_not_found") {
          setGone(true);
        }
        setMessage(boardErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [cardId, refreshKey]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!card || !draft) {
      return;
    }
    const change = changeOf(card, draft);
    if (!change) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const saved = await updateCard(card.id, change);
      setCard(saved);
      setDraft(draftOf(saved));
      setEditingDescription(false);
      setMessage(t("board.detail.saved"));
      onChanged();
    } catch (error) {
      if (error instanceof BoardError && error.code === "card_conflict" && error.card) {
        // Their version becomes the base; the person's edits stay in the boxes for a second save.
        adopt(error.card);
      }
      if (error instanceof BoardError && error.code === "card_not_found") {
        setGone(true);
      }
      setMessage(boardErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!card || !window.confirm(t("board.detail.archiveConfirm"))) {
      return;
    }
    setBusy(true);
    try {
      await archiveCard(card.id, card.version);
      onChanged();
      onClose();
    } catch (error) {
      if (error instanceof BoardError && error.code === "card_conflict" && error.card) {
        adopt(error.card);
      }
      setMessage(boardErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!comment.trim()) {
      return;
    }
    setBusy(true);
    try {
      const added = await addComment(cardId, comment);
      setComments((previous) => [...previous, added]);
      setComment("");
      onChanged();
    } catch (error) {
      setMessage(boardErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const update = (patch: Partial<CardDraft>) =>
    setDraft((previous) => (previous ? { ...previous, ...patch } : previous));

  return (
    <dialog
      ref={dialogRef}
      className="board-dialog"
      aria-label={t("board.detail.dialog")}
      data-testid="board-card-dialog"
      onClose={onClose}
      onCancel={onClose}
    >
      <div className="board-dialog-head">
        <p className="board-dialog-kicker">{t("board.detail.dialog")}</p>
        <button type="button" className="btn btn-ghost" onClick={onClose} data-testid="board-card-close">
          {t("board.detail.close")}
        </button>
      </div>

      {message ? (
        <p className="board-dialog-message" role="status" data-testid="board-card-message">
          {message}
        </p>
      ) : null}

      {card && draft && !gone ? (
        <>
          <form className="board-dialog-form field" onSubmit={(event) => void save(event)}>
            <label htmlFor="board-card-title">{t("board.detail.title")}</label>
            <input
              id="board-card-title"
              value={draft.title}
              maxLength={200}
              onChange={(event) => update({ title: event.target.value })}
              data-testid="board-card-title"
            />

            <div className="board-dialog-row">
              <span className="label">{t("board.detail.description")}</span>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setEditingDescription((value) => !value)}
                data-testid="board-card-description-toggle"
              >
                {editingDescription ? t("board.detail.preview") : t("board.detail.edit")}
              </button>
            </div>
            {editingDescription ? (
              <>
                <textarea
                  value={draft.description}
                  rows={8}
                  maxLength={20000}
                  onChange={(event) => update({ description: event.target.value })}
                  data-testid="board-card-description"
                />
                <p className="board-dialog-hint">{t("board.detail.markdownHint")}</p>
              </>
            ) : draft.description.trim() ? (
              <FormattedText
                text={draft.description}
                className="board-dialog-preview"
                testId="board-card-description-view"
              />
            ) : (
              <p className="board-dialog-hint">{t("board.detail.descriptionEmpty")}</p>
            )}

            <div className="board-dialog-grid">
              <label>
                <span className="label">{t("board.detail.assignee")}</span>
                <select
                  className="input"
                  value={draft.assignee}
                  onChange={(event) => update({ assignee: event.target.value })}
                  data-testid="board-card-assignee"
                >
                  <option value="">{t("board.card.unassigned")}</option>
                  {people.map((person) => (
                    <option key={person.userId} value={person.userId}>
                      {personLabel(people, person.userId, me)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="label">{t("board.detail.column")}</span>
                <select
                  className="input"
                  value={draft.columnId}
                  onChange={(event) => update({ columnId: event.target.value })}
                  data-testid="board-card-column"
                >
                  {columns.map((column) => (
                    <option key={column.id} value={column.id}>
                      {columnLabel(column)}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="board-dialog-actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy || !draft.title.trim() || changeOf(card, draft) === null}
                data-testid="board-card-save"
              >
                {busy ? t("board.detail.saving") : t("board.detail.save")}
              </button>
              {mayArchive(card, me, canAdminister) ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => void archive()}
                  data-testid="board-card-archive"
                >
                  {t("board.detail.archive")}
                </button>
              ) : null}
            </div>
          </form>

          <section className="board-dialog-comments" aria-label={t("board.detail.comments")}>
            <h2 className="board-dialog-subhead">{t("board.detail.comments")}</h2>
            {comments.length === 0 ? <p className="board-dialog-hint">{t("board.detail.noComments")}</p> : null}
            <ol className="board-comment-list" data-testid="board-card-comments">
              {comments.map((entry) => (
                <li key={entry.id} className="board-comment">
                  <p className="board-comment-author">
                    {personLabel(people, entry.authorUserId, me)}
                    <time dateTime={new Date(entry.createdAt).toISOString()}>
                      {new Date(entry.createdAt).toLocaleString()}
                    </time>
                  </p>
                  <FormattedText text={entry.body} />
                </li>
              ))}
            </ol>
            <form className="board-comment-form field" onSubmit={(event) => void send(event)}>
              <textarea
                value={comment}
                rows={3}
                maxLength={20000}
                placeholder={t("board.detail.commentPlaceholder")}
                aria-label={t("board.detail.commentPlaceholder")}
                onChange={(event) => setComment(event.target.value)}
                data-testid="board-comment-input"
              />
              <button
                type="submit"
                className="btn btn-secondary"
                disabled={busy || !comment.trim()}
                data-testid="board-comment-send"
              >
                {t("board.detail.commentSend")}
              </button>
            </form>
          </section>
        </>
      ) : null}
    </dialog>
  );
}
