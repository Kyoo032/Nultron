"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CustomersError,
  NOT_CONNECTED_CODE,
  WINDOW_CLOSED_CODE,
  connectWhatsApp,
  disconnectWhatsApp,
  loadConversation,
  loadConversations,
  loadSummary,
  loadWhatsApp,
  markConversationRead,
  replyToConversation,
  setConversationState,
  type ConversationDetail,
  type ConversationFilter,
  type ConversationState,
  type CustomerConversation,
  type InboxSummary,
  type WhatsAppConnection,
} from "@/lib/customers-client";
import { POLL_INTERVAL_MS, startOfLocalDay } from "@/lib/customers-format";
import { t } from "@/lib/i18n";
import { ConnectCard, ConversationList, ThreadPane, TodayStrip } from "@/components/customers-parts";
import { ModeHeader } from "@/components/mode-header";

const NO_NUMBER: WhatsAppConnection = {
  connected: false,
  webhookReady: true,
  phoneNumberId: null,
  displayPhone: null,
  verifiedName: null,
  connectedAt: null,
  fingerprint: null,
  pinnedOrigin: true,
};

const SEARCH_DEBOUNCE_MS = 250;

function errorText(error: unknown, fallbackKey: string): string {
  if (error instanceof CustomersError) {
    if (error.code === NOT_CONNECTED_CODE) {
      return t("customers.errors.notConnected");
    }
    if (error.code === WINDOW_CLOSED_CODE) {
      return t("customers.errors.windowClosed");
    }
    return error.message;
  }
  return error instanceof Error && error.message ? error.message : t(fallbackKey);
}

/**
 * Customers: the owner's inbox for the people who write to the desk's WhatsApp number.
 *
 * The page polls while it is open and visible (the host has nothing to push yet), and every action
 * ends in an immediate refresh so what the owner sees is what the host holds. Customer text is
 * rendered as plain text only; it is untrusted.
 */
export function CustomersPage() {
  const [connection, setConnection] = useState<WhatsAppConnection>(NO_NUMBER);
  const [summary, setSummary] = useState<InboxSummary | null>(null);
  const [conversations, setConversations] = useState<CustomerConversation[]>([]);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<ConversationFilter>("all");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [version, setVersion] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);

  const refreshNow = useCallback(() => setVersion((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    void loadWhatsApp()
      .then((next) => {
        if (!cancelled) {
          setConnection(next);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setLoadError(errorText(caught, "customers.errors.load"));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query]);

  // One loop: summary, list and open thread together, on a timer and whenever the view changes.
  // The effect re-runs when the filter, search, selection or `version` changes, so a stale answer
  // from the previous view is dropped by `cancelled`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the trigger that refetches right after an action; the body reads no version
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      try {
        const [nextSummary, nextList, nextDetail] = await Promise.all([
          loadSummary(startOfLocalDay(Date.now())),
          loadConversations(filter, debouncedQuery),
          selectedId
            ? loadConversation(selectedId).catch((caught: unknown) => {
                if (caught instanceof CustomersError && caught.code === "not_found") {
                  return null;
                }
                throw caught;
              })
            : Promise.resolve(null),
        ]);
        if (cancelled) {
          return;
        }
        setNow(Date.now());
        setSummary(nextSummary);
        setConversations(nextList);
        setDetail(nextDetail);
        if (selectedId && !nextDetail) {
          setSelectedId(null);
        }
        setLoadError(null);
      } catch (caught) {
        if (!cancelled) {
          setLoadError(errorText(caught, "customers.errors.load"));
        }
      }
    };
    void run();
    const timer = window.setInterval(() => void run(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [filter, debouncedQuery, selectedId, version]);

  // Opening a conversation reads it. Keyed on the count so a message that lands while it is open
  // is read too, and a failed mark-read does not loop (the key does not change).
  const openId = detail?.conversation.id ?? null;
  const openUnread = detail?.conversation.unreadCount ?? 0;
  useEffect(() => {
    if (openId && openUnread > 0) {
      void markConversationRead(openId)
        .then(refreshNow)
        .catch(() => undefined);
    }
  }, [openId, openUnread, refreshNow]);

  /**
   * Every press that changes something goes through here: one busy flag, one refresh, and the error
   * shown beside the control that failed (the number card or the thread), not at the top of a page
   * the owner may have scrolled.
   */
  const act = useCallback(
    async (where: "connect" | "thread", action: () => Promise<void>, fallbackKey: string) => {
      const show = where === "connect" ? setConnectError : setThreadError;
      setBusy(true);
      setConnectError(null);
      setThreadError(null);
      try {
        await action();
      } catch (caught) {
        show(errorText(caught, fallbackKey));
      } finally {
        setBusy(false);
        refreshNow();
      }
    },
    [refreshNow],
  );

  const select = useCallback((conversationId: string) => {
    setSelectedId(conversationId);
    setDraft("");
    setThreadError(null);
  }, []);

  return (
    <main
      className="mx-auto w-full max-w-[var(--content-stage)] px-6 py-8 text-[var(--text)]"
      data-testid="customers-page"
      data-mode="customers"
    >
      <div className="mb-6">
        <ModeHeader
          icon="customers"
          title={t("customers.title")}
          outcomeTestId="customers-intro"
          outcome={t("customers.intro")}
        />
      </div>

      {loadError ? (
        <p className="mb-4 text-sm text-red-700" data-testid="customers-load-error">
          {loadError}
        </p>
      ) : null}

      <div className="mb-4">
        <TodayStrip summary={summary} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        <div className="flex min-w-0 flex-col gap-4">
          <ConnectCard
            connection={connection}
            busy={busy}
            error={connectError}
            onConnect={(phoneNumberId, accessToken) =>
              void act(
                "connect",
                async () => {
                  setConnection(await connectWhatsApp(phoneNumberId, accessToken));
                },
                "customers.errors.connect",
              )
            }
            onDisconnect={() =>
              void act(
                "connect",
                async () => {
                  setConnection(await disconnectWhatsApp());
                },
                "customers.errors.disconnect",
              )
            }
          />
          <ConversationList
            conversations={conversations}
            selectedId={selectedId}
            filter={filter}
            query={query}
            now={now}
            onFilter={setFilter}
            onQuery={setQuery}
            onSelect={select}
          />
        </div>

        <div className="min-w-0">
          <ThreadPane
            conversation={detail?.conversation ?? null}
            messages={detail?.messages ?? []}
            now={now}
            draft={draft}
            busy={busy}
            error={threadError}
            canSend={connection.connected}
            onDraft={setDraft}
            onSend={() => {
              const target = detail?.conversation;
              const text = draft.trim();
              // The thread on screen may still be the previous one while the newly picked one loads.
              if (!target || target.id !== selectedId || !text) {
                return;
              }
              void act(
                "thread",
                async () => {
                  await replyToConversation(target.id, text);
                  setDraft("");
                },
                "customers.errors.send",
              );
            }}
            onState={(state: Exclude<ConversationState, "auto">) => {
              const target = detail?.conversation;
              if (!target || target.id !== selectedId) {
                return;
              }
              void act("thread", () => setConversationState(target.id, state), "customers.errors.state");
            }}
          />
        </div>
      </div>
    </main>
  );
}
