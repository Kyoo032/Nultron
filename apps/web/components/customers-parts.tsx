"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { INBOX_CAPS, WHATSAPP_WEBHOOK_PATH } from "@agentforge/core/inbox";
import {
  callbackUrl,
  contactLabel,
  deliveryKey,
  formatPhone,
  initialsOf,
  replyTime,
  stampLabel,
  windowState,
} from "@/lib/customers-format";
import type {
  ConversationFilter,
  ConversationState,
  CustomerConversation,
  CustomerMessage,
  InboxSummary,
  WhatsAppConnection,
} from "@/lib/customers-client";
import { t } from "@/lib/i18n";

const PANEL = "raise rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4";

/* ------------------------------------------------------------------------------------ Today */

function Stat({
  id,
  label,
  value,
  hot = false,
  wide = false,
}: {
  id: string;
  label: string;
  value: string;
  hot?: boolean;
  /** Span both columns on a phone, so an odd last card does not sit alone beside a gap. */
  wide?: boolean;
}) {
  return (
    <div
      className={`${PANEL}${wide ? " col-span-2 md:col-span-1" : ""}`}
      data-testid={`customers-stat-${id}`}
      data-hot={hot ? "true" : "false"}
    >
      <p className="panel-label">{label}</p>
      <p
        className={`mt-1 font-heading text-[length:var(--fs-24)] font-bold leading-[var(--lh-tight)] ${hot ? "text-[var(--mode)]" : "text-[var(--text)]"}`}
      >
        {value}
      </p>
    </div>
  );
}

/** The start of the owner's day: what is waiting, and how today is going. */
export function TodayStrip({ summary }: { summary: InboxSummary | null }) {
  const reply = summary ? replyTime(summary.medianFirstReplySeconds) : null;
  const dash = "–";
  return (
    <section className="grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="customers-today">
      <Stat
        id="needs-you"
        label={t("customers.today.needsYou")}
        value={summary ? String(summary.needsYou) : dash}
        hot={(summary?.needsYou ?? 0) > 0}
      />
      <Stat id="with-you" label={t("customers.today.withYou")} value={summary ? String(summary.withYou) : dash} />
      <Stat id="received" label={t("customers.today.received")} value={summary ? String(summary.receivedToday) : dash} />
      <Stat id="sent" label={t("customers.today.sent")} value={summary ? String(summary.sentToday) : dash} />
      <Stat
        wide
        id="first-reply"
        label={t("customers.today.firstReply")}
        value={reply ? t(`customers.today.${reply.unit}`, { value: reply.value }) : summary ? t("customers.today.noReplyYet") : dash}
      />
    </section>
  );
}

/* ---------------------------------------------------------------------------------- Connect */

export function ConnectCard({
  connection,
  busy,
  error = null,
  onConnect,
  onDisconnect,
}: {
  connection: WhatsAppConnection;
  busy: boolean;
  /** Why the last connect or disconnect failed, shown inside the card. */
  error?: string | null;
  onConnect: (phoneNumberId: string, accessToken: string) => void;
  onDisconnect: () => void;
}) {
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [copied, setCopied] = useState(false);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const url = callbackUrl(origin, WHATSAPP_WEBHOOK_PATH);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard permission: the URL is on screen to select by hand.
    }
  }

  return (
    <section className={PANEL} data-testid="customers-connect-card">
      <p className="panel-label">{t("customers.connect.label")}</p>
      {connection.connected ? (
        <div className="mt-2">
          <p className="text-sm text-[var(--text)]" data-testid="customers-connect-status">
            {t("customers.connect.connected", { phone: connection.displayPhone ?? "" })}
            {connection.verifiedName ? ` · ${connection.verifiedName}` : ""}
          </p>
          <p className="mt-1 text-[12px] text-[var(--text-2)]" data-testid="customers-connect-fingerprint">
            {connection.fingerprint ?? ""}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn"
              disabled={busy}
              data-testid="customers-disconnect"
              onClick={onDisconnect}
            >
              {t("customers.connect.disconnect")}
            </button>
            <span className="text-[12px] text-[var(--text-2)]">{t("customers.connect.disconnectNote")}</span>
          </div>
        </div>
      ) : (
        <form
          className="mt-2"
          data-testid="customers-connect-form"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            const id = phoneNumberId.trim();
            const token = accessToken.trim();
            if (id && token) {
              onConnect(id, token);
              setAccessToken("");
            }
          }}
        >
          <p className="text-sm text-[var(--text-2)]">{t("customers.connect.intro")}</p>
          <label className="mt-3 block text-[12px] text-[var(--text-2)]">
            {t("customers.connect.phoneNumberId")}
            <input
              className="input mt-1 w-full"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              placeholder={t("customers.connect.phoneNumberIdPlaceholder")}
              value={phoneNumberId}
              data-testid="customers-phone-number-id"
              onChange={(event) => setPhoneNumberId(event.target.value)}
            />
          </label>
          <label className="mt-3 block text-[12px] text-[var(--text-2)]">
            {t("customers.connect.accessToken")}
            <input
              className="input mt-1 w-full"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={t("customers.connect.accessTokenPlaceholder")}
              value={accessToken}
              data-testid="customers-access-token"
              onChange={(event) => setAccessToken(event.target.value)}
            />
          </label>
          <button type="submit" className="btn btn-primary mt-3" disabled={busy} data-testid="customers-connect">
            {t("customers.connect.connect")}
          </button>
        </form>
      )}

      {error ? (
        <p className="mt-3 text-sm text-red-700" role="alert" data-testid="customers-connect-error">
          {error}
        </p>
      ) : null}

      {/* The URL Meta calls. Shown before and after connecting: Meta needs it set up once either way. */}
      <details className="mt-3" data-testid="customers-callback">
        <summary className="cursor-pointer select-none text-xs font-medium text-[var(--text-2)]">
          {t("customers.connect.callbackLabel")}
        </summary>
        <div className="mt-2 flex items-center gap-2">
          <code
            className="min-w-0 flex-1 rounded-lg bg-[var(--surface-2)] px-2 py-1 text-[12px] [overflow-wrap:anywhere]"
            data-testid="customers-callback-url"
          >
            {url}
          </code>
          <button type="button" className="btn btn-quiet" onClick={() => void copy()} data-testid="customers-callback-copy">
            {copied ? t("customers.connect.copied") : t("customers.connect.copy")}
          </button>
        </div>
        <p className="mt-2 text-[12px] text-[var(--text-2)]">{t("customers.connect.callbackHint")}</p>
      </details>

      {connection.webhookReady ? null : (
        <p className="mt-3 text-[12px] text-amber-700" data-testid="customers-not-ready">
          {t("customers.connect.notReady")}
        </p>
      )}
      {connection.pinnedOrigin ? null : (
        <p className="mt-3 text-[12px] text-amber-700" data-testid="customers-sandbox-note">
          {t("customers.connect.sandbox")}
        </p>
      )}
    </section>
  );
}

/* ----------------------------------------------------------------------------------- List */

const FILTERS: ConversationFilter[] = ["all", "needs_you", "with_you", "closed"];

export function ConversationList({
  conversations,
  selectedId,
  filter,
  query,
  now,
  onFilter,
  onQuery,
  onSelect,
}: {
  conversations: CustomerConversation[];
  selectedId: string | null;
  filter: ConversationFilter;
  query: string;
  now: number;
  onFilter: (filter: ConversationFilter) => void;
  onQuery: (query: string) => void;
  onSelect: (conversationId: string) => void;
}) {
  const filtered = filter !== "all" || query.trim() !== "";
  return (
    <section className={PANEL} data-testid="customers-list-panel">
      <div className="flex flex-wrap gap-1" role="group" aria-label={t("customers.title")}>
        {FILTERS.map((id) => (
          <button
            key={id}
            type="button"
            className={filter === id ? "btn btn-primary" : "btn btn-quiet"}
            aria-pressed={filter === id}
            data-testid={`customers-filter-${id}`}
            onClick={() => onFilter(id)}
          >
            {t(`customers.filters.${id}`)}
          </button>
        ))}
      </div>
      <input
        className="input mt-3 w-full"
        type="search"
        maxLength={80}
        placeholder={t("customers.list.search")}
        aria-label={t("customers.list.search")}
        value={query}
        data-testid="customers-search"
        onChange={(event) => onQuery(event.target.value)}
      />
      {conversations.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--text-2)]" data-testid="customers-empty">
          {filtered ? t("customers.list.emptyFiltered") : t("customers.list.empty")}
        </p>
      ) : (
        <ul className="mt-3 flex max-h-[420px] flex-col gap-1 overflow-y-auto lg:max-h-[560px]" data-testid="customers-list">
          {conversations.map((conversation) => (
            <li key={conversation.id}>
              <button
                type="button"
                className="flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left hover:bg-[var(--surface-2)] data-[on=true]:bg-[var(--surface-2)]"
                data-testid="customers-item"
                data-on={conversation.id === selectedId ? "true" : "false"}
                data-state={conversation.state}
                aria-pressed={conversation.id === selectedId}
                onClick={() => onSelect(conversation.id)}
              >
                <span
                  className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-[12px] font-semibold text-[var(--text-2)]"
                  aria-hidden="true"
                >
                  {initialsOf(conversation)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium text-[var(--text)]">{contactLabel(conversation)}</span>
                    <span className="shrink-0 text-[11px] text-[var(--text-2)]">
                      {stampLabel(conversation.lastMessageAt, now)}
                    </span>
                  </span>
                  <span className="mt-0.5 flex items-center justify-between gap-2">
                    <span className="truncate text-[12px] text-[var(--text-2)]">
                      {conversation.lastMessageDirection === "out"
                        ? t("customers.list.you", { text: conversation.lastMessagePreview })
                        : conversation.lastMessagePreview}
                    </span>
                    {conversation.unreadCount > 0 ? (
                      <span
                        className="shrink-0 rounded-full bg-[var(--mode)] px-2 py-0.5 text-[11px] font-semibold text-[var(--on-mode)]"
                        data-testid="customers-unread"
                      >
                        {t("customers.list.unread", { count: conversation.unreadCount })}
                      </span>
                    ) : null}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ----------------------------------------------------------------------------------- Thread */

function Bubble({ message, now }: { message: CustomerMessage; now: number }) {
  const mine = message.direction === "out";
  const key = deliveryKey(message);
  return (
    <li
      className={`flex flex-col ${mine ? "items-end" : "items-start"}`}
      data-testid="customers-message"
      data-direction={message.direction}
      data-delivery={message.delivery ?? ""}
    >
      <div
        className={`max-w-[85%] rounded-xl border px-3 py-2 ${
          mine ? "border-transparent bg-[var(--mode)] text-[var(--on-mode)]" : "border-[var(--line)] bg-[var(--surface-2)] text-[var(--text)]"
        }`}
      >
        <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{message.text}</p>
      </div>
      <p className="mt-1 text-[11px] text-[var(--text-2)]">
        {mine ? t("customers.thread.fromYou") : t("customers.thread.fromCustomer")}
        {" · "}
        {stampLabel(message.at, now)}
        {key ? (
          <span data-testid="customers-delivery" data-failed={message.delivery === "failed" ? "true" : "false"}>
            {" · "}
            {t(key)}
          </span>
        ) : null}
      </p>
      {message.delivery === "failed" && message.deliveryError ? (
        <p className="mt-0.5 text-[11px] text-red-700 [overflow-wrap:anywhere]" data-testid="customers-delivery-error">
          {message.deliveryError}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Messages are kept with no time limit and go only when a customer asks, so erasing is a deliberate
 * two-step act. It sits at the foot of the thread, away from the buttons the owner presses all day, and
 * the host refuses anyone but the desk's owner (the refusal shows in the thread's error line).
 */
function EraseControl({ name, busy, onErase }: { name: string; busy: boolean; onErase: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="mt-4 border-t border-[var(--line)] pt-3" data-testid="customers-erase">
      {confirming ? (
        <div role="alertdialog" aria-label={t("customers.thread.erase.button")} data-testid="customers-erase-confirm">
          <p className="text-sm text-[var(--text)] [overflow-wrap:anywhere]">
            {t("customers.thread.erase.confirm", { name })}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn"
              disabled={busy}
              data-testid="customers-erase-yes"
              onClick={() => {
                setConfirming(false);
                onErase();
              }}
            >
              {t("customers.thread.erase.yes")}
            </button>
            <button type="button" className="btn" data-testid="customers-erase-no" onClick={() => setConfirming(false)}>
              {t("customers.thread.erase.no")}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn"
            disabled={busy}
            data-testid="customers-erase-button"
            onClick={() => setConfirming(true)}
          >
            {t("customers.thread.erase.button")}
          </button>
          <span className="text-[12px] text-[var(--text-2)]">{t("customers.thread.erase.note")}</span>
        </div>
      )}
    </div>
  );
}

export function ThreadPane({
  conversation,
  messages,
  now,
  draft,
  busy,
  error = null,
  canSend,
  onDraft,
  onSend,
  onState,
  onErase,
}: {
  conversation: CustomerConversation | null;
  messages: CustomerMessage[];
  now: number;
  draft: string;
  busy: boolean;
  /** Why the last reply or state change failed, shown above the composer. */
  error?: string | null;
  /** False when no number is connected: the owner can read but not reply. */
  canSend: boolean;
  onDraft: (text: string) => void;
  onSend: () => void;
  onState: (state: Exclude<ConversationState, "auto">) => void;
  /** Erase this customer and every message. Asked for only after the owner confirms. */
  onErase: () => void;
}) {
  const logRef = useRef<HTMLUListElement | null>(null);
  const latest = messages.length;

  // Keep the newest message in view as the thread grows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the conversation id re-scrolls when the owner opens another thread of the same length; the body reads no id
  useEffect(() => {
    const node = logRef.current;
    if (node && latest > 0) {
      node.scrollTop = node.scrollHeight;
    }
  }, [latest, conversation?.id]);

  if (!conversation) {
    return (
      <section className={PANEL} data-testid="customers-thread">
        <p className="text-sm text-[var(--text-2)]" data-testid="customers-none-selected">
          {t("customers.thread.none")}
        </p>
      </section>
    );
  }

  const replyWindow = windowState(conversation.window, now);
  const closed = conversation.state === "closed";
  const canReply = canSend && replyWindow.kind === "open";

  return (
    <section className={PANEL} data-testid="customers-thread" data-state={conversation.state}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-[var(--text)]" data-testid="customers-selected">
            {contactLabel(conversation)}
          </p>
          <p className="truncate text-[12px] text-[var(--text-2)]">
            {formatPhone(conversation.contactId)} · {t(`customers.thread.states.${conversation.state}`)}
          </p>
        </div>
        <button
          type="button"
          className="btn ml-auto"
          disabled={busy}
          data-testid="customers-toggle-done"
          onClick={() => onState(closed ? "with_you" : "closed")}
        >
          {closed ? t("customers.thread.reopen") : t("customers.thread.done")}
        </button>
      </div>

      {messages.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--text-2)]" data-testid="customers-thread-empty">
          {t("customers.thread.empty")}
        </p>
      ) : (
        <ul
          ref={logRef}
          className="mt-4 flex max-h-[460px] flex-col gap-3 overflow-y-auto pr-1"
          role="log"
          aria-live="polite"
          data-testid="customers-messages"
        >
          {messages.map((message) => (
            <Bubble key={message.id} message={message} now={now} />
          ))}
        </ul>
      )}

      <p className="mt-4 text-[12px] text-[var(--text-2)]" data-testid="customers-window-note" data-window={replyWindow.kind}>
        {replyWindow.kind === "open"
          ? replyWindow.hours > 0
            ? t("customers.window.open", { hours: replyWindow.hours, minutes: replyWindow.minutes })
            : t("customers.window.openMinutes", { minutes: replyWindow.minutes })
          : t(`customers.window.${replyWindow.kind}`)}
      </p>

      {error ? (
        <p className="mt-2 text-sm text-red-700" role="alert" data-testid="customers-error">
          {error}
        </p>
      ) : null}

      <form
        className="mt-2"
        data-testid="customers-composer"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (canReply && draft.trim()) {
            onSend();
          }
        }}
      >
        <textarea
          className="input min-h-[80px] w-full"
          maxLength={INBOX_CAPS.maxTextChars}
          placeholder={t("customers.composer.placeholder")}
          aria-label={t("customers.composer.aria")}
          value={draft}
          disabled={!canReply}
          data-testid="customers-composer-text"
          onChange={(event) => onDraft(event.target.value)}
        />
        <div className="mt-2 flex items-center gap-2">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !canReply || !draft.trim()}
            data-testid="customers-send"
          >
            {t("customers.composer.send")}
          </button>
          {canSend ? null : (
            <span className="text-[12px] text-[var(--text-2)]" data-testid="customers-needs-number">
              {t("customers.errors.notConnected")}
            </span>
          )}
        </div>
      </form>

      {/* Keyed by the conversation, so a half-answered "are you sure" never carries to another customer. */}
      <EraseControl key={conversation.id} name={contactLabel(conversation)} busy={busy} onErase={onErase} />
    </section>
  );
}
