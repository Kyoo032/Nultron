"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { t } from "@/lib/i18n";

/**
 * F5a — the desk's API keys, under Settings → Advanced.
 *
 * The card does the whole lifecycle the session routes allow: list (prefix + last four,
 * last used), create (name, agent scope, optional expiry and rate limit), revoke, rotate.
 * The raw key is shown exactly once — in the banner under the create/rotate it just came
 * back from — with a copy button and a warning that it will never be shown again
 * (AC-5a.1); after that the row only ever renders the hash-derived display fields.
 */

type ApiKeySummary = {
  id: string;
  name: string;
  prefix: string;
  last4: string;
  allowedAgents: string[];
  rateLimitRpm: number | null;
  status: "active" | "revoked";
  expiresAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
};

function fmt(ts: number | null): string {
  return ts ? new Date(ts).toLocaleString() : "—";
}

export function SettingsApiKeysCard() {
  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [agents, setAgents] = useState("*");
  const [expiresDays, setExpiresDays] = useState("");
  const [rpm, setRpm] = useState("");
  const [shownKey, setShownKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/v1/api-keys");
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { apiKeys?: ApiKeySummary[] };
      setKeys(body.apiKeys ?? []);
      setError(null);
    } catch {
      setError(t("settings.apiKeys.failed"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    try {
      const allowedAgents =
        agents.trim() === "*"
          ? ["*"]
          : agents
              .split(",")
              .map((a) => a.trim())
              .filter(Boolean);
      const res = await apiFetch("/api/v1/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          allowedAgents,
          rateLimitRpm: rpm ? Number(rpm) : null,
          expiresInDays: expiresDays ? Number(expiresDays) : null,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { key: string };
      setShownKey(body.key);
      setCopied(false);
      setName("");
      await load();
    } catch {
      setError(t("settings.apiKeys.createFailed"));
    } finally {
      setBusy(false);
    }
  };

  const act = async (id: string, action: "revoke" | "rotate") => {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/v1/api-keys/${id}/${action}`, { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      if (action === "rotate") {
        const body = (await res.json()) as { key: string };
        setShownKey(body.key);
        setCopied(false);
      }
      await load();
    } catch {
      setError(t("settings.apiKeys.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] px-5 py-4"
      data-testid="settings-api-keys"
    >
      <h2 className="font-medium text-[var(--text)]">{t("settings.apiKeys.heading")}</h2>
      <p className="mt-1 text-xs text-[var(--text-3)]">{t("settings.apiKeys.help")}</p>
      {error ? <p className="mt-2 text-sm text-[var(--danger)]">{error}</p> : null}
      {shownKey ? (
        <div
          className="mt-3 rounded-xl border border-[var(--accent)] bg-[var(--surface-2)] p-3"
          data-testid="api-key-shown-once"
        >
          <p className="text-sm text-[var(--text)]">{t("settings.apiKeys.shownOnce")}</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 break-all text-xs text-[var(--text)]">{shownKey}</code>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                void navigator.clipboard.writeText(shownKey).then(() => setCopied(true));
              }}
            >
              {copied ? t("settings.apiKeys.copied") : t("settings.apiKeys.copy")}
            </button>
          </div>
        </div>
      ) : null}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <input
          className="input"
          placeholder={t("settings.apiKeys.namePlaceholder")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="api-key-name"
        />
        <input
          className="input"
          placeholder={t("settings.apiKeys.agentsPlaceholder")}
          value={agents}
          onChange={(e) => setAgents(e.target.value)}
          data-testid="api-key-agents"
        />
        <input
          className="input"
          placeholder={t("settings.apiKeys.expiresPlaceholder")}
          value={expiresDays}
          onChange={(e) => setExpiresDays(e.target.value)}
          inputMode="numeric"
        />
        <input
          className="input"
          placeholder={t("settings.apiKeys.rpmPlaceholder")}
          value={rpm}
          onChange={(e) => setRpm(e.target.value)}
          inputMode="numeric"
        />
      </div>
      <button
        type="button"
        className="btn btn-primary mt-3"
        disabled={busy || !name.trim()}
        onClick={() => void create()}
        data-testid="api-key-create"
      >
        {t("settings.apiKeys.create")}
      </button>
      <ul className="mt-4 space-y-2" data-testid="api-key-list">
        {keys.map((k) => (
          <li
            key={k.id}
            className="flex items-center justify-between gap-3 rounded-xl border border-[var(--line)] px-3 py-2"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-[var(--text)]">
                {k.name}{" "}
                <span className="text-[var(--text-3)]">
                  {k.prefix}…{k.last4}
                </span>
              </p>
              <p className="text-xs text-[var(--text-3)]">
                {k.status === "revoked"
                  ? t("settings.apiKeys.revoked")
                  : `${t("settings.apiKeys.lastUsed")}: ${fmt(k.lastUsedAt)} · ${t("settings.apiKeys.expires")}: ${fmt(k.expiresAt)}`}
              </p>
            </div>
            {k.status === "active" ? (
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => void act(k.id, "rotate")}
                >
                  {t("settings.apiKeys.rotate")}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => void act(k.id, "revoke")}
                >
                  {t("settings.apiKeys.revoke")}
                </button>
              </div>
            ) : null}
          </li>
        ))}
        {keys.length === 0 ? <li className="text-sm text-[var(--text-3)]">{t("settings.apiKeys.empty")}</li> : null}
      </ul>
    </section>
  );
}
