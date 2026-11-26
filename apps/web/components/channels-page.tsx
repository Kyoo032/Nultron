"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CHANNEL_CAPS, type ChannelMessage, type ChannelRecord } from "@agentforge/core/channels";
import {
  ChannelError,
  NOT_CONNECTED_CODE,
  addChannel,
  connectTelegramBot,
  disconnectTelegramBot,
  loadChannelMessages,
  loadChannels,
  pollTelegram,
  removeChannel,
  sendToChannel,
  type ChannelBotStatus,
} from "@/lib/channels-client";
import {
  addEmailAllowlistEntry,
  createEmailChannel,
  loadEmailAllowlist,
  loadEmailChannels,
  removeEmailAllowlistEntry,
  removeEmailChannel,
  type EmailAllowlistEntry,
  type EmailChannel,
} from "@/lib/email-channels-client";
import { fetchVirtualAgents, type VirtualAgentInfo } from "@/lib/virtual-agents";
import { t } from "@/lib/i18n";
import { useMayDeleteDesk } from "@/lib/desk-delete-access";
import { ModeHeader } from "@/components/mode-header";

const NO_BOT: ChannelBotStatus = {
  connected: false,
  username: null,
  name: null,
  connectedAt: null,
  fingerprint: null,
  pinnedOrigin: true,
};

function errorText(error: unknown, fallback: string): string {
  if (error instanceof ChannelError) {
    return error.code === NOT_CONNECTED_CODE ? t("channels.errors.notConnected") : error.message;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

function whenLabel(at: number): string {
  return new Date(at).toLocaleString();
}

function BotCard({
  bot,
  busy,
  onConnect,
  onDisconnect,
}: {
  bot: ChannelBotStatus;
  busy: boolean;
  onConnect: (token: string) => void;
  onDisconnect: () => void;
}) {
  const [token, setToken] = useState("");

  return (
    <section
      className="raise rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4"
      data-testid="channels-bot-card"
    >
      <p className="panel-label">{t("channels.bot.label")}</p>
      {bot.connected ? (
        <div className="mt-2">
          <p className="text-sm text-[var(--text)]" data-testid="channels-bot-status">
            {t("channels.bot.connected", { username: bot.username ?? "" })}
          </p>
          <p className="mt-1 text-[12px] text-[var(--text-2)]" data-testid="channels-bot-fingerprint">
            {bot.fingerprint ?? ""}
          </p>
          <button
            type="button"
            className="btn mt-3"
            disabled={busy}
            data-testid="channels-bot-disconnect"
            onClick={onDisconnect}
          >
            {t("channels.bot.disconnect")}
          </button>
        </div>
      ) : (
        <form
          className="mt-2"
          data-testid="channels-bot-form"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            const trimmed = token.trim();
            if (trimmed) {
              onConnect(trimmed);
              setToken("");
            }
          }}
        >
          <p className="text-sm text-[var(--text-2)]" data-testid="channels-bot-status">
            {t("channels.bot.intro")}
          </p>
          <input
            className="input mt-3 w-full"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("channels.bot.placeholder")}
            aria-label={t("channels.bot.label")}
            value={token}
            data-testid="channels-bot-token"
            onChange={(event) => setToken(event.target.value)}
          />
          <button type="submit" className="btn btn-primary mt-3" disabled={busy} data-testid="channels-bot-connect">
            {t("channels.bot.connect")}
          </button>
        </form>
      )}
      {bot.pinnedOrigin ? null : (
        <p className="mt-3 text-[12px] text-amber-700" data-testid="channels-sandbox-note">
          {t("channels.bot.sandbox")}
        </p>
      )}
    </section>
  );
}

function Conversation({ messages }: { messages: ChannelMessage[] }) {
  if (messages.length === 0) {
    return (
      <p className="text-sm text-[var(--text-2)]" data-testid="channels-conversation-empty">
        {t("channels.conversation.empty")}
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2" data-testid="channels-conversation">
      {messages.map((message) => (
        <li
          key={message.id}
          className="rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-2"
          data-testid="channels-message"
          data-direction={message.direction}
        >
          <p className="text-[12px] text-[var(--text-2)]">
            {message.direction === "out"
              ? t("channels.conversation.sentBy", { author: message.author })
              : t("channels.conversation.receivedFrom", { author: message.author })}
            {" · "}
            {whenLabel(message.at)}
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--text)] [overflow-wrap:anywhere]">{message.text}</p>
        </li>
      ))}
    </ul>
  );
}

/**
 * The email channel card (F5b): one address per agent, the sender allowlist below it. Inbound mail
 * reaches the desk through the provider's signed webhook — nothing to connect here.
 */
function EmailCard({
  agents,
  busy,
  onError,
  onChange,
}: {
  agents: VirtualAgentInfo[];
  busy: boolean;
  onError: (message: string) => void;
  onChange: () => void;
}) {
  const [channels, setChannels] = useState<EmailChannel[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [entries, setEntries] = useState<EmailAllowlistEntry[]>([]);
  const [address, setAddress] = useState("");
  const [agentId, setAgentId] = useState("");
  const [policy, setPolicy] = useState<"ignore" | "refuse">("ignore");
  const [pattern, setPattern] = useState("");
  // Mutations are administer-gated host-side; members see the same card with the controls off.
  const canAdminister = useMayDeleteDesk();

  const refresh = useCallback(async () => {
    try {
      const rows = await loadEmailChannels();
      setChannels(rows);
      setSelectedId((current) => (current && rows.some((row) => row.id === current) ? current : (rows[0]?.id ?? null)));
    } catch (caught) {
      onError(errorText(caught, t("channels.email.errors.load")));
    }
  }, [onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selectedId) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    void loadEmailAllowlist(selectedId)
      .then((rows) => {
        if (!cancelled) {
          setEntries(rows);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          onError(errorText(caught, t("channels.email.errors.load")));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, onError]);

  const selected = channels.find((row) => row.id === selectedId) ?? null;
  const hiredAgents = agents.filter((agent) => agent.agentId);

  return (
    <section
      className="raise rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4"
      data-testid="channels-email-card"
    >
      <p className="panel-label">{t("channels.email.label")}</p>
      <p className="mt-1 text-[12px] text-[var(--text-2)]">{t("channels.email.intro")}</p>

      <form
        className="mt-3 flex flex-col gap-2"
        data-testid="channels-email-add-form"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          const value = address.trim();
          if (!agentId) {
            return;
          }
          void (async () => {
            try {
              const created = await createEmailChannel({ address: value, agentId, unknownSenderPolicy: policy });
              setAddress("");
              setSelectedId(created.id);
              await refresh();
              onChange();
            } catch (caught) {
              onError(errorText(caught, t("channels.email.errors.add")));
            }
          })();
        }}
      >
        <input
          className="input w-full"
          type="email"
          placeholder={t("channels.email.addressPlaceholder")}
          aria-label={t("channels.email.addressAria")}
          value={address}
          data-testid="channels-email-address"
          disabled={!canAdminister}
          onChange={(event) => setAddress(event.target.value)}
        />
        <select
          className="input w-full"
          value={agentId}
          aria-label={t("channels.email.agentAria")}
          data-testid="channels-email-agent"
          disabled={!canAdminister}
          onChange={(event) => setAgentId(event.target.value)}
        >
          <option value="">{t("channels.email.agentPlaceholder")}</option>
          {hiredAgents.map((agent) => (
            <option key={agent.agentId} value={agent.agentId ?? ""}>
              {agent.id}
            </option>
          ))}
        </select>
        <select
          className="input w-full"
          value={policy}
          aria-label={t("channels.email.policyAria")}
          data-testid="channels-email-policy"
          disabled={!canAdminister}
          onChange={(event) => setPolicy(event.target.value === "refuse" ? "refuse" : "ignore")}
        >
          <option value="ignore">{t("channels.email.policyIgnore")}</option>
          <option value="refuse">{t("channels.email.policyRefuse")}</option>
        </select>
        <button
          type="submit"
          className="btn"
          disabled={busy || !agentId || !canAdminister}
          data-testid="channels-email-add"
        >
          {t("channels.email.add")}
        </button>
      </form>

      {channels.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--text-2)]" data-testid="channels-email-empty">
          {t("channels.email.empty")}
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-1" data-testid="channels-email-list">
          {channels.map((channel) => (
            <li key={channel.id} className="flex items-center gap-2">
              <button
                type="button"
                className="min-w-0 flex-1 rounded-lg px-2 py-1 text-left text-sm hover:bg-[var(--surface-2)]"
                data-testid="channels-email-item"
                aria-pressed={channel.id === selectedId}
                onClick={() => setSelectedId(channel.id)}
              >
                <span className="block truncate text-[var(--text)]">{channel.address}</span>
                <span className="block truncate text-[12px] text-[var(--text-2)]">
                  {t(`channels.email.policy.${channel.unknownSenderPolicy}`)}
                </span>
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                disabled={busy || !canAdminister}
                data-testid="channels-email-remove"
                aria-label={t("channels.email.remove")}
                onClick={() =>
                  void (async () => {
                    try {
                      await removeEmailChannel(channel.id);
                      if (channel.id === selectedId) {
                        setSelectedId(null);
                      }
                      await refresh();
                      onChange();
                    } catch (caught) {
                      onError(errorText(caught, t("channels.email.errors.remove")));
                    }
                  })()
                }
              >
                {t("channels.email.remove")}
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected ? (
        <div className="mt-4 border-t border-[var(--line)] pt-3" data-testid="channels-email-allowlist">
          <p className="panel-label">{t("channels.email.allowlistLabel")}</p>
          <form
            className="mt-2 flex gap-2"
            data-testid="channels-email-allowlist-form"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              const value = pattern.trim();
              if (!value) {
                return;
              }
              void (async () => {
                try {
                  await addEmailAllowlistEntry(selected.id, value);
                  setPattern("");
                  setEntries(await loadEmailAllowlist(selected.id));
                  await refresh();
                } catch (caught) {
                  onError(errorText(caught, t("channels.email.errors.allowlist")));
                }
              })();
            }}
          >
            <input
              className="input min-w-0 flex-1"
              placeholder={t("channels.email.allowlistPlaceholder")}
              aria-label={t("channels.email.allowlistAria")}
              value={pattern}
              data-testid="channels-email-pattern"
              disabled={!canAdminister}
              onChange={(event) => setPattern(event.target.value)}
            />
            <button
              type="submit"
              className="btn"
              disabled={busy || !canAdminister}
              data-testid="channels-email-allowlist-add"
            >
              {t("channels.email.allowlistAdd")}
            </button>
          </form>
          <p className="mt-2 text-[12px] text-[var(--text-2)]">{t("channels.email.allowlistHint")}</p>
          {entries.length === 0 ? (
            <p className="mt-2 text-sm text-[var(--text-2)]" data-testid="channels-email-allowlist-empty">
              {t("channels.email.allowlistEmpty")}
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1" data-testid="channels-email-allowlist-list">
              {entries.map((entry) => (
                <li key={entry.id} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{entry.pattern}</span>
                  <button
                    type="button"
                    className="btn btn-quiet"
                    disabled={busy || !canAdminister}
                    data-testid="channels-email-allowlist-remove"
                    aria-label={t("channels.email.allowlistRemove")}
                    onClick={() =>
                      void (async () => {
                        try {
                          await removeEmailAllowlistEntry(selected.id, entry.id);
                          setEntries(await loadEmailAllowlist(selected.id));
                          await refresh();
                        } catch (caught) {
                          onError(errorText(caught, t("channels.email.errors.allowlist")));
                        }
                      })()
                    }
                  >
                    {t("channels.email.allowlistRemove")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

export function ChannelsPage() {
  const [bot, setBot] = useState<ChannelBotStatus>(NO_BOT);
  const [agents, setAgents] = useState<VirtualAgentInfo[]>([]);
  const [channels, setChannels] = useState<ChannelRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [target, setTarget] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selected = channels.find((row) => row.id === selectedId) ?? null;

  const refresh = useCallback(async () => {
    try {
      const payload = await loadChannels();
      setBot(payload.bot ?? NO_BOT);
      setChannels(payload.channels ?? []);
      setAgents(await fetchVirtualAgents().catch(() => []));
      setSelectedId((current) => {
        const rows = payload.channels ?? [];
        if (current && rows.some((row) => row.id === current)) {
          return current;
        }
        return rows[0]?.id ?? null;
      });
    } catch (caught) {
      setError(errorText(caught, t("channels.errors.load")));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    void loadChannelMessages(selectedId)
      .then((rows) => {
        if (!cancelled) {
          setMessages(rows);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(errorText(caught, t("channels.errors.load")));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  /** Every mutating press goes through here: one busy flag, one error line, one refresh. */
  const run = useCallback(async (action: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (caught) {
      setError(errorText(caught, fallback));
    } finally {
      setBusy(false);
    }
  }, []);

  const reloadMessages = useCallback(async (channelId: string) => {
    setMessages(await loadChannelMessages(channelId));
  }, []);

  return (
    <main
      className="mx-auto w-full max-w-[var(--content-stage)] px-6 py-8 text-[var(--text)]"
      data-testid="channels-page"
    >
      <div className="mb-6">
        <ModeHeader
          icon="channels"
          title={t("channels.title")}
          outcomeTestId="channels-intro"
          outcome={t("channels.intro")}
        >
          {/* A standing warning, not a step: one click away, out of the reading path. */}
          <details
            className="mt-3 max-w-[var(--content-narrow)] rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2"
            data-testid="channels-privacy"
          >
            <summary className="cursor-pointer select-none text-xs font-medium text-[var(--text-2)]">
              {t("channels.privacyLabel")}
            </summary>
            <p className="mt-2 text-[12px] text-[var(--text-2)]">{t("channels.privacy")}</p>
          </details>
        </ModeHeader>
      </div>

      {error ? (
        <p className="mb-4 text-sm text-red-700" data-testid="channels-error">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="mb-4 text-sm text-[var(--text-2)]" data-testid="channels-notice">
          {notice}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <div className="flex flex-col gap-4">
          <BotCard
            bot={bot}
            busy={busy}
            onConnect={(token) =>
              void run(async () => {
                setBot(await connectTelegramBot(token));
                await refresh();
              }, t("channels.errors.connect"))
            }
            onDisconnect={() =>
              void run(async () => {
                setBot(await disconnectTelegramBot());
                await refresh();
              }, t("channels.errors.disconnect"))
            }
          />

          <EmailCard agents={agents} busy={busy} onError={setError} onChange={() => void refresh()} />

          <section className="raise rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4">
            <p className="panel-label">{t("channels.list.label")}</p>
            <form
              className="mt-2 flex gap-2"
              data-testid="channels-add-form"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                const value = target.trim();
                if (!value) {
                  return;
                }
                void run(async () => {
                  const created = await addChannel(value);
                  setTarget("");
                  setSelectedId(created.id);
                  await refresh();
                }, t("channels.errors.add"));
              }}
            >
              <input
                className="input min-w-0 flex-1"
                placeholder={t("channels.list.placeholder")}
                aria-label={t("channels.list.addAria")}
                value={target}
                data-testid="channels-add-target"
                onChange={(event) => setTarget(event.target.value)}
              />
              <button type="submit" className="btn" disabled={busy} data-testid="channels-add-submit">
                {t("channels.list.add")}
              </button>
            </form>
            <p className="mt-2 text-[12px] text-[var(--text-2)]">
              {t("channels.list.hint", { max: CHANNEL_CAPS.maxPerWorkspace })}
            </p>

            {channels.length === 0 ? (
              <p className="mt-3 text-sm text-[var(--text-2)]" data-testid="channels-empty">
                {t("channels.list.empty")}
              </p>
            ) : (
              <ul className="mt-3 flex flex-col gap-1" data-testid="channels-list">
                {channels.map((channel) => (
                  <li key={channel.id} className="flex items-center gap-2">
                    <button
                      type="button"
                      className="min-w-0 flex-1 rounded-lg px-2 py-1 text-left text-sm hover:bg-[var(--surface-2)]"
                      data-testid="channels-item"
                      data-on={channel.id === selectedId ? "true" : "false"}
                      aria-pressed={channel.id === selectedId}
                      onClick={() => setSelectedId(channel.id)}
                    >
                      <span className="block truncate text-[var(--text)]">{channel.title}</span>
                      <span className="block truncate text-[12px] text-[var(--text-2)]">{channel.chatTarget}</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-quiet"
                      disabled={busy}
                      data-testid="channels-remove"
                      aria-label={t("channels.list.remove")}
                      onClick={() =>
                        void run(async () => {
                          await removeChannel(channel.id);
                          if (channel.id === selectedId) {
                            setSelectedId(null);
                          }
                          await refresh();
                        }, t("channels.errors.remove"))
                      }
                    >
                      {t("channels.list.remove")}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <section className="raise rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4">
          {selected ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-[var(--text)]" data-testid="channels-selected">
                    {selected.title}
                  </p>
                  <p className="truncate text-[12px] text-[var(--text-2)]">
                    {t(`channels.chatType.${selected.chatType}`)} · {selected.chatTarget}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn ml-auto"
                  disabled={busy || !bot.connected}
                  data-testid="channels-poll"
                  onClick={() =>
                    void run(async () => {
                      const result = await pollTelegram();
                      await reloadMessages(selected.id);
                      await refresh();
                      setNotice(
                        result.unmatched > 0
                          ? t("channels.poll.someUnmatched", {
                              received: result.received,
                              unmatched: result.unmatched,
                            })
                          : t("channels.poll.done", { received: result.received }),
                      );
                    }, t("channels.errors.poll"))
                  }
                >
                  {t("channels.poll.check")}
                </button>
              </div>

              <div className="mt-4">
                <Conversation messages={messages} />
              </div>

              <form
                className="mt-4"
                data-testid="channels-composer"
                onSubmit={(event: FormEvent) => {
                  event.preventDefault();
                  const text = draft.trim();
                  if (!text) {
                    return;
                  }
                  void run(async () => {
                    await sendToChannel(selected.id, text);
                    setDraft("");
                    await reloadMessages(selected.id);
                    await refresh();
                  }, t("channels.errors.send"));
                }}
              >
                <textarea
                  className="input min-h-[80px] w-full"
                  maxLength={CHANNEL_CAPS.maxTextChars}
                  placeholder={t("channels.composer.placeholder")}
                  aria-label={t("channels.composer.aria")}
                  value={draft}
                  data-testid="channels-composer-text"
                  onChange={(event) => setDraft(event.target.value)}
                />
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={busy || !bot.connected}
                    data-testid="channels-send"
                  >
                    {t("channels.composer.send")}
                  </button>
                  {bot.connected ? null : (
                    <span className="text-[12px] text-[var(--text-2)]" data-testid="channels-needs-bot">
                      {t("channels.errors.notConnected")}
                    </span>
                  )}
                </div>
              </form>
            </>
          ) : (
            <p className="text-sm text-[var(--text-2)]" data-testid="channels-none-selected">
              {t("channels.conversation.none")}
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
