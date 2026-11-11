"use client";

import { useState } from "react";
import type { ModelStatus } from "@agentforge/core/model-availability";
import type { ModelKind } from "@agentforge/core/gateway-catalog";
import { apiFetch } from "@/lib/api-client";
import { t } from "@/lib/i18n";

/**
 * Which models this key can use, and why the others are missing.
 *
 * The pickers already show only what works; this card is where a person finds out why a model they
 * know of is not there. The host decides (`packages/host/src/model-availability.ts`): it learns from
 * real requests, and the renderer only displays what it was told. The list of models the key cannot
 * use is collapsed, because most days nobody needs it.
 */

export type ModelAvailabilityWire = {
  unavailable: Array<{
    id: string;
    kind: ModelKind;
    status: ModelStatus;
    reason: string;
    checkedAt: string | null;
  }>;
  kinds: Record<string, { offered: number }>;
};

/** The kinds the card counts, in the order a person thinks of them. */
const COUNTED_KINDS = ["chat", "image", "video", "speech", "music", "transcription"] as const;

/** Narrow an answer's `modelAvailability` (or `availability`) field. Anything unreadable is "nothing to show". */
export function availabilityFrom(value: unknown): ModelAvailabilityWire | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as { unavailable?: unknown; kinds?: unknown };
  const unavailable = Array.isArray(record.unavailable)
    ? record.unavailable.flatMap((row) => {
        const item = row as Partial<ModelAvailabilityWire["unavailable"][number]> | null;
        if (!item || typeof item.id !== "string" || typeof item.kind !== "string" || typeof item.status !== "string") {
          return [];
        }
        return [
          {
            id: item.id,
            kind: item.kind,
            status: item.status,
            reason: typeof item.reason === "string" ? item.reason : "",
            checkedAt: typeof item.checkedAt === "string" ? item.checkedAt : null,
          },
        ];
      })
    : [];
  const kinds: ModelAvailabilityWire["kinds"] = {};
  if (record.kinds && typeof record.kinds === "object") {
    for (const [kind, summary] of Object.entries(record.kinds as Record<string, unknown>)) {
      const offered = (summary as { offered?: unknown } | null)?.offered;
      if (typeof offered === "number" && Number.isFinite(offered)) {
        kinds[kind] = { offered };
      }
    }
  }
  return { unavailable, kinds };
}

/** The plain sentence for why one model is not offered. A model the key never listed says so; a learned refusal says what was learned. */
export function reasonKey(row: { status: ModelStatus; reason: string }): string {
  if (row.status === "not_on_key") {
    return row.reason === "not_listed" ? "settings.models.reason.not_listed" : "settings.models.reason.not_on_key";
  }
  if (row.status === "no_channel") {
    return "settings.models.reason.no_channel";
  }
  if (row.status === "account_blocked") {
    return "settings.models.reason.account_blocked";
  }
  if (row.status === "upstream_rejected") {
    return "settings.models.reason.upstream_rejected";
  }
  return "settings.models.reason.not_on_key";
}

const kindLabelKey = (kind: string) => `settings.models.kind.${kind}`;

export function SettingsModelsCard(props: {
  availability: ModelAvailabilityWire | null;
  /** Called with the fresh answer after "Check again". */
  onRefreshed: (next: ModelAvailabilityWire | null) => void;
  hasKey: boolean;
}) {
  const { availability, onRefreshed, hasKey } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!hasKey || !availability) {
    return null;
  }

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch("/api/v1/models", { method: "POST" });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setError(t("settings.models.refreshFailed"));
        return;
      }
      onRefreshed(availabilityFrom((body as { availability?: unknown } | null)?.availability));
    } catch {
      setError(t("settings.models.refreshFailed"));
    } finally {
      setBusy(false);
    }
  }

  const grouped = new Map<string, ModelAvailabilityWire["unavailable"]>();
  for (const row of availability.unavailable) {
    grouped.set(row.kind, [...(grouped.get(row.kind) ?? []), row]);
  }

  return (
    <section
      className="mt-6 space-y-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4"
      data-testid="settings-models"
    >
      <h2 className="text-base font-medium text-[var(--text)]">{t("settings.models.heading")}</h2>
      <p className="text-xs text-[var(--text-3)]">{t("settings.models.help")}</p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--text-2)]" data-testid="settings-models-counts">
        {COUNTED_KINDS.map((kind) => {
          const offered = availability.kinds[kind]?.offered;
          if (offered === undefined) {
            return null;
          }
          return (
            <li key={kind} data-testid={`settings-models-count-${kind}`}>
              {t(kindLabelKey(kind))}:{" "}
              {offered > 0 ? t("settings.models.offered", { count: offered }) : t("settings.models.none")}
            </li>
          );
        })}
      </ul>

      <details className="text-sm text-[var(--text-2)]" data-testid="settings-models-unavailable">
        <summary className="cursor-pointer text-[var(--text)]">
          {t("settings.models.unavailableSummary", { count: availability.unavailable.length })}
        </summary>
        {availability.unavailable.length === 0 ? (
          <p className="mt-2 text-xs text-[var(--text-3)]">{t("settings.models.unavailableEmpty")}</p>
        ) : (
          <div className="mt-2 space-y-3">
            {[...grouped.entries()].map(([kind, rows]) => (
              <div key={kind}>
                <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--text-3)]">
                  {t(kindLabelKey(kind))}
                </h3>
                <ul className="mt-1 space-y-1">
                  {rows.map((row) => (
                    <li key={row.id} data-testid={`settings-models-row-${row.id}`}>
                      <span className="font-mono text-xs text-[var(--text)]">{row.id}</span>
                      <span className="text-xs text-[var(--text-3)]"> — {t(reasonKey(row))}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </details>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          className="rounded-md border border-[var(--line)] px-3 py-1.5 text-sm text-[var(--text)] disabled:opacity-50"
          data-testid="settings-models-refresh"
        >
          {busy ? t("settings.models.refreshing") : t("settings.models.refresh")}
        </button>
        {error ? (
          <p className="text-sm text-[var(--danger)]" role="alert" data-testid="settings-models-error">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
