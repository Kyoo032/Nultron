"use client";

import { documentExtension } from "@agentforge/core/chat-documents";
import { formatBytes } from "@agentforge/core/format-bytes";
import {
  documentErrorMessage,
  type ChatDocumentResult,
  type DocumentRead,
  isRetryable,
} from "@/lib/composer-documents";
import { getLocale, t } from "@/lib/i18n";
import type { AttachmentKind } from "@/lib/composer-attach";

export type ChipItem = {
  readonly id: string;
  readonly file: File;
  readonly kind: AttachmentKind;
  readonly read?: DocumentRead;
};

type Props = {
  item: ChipItem;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
};

const CHIP =
  "flex max-w-full items-center gap-2 rounded-pill border border-[var(--line)] px-3 py-1 text-sm text-[var(--text)]";
const CARD =
  "flex max-w-full items-start gap-2 rounded-xl border border-[var(--line)] px-3 py-1.5 text-sm text-[var(--text)]";
const REMOVE = "shrink-0 text-[var(--text-3)] hover:text-[var(--text)]";

function formatCount(value: number): string {
  return value.toLocaleString(getLocale() === "id" ? "id-ID" : "en-US");
}

/**
 * The notes under a document that was read: how much was cut, what was hidden. Nothing about the desk
 * copy: it is written when the message is sent, and the host's notes in the thread say how that went.
 */
function readNotes(result: ChatDocumentResult): string[] {
  const notes: string[] = [];
  if (result.truncated) {
    notes.push(t("chat.document.cut", { sent: formatCount(result.sentChars), total: formatCount(result.chars) }));
  }
  if (result.masked > 0) {
    notes.push(
      result.masked === 1 ? t("chat.document.maskedOne") : t("chat.document.masked", { n: formatCount(result.masked) }),
    );
  }
  return notes;
}

function PlainChip({ item, onRemove }: Pick<Props, "item" | "onRemove">) {
  return (
    <li className={CHIP} data-testid="composer-attachment" data-kind={item.kind}>
      {/* min-w-0 and shrink-0: a long name gives up characters, not the remove button. At 320 px
          the chip ran 36 px past the composer and the × past the window edge. */}
      <span className="min-w-0 max-w-[12rem] truncate">{item.file.name}</span>
      <button
        type="button"
        className={REMOVE}
        data-testid="composer-attachment-remove"
        aria-label={t("chat.removeAttachment", { name: item.file.name })}
        onClick={() => onRemove(item.id)}
      >
        ×
      </button>
    </li>
  );
}

/**
 * The busy indicator while the host reads the file: the desk's own working dots (`.pulse-dots`), the
 * one sanctioned status loop, on the motion tokens and switched off by the reduced-motion block. A
 * Tailwind spin utility here would be a second, unsanctioned loop (`lib/motion-tokens.test.ts`).
 */
function Spinner({ name }: { name: string }) {
  return (
    <span
      className="mt-1.5 shrink-0"
      role="status"
      aria-label={t("chat.document.reading", { name })}
      data-testid="composer-attachment-spinner"
    >
      <span className="pulse-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
    </span>
  );
}

/** One attachment in the composer. Documents show what the host did with them; every other kind is the plain chip. */
export function ComposerAttachmentChip({ item, onRemove, onRetry }: Props) {
  if (item.kind !== "document") {
    return <PlainChip item={item} onRemove={onRemove} />;
  }
  const read: DocumentRead = item.read ?? { status: "reading" };
  const name = item.file.name;
  const meta = `${documentExtension(name).toUpperCase()} · ${formatBytes(item.file.size)}`;
  const notes = read.status === "ready" ? readNotes(read.result) : [];
  return (
    <li className={CARD} data-testid="composer-attachment" data-kind="document" data-state={read.status}>
      {read.status === "reading" ? <Spinner name={name} /> : null}
      <div className="min-w-0 flex-1">
        <span className="block min-w-0 max-w-[16rem] truncate">{name}</span>
        <span className="block text-xs text-[var(--text-3)]" data-testid="composer-attachment-meta">
          {read.status === "reading" ? `${t("chat.document.readingShort")} · ${meta}` : meta}
        </span>
        {read.status === "failed" ? (
          <span
            className="mt-0.5 block text-xs text-[var(--danger)] [overflow-wrap:anywhere]"
            role="alert"
            data-testid="composer-attachment-error"
          >
            {documentErrorMessage(read.error)}
          </span>
        ) : null}
        {notes.map((note) => (
          <span
            key={note}
            className="mt-0.5 block text-xs text-[var(--text-2)] [overflow-wrap:anywhere]"
            data-testid="composer-attachment-note"
          >
            {note}
          </span>
        ))}
        {read.status === "failed" && isRetryable(read.error) ? (
          <button
            type="button"
            className="mt-0.5 text-xs text-[var(--accent)] underline"
            data-testid="composer-attachment-retry"
            aria-label={t("chat.document.retryAria", { name })}
            onClick={() => onRetry(item.id)}
          >
            {t("chat.document.retry")}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        className={REMOVE}
        data-testid="composer-attachment-remove"
        aria-label={t("chat.removeAttachment", { name })}
        onClick={() => onRemove(item.id)}
      >
        ×
      </button>
    </li>
  );
}
