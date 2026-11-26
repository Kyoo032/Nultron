"use client";

import { useCallback, useEffect, useState } from "react";
import {
  auditExportUrl,
  loadAuditEvents,
  verifyAuditIntegrity,
  type AuditEvent,
  type AuditFilter,
  type AuditVerification,
} from "@/lib/audit-client";
import { t } from "@/lib/i18n";
import { ModeHeader } from "@/components/mode-header";

const EVENT_OPTIONS = [
  "auth.sign_in",
  "auth.sign_out",
  "role.change",
  "delegation.change",
  "api_key.create",
  "api_key.revoke",
  "data_source.add",
  "data_source.change",
  "data_source.access",
  "tool.call",
  "approval.decision",
  "guardrail.decision",
  "limit.hit",
  "channel.trigger",
  "settings.change",
  "audit.read",
  "audit.export",
  "audit.purge",
] as const;

const OUTCOME_OPTIONS = ["ok", "denied", "failed"] as const;

function toEpochMs(value: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function formatAt(at: number): string {
  return new Date(at).toLocaleString();
}

/**
 * F2 — the Activity Log: one page of the desk's audit trail, metadata only. The filters mirror the
 * API's (time, actor, agent, event type, outcome); "Verify integrity" re-walks the hash chain, and
 * the exports carry their SHA-256 manifest in a header beside the file.
 */
export function ActivityLogPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [filters, setFilters] = useState<AuditFilter>({});
  const [verification, setVerification] = useState<AuditVerification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  const refresh = useCallback(() => {
    setCursor(null);
    setEvents([]);
    setVersion((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadAuditEvents(filters)
      .then((page) => {
        if (!cancelled) {
          setEvents(page.events);
          setCursor(page.nextCursor);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [filters, version]);

  const loadMore = useCallback(() => {
    if (cursor === null) {
      return;
    }
    setBusy(true);
    void loadAuditEvents(filters, cursor)
      .then((page) => {
        setEvents((rows) => [...rows, ...page.events]);
        setCursor(page.nextCursor);
        setError(null);
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setBusy(false));
  }, [cursor, filters]);

  const verify = useCallback(() => {
    setBusy(true);
    setVerification(null);
    void verifyAuditIntegrity()
      .then(setVerification)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setBusy(false));
  }, []);

  const setFilter = (patch: Partial<AuditFilter>) => setFilters((current) => ({ ...current, ...patch }));

  return (
    <main
      className="mx-auto w-full max-w-[var(--content-stage)] px-6 py-8 text-[var(--text)]"
      data-testid="activity-log-page"
      data-mode="activity"
    >
      <div className="mb-6">
        <ModeHeader
          icon="customers"
          title={t("settings.activity.title")}
          outcomeTestId="activity-log-intro"
          outcome={t("settings.activity.intro")}
        />
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3" data-testid="activity-filters">
        <label className="flex flex-col gap-1 text-xs text-[var(--text-3)]">
          {t("settings.activity.filters.from")}
          <input
            type="datetime-local"
            data-testid="activity-filter-from"
            className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)]"
            onChange={(event) => setFilter({ from: toEpochMs(event.target.value) })}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--text-3)]">
          {t("settings.activity.filters.to")}
          <input
            type="datetime-local"
            data-testid="activity-filter-to"
            className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)]"
            onChange={(event) => setFilter({ to: toEpochMs(event.target.value) })}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--text-3)]">
          {t("settings.activity.filters.actor")}
          <input
            type="text"
            data-testid="activity-filter-actor"
            className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)]"
            onChange={(event) => setFilter({ actor: event.target.value || undefined })}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--text-3)]">
          {t("settings.activity.filters.agent")}
          <input
            type="text"
            data-testid="activity-filter-agent"
            className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)]"
            onChange={(event) => setFilter({ agent: event.target.value || undefined })}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--text-3)]">
          {t("settings.activity.filters.event")}
          <select
            data-testid="activity-filter-event"
            className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)]"
            onChange={(event) => setFilter({ event: event.target.value || undefined })}
          >
            <option value="">{t("settings.activity.filters.all")}</option>
            {EVENT_OPTIONS.map((event) => (
              <option key={event} value={event}>
                {event}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--text-3)]">
          {t("settings.activity.filters.outcome")}
          <select
            data-testid="activity-filter-outcome"
            className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)]"
            onChange={(event) => setFilter({ outcome: event.target.value || undefined })}
          >
            <option value="">{t("settings.activity.filters.all")}</option>
            {OUTCOME_OPTIONS.map((outcome) => (
              <option key={outcome} value={outcome}>
                {t(`settings.activity.outcome.${outcome}`)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          data-testid="activity-apply"
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-contrast)]"
          onClick={refresh}
        >
          {t("settings.activity.apply")}
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="activity-verify"
          disabled={busy}
          className="rounded-md border border-[var(--line)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--surface-2)] disabled:opacity-50"
          onClick={verify}
        >
          {t("settings.activity.verify")}
        </button>
        <a
          data-testid="activity-export-csv"
          className="rounded-md border border-[var(--line)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--surface-2)]"
          href={auditExportUrl("csv", filters)}
          download
        >
          {t("settings.activity.exportCsv")}
        </a>
        <a
          data-testid="activity-export-jsonl"
          className="rounded-md border border-[var(--line)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--surface-2)]"
          href={auditExportUrl("jsonl", filters)}
          download
        >
          {t("settings.activity.exportJsonl")}
        </a>
        {verification ? (
          <span
            data-testid="activity-verify-result"
            className={verification.ok ? "text-sm text-green-700" : "text-sm text-red-700"}
          >
            {verification.ok
              ? t("settings.activity.verifyOk", { count: String(verification.checked) })
              : t("settings.activity.verifyBad", { seq: String(verification.firstBadSeq ?? "?") })}
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="mb-4 text-sm text-red-700" data-testid="activity-load-error">
          {error}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-[var(--line)]" data-testid="activity-table">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[var(--line)] bg-[var(--surface-2)] text-xs text-[var(--text-3)]">
            <tr>
              <th className="px-3 py-2">{t("settings.activity.columns.at")}</th>
              <th className="px-3 py-2">{t("settings.activity.columns.event")}</th>
              <th className="px-3 py-2">{t("settings.activity.columns.actor")}</th>
              <th className="px-3 py-2">{t("settings.activity.columns.agent")}</th>
              <th className="px-3 py-2">{t("settings.activity.columns.outcome")}</th>
              <th className="px-3 py-2">{t("settings.activity.columns.target")}</th>
              <th className="px-3 py-2">{t("settings.activity.columns.duration")}</th>
              <th className="px-3 py-2">{t("settings.activity.columns.items")}</th>
            </tr>
          </thead>
          <tbody>
            {events.map((row) => (
              <tr key={row.id} className="border-b border-[var(--line)] last:border-0">
                <td className="whitespace-nowrap px-3 py-2 text-xs">{formatAt(row.at)}</td>
                <td className="px-3 py-2 font-mono text-xs">{row.event}</td>
                <td className="px-3 py-2 text-xs">
                  {row.actor_kind}:{row.actor_id ?? "-"}
                </td>
                <td className="px-3 py-2 text-xs">{row.agent_id ?? "-"}</td>
                <td className="px-3 py-2 text-xs">{row.outcome ?? "-"}</td>
                <td className="px-3 py-2 text-xs">
                  {[row.target_kind, row.target_id].filter(Boolean).join(":") || "-"}
                </td>
                <td className="px-3 py-2 text-xs">{row.duration_ms ?? "-"}</td>
                <td className="px-3 py-2 text-xs">{row.item_count ?? "-"}</td>
              </tr>
            ))}
            {events.length === 0 && !error ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-sm text-[var(--text-3)]">
                  {t("settings.activity.empty")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {cursor !== null ? (
        <button
          type="button"
          data-testid="activity-more"
          disabled={busy}
          className="mt-4 rounded-md border border-[var(--line)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--surface-2)] disabled:opacity-50"
          onClick={loadMore}
        >
          {t("settings.activity.more")}
        </button>
      ) : null}
    </main>
  );
}
