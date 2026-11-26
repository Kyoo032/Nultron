"use client";

import { useEffect, useRef, useState } from "react";
import { DEFAULT_GATEWAY_IMAGE_MODEL, DEFAULT_GATEWAY_VIDEO_MODEL } from "@agentforge/core/media-kind";
import { isAppLocale, parseAppLocale, type AppLocale } from "@agentforge/core/locale";
import { UiSelect } from "@/components/ui-select";
import { apiFetch, checkGateway } from "@/lib/api-client";
import { useMayChangeCompanyKey } from "@/lib/company-key-access";
import { publishGate } from "@/lib/gate-state";
import {
  formatGateTimestamp,
  gatewayReasonKey,
  gatewayStatusKey,
  parseGatewayBlocked,
  parseGatewayGate,
  type GatewayGatePayload,
  type GatewayGateStatus,
} from "@/lib/gateway-gate";
import { applyLocale, getLocale, LOCALE_RESTART_EVENT, t } from "@/lib/i18n";
import { gatewayHostLabel, useProductBrand } from "@/lib/product-brand";
import { useWorkspaceScope } from "@/lib/workspace-scope";
import { AccountPlanPanel } from "./account-plan-panel";
import { AccountSessionRow } from "./account-session-row";
import { SettingsGuideCard } from "./settings-guide-card";
import { availabilityFrom, SettingsModelsCard, type ModelAvailabilityWire } from "./settings-models-card";
import { SettingsResetCard } from "./settings-reset-card";
// Phase 8: renders only where there is a ceiling to show (hosted); null on a desk.
import { SettingsStorageCard } from "./settings-storage-card";
import { UsagePanel, type AccountUsage } from "./usage-panel";

type Probe = {
  openaiCount?: number;
  anthropicCount?: number;
  googleCount?: number;
  volcengineCount?: number;
  totalCount?: number;
  chatCount?: number;
  imageCount?: number;
  videoCount?: number;
  detectedDialect?: string;
};

const fieldClass =
  "mt-1.5 w-full rounded-xl border border-[var(--line)] bg-[var(--surface-2)]/50 px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--text-3)] focus:border-[var(--accent)] focus:bg-[var(--surface)] focus:outline-none";

export function runtimeStatusLabel(mode: "ai" | "stub", mayChangeKey: boolean): string {
  if (mode === "ai") {
    return t("settings.runtimeLive");
  }
  // "Paste one below" points at a field a member of a hosted company is not given.
  return mayChangeKey ? t("settings.runtimeStub") : t("settings.runtimeStubRestricted");
}

/** What `/api/v1/settings` (and `apply-locale`) answer with. Every field is optional on the wire. */
export type SettingsPayload = {
  hasOpenai?: boolean;
  hasGoogle?: boolean;
  hasAnthropic?: boolean;
  hasVolcengine?: boolean;
  openaiKeyFingerprint?: string | null;
  runtime?: string;
  gateway?: unknown;
  googleBaseUrl?: string;
  anthropicBaseUrl?: string;
  volcengineBaseUrl?: string;
  probe?: Probe;
  /** The models this key cannot use and what each kind still offers (`settings-models-card.tsx`). */
  modelAvailability?: unknown;
  toolBackends?: Record<string, string>;
  imageGenModel?: string;
  videoGenModel?: string;
  documentGenModel?: string;
  researchGenModel?: string;
  presentationGenModel?: string;
  editTurnCapUsd?: number;
  disabledTools?: string[];
  defaults?: {
    image?: string;
    video?: string;
    documents?: string;
    research?: string;
    presentations?: string;
  };
  usage?: AccountUsage;
  locale?: string;
  savedLocale?: string;
  resetPending?: boolean;
};

/** One settings request's outcome: the payload, a closed gateway gate, or the sentence to show. */
export type SettingsAnswer =
  | { kind: "ok"; payload: SettingsPayload }
  | { kind: "blocked"; status: GatewayGateStatus }
  | { kind: "failed"; message: string };

type SettingsFailureKey = "settings.loadFailed" | "settings.saveFailed" | "settings.localeFailed";

function hostErrorMessage(body: unknown): string | null {
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  const message = error && typeof error === "object" ? (error as { message?: unknown }).message : undefined;
  return typeof message === "string" && message.trim() ? message.trim() : null;
}

/**
 * The body of a Settings save. The key field is sent only when someone typed a key into it: a blank
 * field means "keep the key I have", never "forget it" (the host drops a blank too). A member never
 * types one, so their save leaves it out. Forgetting a key is the Start over card's `scope: "key"`.
 */
export function settingsSaveBody(input: { mayChangeKey: boolean; openaiApiKey: string; editTurnCapUsd: number }): {
  openaiApiKey?: string;
  editTurnCapUsd?: number;
} {
  const typed = input.mayChangeKey && input.openaiApiKey.trim().length > 0;
  return {
    ...(typed ? { openaiApiKey: input.openaiApiKey } : {}),
    // The cap is a shared company setting: only an owner or admin's body carries it, so a member's
    // save is not refused for a field it never asked to change (review round 3).
    ...(input.mayChangeKey ? { editTurnCapUsd: input.editTurnCapUsd } : {}),
  };
}

/**
 * Send one settings request and read its answer. Never throws: a request that did not come back, a
 * non-JSON error page and an error body all become `failed`, with the host's own message when it
 * sent one and the catalog's `fallbackKey` otherwise. Only a settings object is ever `ok`.
 */
export async function readSettingsAnswer(
  request: () => Promise<Response>,
  fallbackKey: SettingsFailureKey,
): Promise<SettingsAnswer> {
  let res: Response;
  try {
    res = await request();
  } catch {
    return { kind: "failed", message: t(fallbackKey) };
  }
  const body: unknown = await res.json().catch(() => null);
  const blocked = parseGatewayBlocked(body);
  if (blocked) {
    return { kind: "blocked", status: blocked.status };
  }
  if (!res.ok || !body || typeof body !== "object" || Array.isArray(body) || (body as { error?: unknown }).error) {
    return { kind: "failed", message: hostErrorMessage(body) ?? t(fallbackKey) };
  }
  return { kind: "ok", payload: body as SettingsPayload };
}

export function SettingsPage() {
  const { productName, gatewayName, gatewayBaseUrl } = useProductBrand();
  const { name: workspaceName } = useWorkspaceScope();
  // Hosted only: the key is the company's, and the host refuses a member's write (M4). On a desk there
  // is no session, so this is always true and nothing below changes.
  const mayChangeKey = useMayChangeCompanyKey();
  const [hasOpenai, setHasOpenai] = useState(false);
  const [hasGoogle, setHasGoogle] = useState(false);
  const [hasAnthropic, setHasAnthropic] = useState(false);
  const [hasVolcengine, setHasVolcengine] = useState(false);
  const [openaiKeyFingerprint, setOpenaiKeyFingerprint] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<"ai" | "stub">("stub");
  const [loaded, setLoaded] = useState(false);
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [, setGoogleApiKey] = useState("");
  const [, setAnthropicApiKey] = useState("");
  const [, setVolcengineApiKey] = useState("");
  const [gateway, setGateway] = useState<GatewayGatePayload | null>(null);
  const [gatewayBusy, setGatewayBusy] = useState(false);
  const [, setGoogleBaseUrl] = useState("");
  const [, setAnthropicBaseUrl] = useState("");
  const [, setVolcengineBaseUrl] = useState("");
  const [, setTavilyKey] = useState("");
  const [, setBraveKey] = useState("");
  const [, setFalKey] = useState("");
  const [, setToolBackends] = useState<Record<string, string>>({});
  const [, setDisabledTools] = useState<string[]>([]);
  const [, setImageGenModel] = useState(DEFAULT_GATEWAY_IMAGE_MODEL);
  const [, setVideoGenModel] = useState(DEFAULT_GATEWAY_VIDEO_MODEL);
  const [, setDocumentGenModel] = useState("");
  const [, setResearchGenModel] = useState("");
  const [, setPresentationGenModel] = useState("");
  const [editTurnCapUsd, setEditTurnCapUsd] = useState(2);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [modelAvailability, setModelAvailability] = useState<ModelAvailabilityWire | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  const [locale, setLocale] = useState<AppLocale>("en");
  const [savedLocale, setSavedLocale] = useState<AppLocale>("en");
  const [localeBusy, setLocaleBusy] = useState(false);
  const [localeSaving, setLocaleSaving] = useState(false);
  const [localeError, setLocaleError] = useState<string | null>(null);
  // The in-flight POST /settings. Restart waits for it so apply-locale reads the language just saved.
  const localeSaveRef = useRef<Promise<boolean> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // A queued wipe the host will apply on the next launch; the reset card offers to call it off.
  const [resetPending, setResetPending] = useState(false);

  // Only the host label ever reaches the UI: the endpoint itself is pinned and stays hidden.
  const gatewayEndpoint = gateway?.endpoint ?? gatewayBaseUrl;
  const gatewayCheckedAt = formatGateTimestamp(gateway?.checkedAt, getLocale(), true);
  const gatewayLastOkAt = formatGateTimestamp(gateway?.lastOkAt, getLocale());
  const gatewayReason = gatewayReasonKey(gateway?.status);

  function applyPayload(payload: SettingsPayload) {
    setHasOpenai(Boolean(payload.hasOpenai));
    setHasGoogle(Boolean(payload.hasGoogle));
    setHasAnthropic(Boolean(payload.hasAnthropic));
    setHasVolcengine(Boolean(payload.hasVolcengine));
    setOpenaiKeyFingerprint(
      typeof payload.openaiKeyFingerprint === "string" && payload.openaiKeyFingerprint.trim()
        ? payload.openaiKeyFingerprint.trim()
        : null,
    );
    setRuntime(payload.runtime === "ai" ? "ai" : "stub");
    const reportedGate = parseGatewayGate(payload.gateway);
    setGateway(reportedGate);
    publishGate(reportedGate);
    setGoogleBaseUrl(typeof payload.googleBaseUrl === "string" ? payload.googleBaseUrl : "");
    setAnthropicBaseUrl(typeof payload.anthropicBaseUrl === "string" ? payload.anthropicBaseUrl : "");
    setVolcengineBaseUrl(typeof payload.volcengineBaseUrl === "string" ? payload.volcengineBaseUrl : "");
    setToolBackends(payload.toolBackends ?? {});
    setDisabledTools(Array.isArray(payload.disabledTools) ? payload.disabledTools : []);
    setImageGenModel(
      typeof payload.imageGenModel === "string" && payload.imageGenModel.trim()
        ? payload.imageGenModel.trim()
        : payload.defaults?.image || DEFAULT_GATEWAY_IMAGE_MODEL,
    );
    setVideoGenModel(
      typeof payload.videoGenModel === "string" && payload.videoGenModel.trim()
        ? payload.videoGenModel.trim()
        : payload.defaults?.video || DEFAULT_GATEWAY_VIDEO_MODEL,
    );
    setDocumentGenModel(
      typeof payload.documentGenModel === "string" && payload.documentGenModel.trim()
        ? payload.documentGenModel.trim()
        : payload.defaults?.documents || "",
    );
    setResearchGenModel(
      typeof payload.researchGenModel === "string" && payload.researchGenModel.trim()
        ? payload.researchGenModel.trim()
        : payload.defaults?.research || "",
    );
    setPresentationGenModel(
      typeof payload.presentationGenModel === "string" && payload.presentationGenModel.trim()
        ? payload.presentationGenModel.trim()
        : payload.defaults?.presentations || "",
    );
    setEditTurnCapUsd(
      typeof payload.editTurnCapUsd === "number" && Number.isFinite(payload.editTurnCapUsd)
        ? Math.min(50, Math.max(0.5, payload.editTurnCapUsd))
        : 2,
    );
    if (payload.probe) {
      setProbe(payload.probe);
    }
    setModelAvailability(availabilityFrom(payload.modelAvailability));
    if (payload.usage) {
      setUsage(payload.usage);
    }
    setLocale(parseAppLocale(payload.locale));
    setSavedLocale(parseAppLocale(payload.savedLocale ?? payload.locale));
    setResetPending(payload.resetPending === true);
    setLoaded(true);
  }

  /** The sentence for an answer that did not land: a closed gate names its reason. */
  function answerError(answer: Exclude<SettingsAnswer, { kind: "ok" }>): string {
    return answer.kind === "blocked"
      ? t(gatewayReasonKey(answer.status) ?? "onboarding.gate.error", { gatewayName })
      : answer.message;
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: applyPayload is redeclared every render and only sets state; the settings load must run once on mount
  useEffect(() => {
    let cancelled = false;
    void readSettingsAnswer(() => apiFetch("/api/v1/settings"), "settings.loadFailed").then((answer) => {
      if (cancelled) {
        return;
      }
      if (answer.kind === "ok") {
        setLoadError(null);
        applyPayload(answer.payload);
        return;
      }
      setLoadError(answer.kind === "failed" ? answer.message : t("settings.loadFailed"));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const answer = await readSettingsAnswer(
        () =>
          apiFetch("/api/v1/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(settingsSaveBody({ mayChangeKey, openaiApiKey, editTurnCapUsd })),
          }),
        "settings.saveFailed",
      );
      if (answer.kind !== "ok") {
        setError(answerError(answer));
        return;
      }
      setOpenaiApiKey("");
      setGoogleApiKey("");
      setAnthropicApiKey("");
      setVolcengineApiKey("");
      setTavilyKey("");
      setBraveKey("");
      setFalKey("");
      applyPayload(answer.payload);
      setLoadError(null);
      setMessage(t("settings.saved"));
    } finally {
      setBusy(false);
    }
  }

  async function onLocaleChange(next: string): Promise<boolean> {
    if (!isAppLocale(next) || localeSaving) {
      return false;
    }
    const previous = savedLocale;
    setSavedLocale(next);
    setLocaleError(null);
    setLocaleSaving(true);
    const saving = (async (): Promise<boolean> => {
      try {
        const answer = await readSettingsAnswer(
          () =>
            apiFetch("/api/v1/settings", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ locale: next }),
            }),
          "settings.localeFailed",
        );
        if (answer.kind !== "ok") {
          setSavedLocale(previous);
          setLocaleError(answerError(answer));
          return false;
        }
        applyPayload(answer.payload);
        return true;
      } finally {
        setLocaleSaving(false);
      }
    })();
    localeSaveRef.current = saving;
    try {
      return await saving;
    } finally {
      if (localeSaveRef.current === saving) {
        localeSaveRef.current = null;
      }
    }
  }

  async function onRecheckGateway() {
    setError(null);
    setMessage(null);
    setGatewayBusy(true);
    try {
      const next = await checkGateway();
      if (next) {
        setGateway(next);
      } else {
        setError(t("settings.gateway.checkFailed"));
      }
    } catch {
      setError(t("settings.gateway.checkFailed"));
    } finally {
      setGatewayBusy(false);
    }
  }

  async function onRestart() {
    const pending = localeSaveRef.current;
    if (pending) {
      const saved = await pending;
      if (!saved) {
        return;
      }
    }
    setLocaleError(null);
    setLocaleBusy(true);
    try {
      const answer = await readSettingsAnswer(
        () => apiFetch("/api/v1/settings/apply-locale", { method: "POST" }),
        "settings.localeFailed",
      );
      if (answer.kind !== "ok") {
        setLocaleError(answerError(answer));
        return;
      }
      applyPayload(answer.payload);
      applyLocale(answer.payload.locale);
      window.dispatchEvent(new Event(LOCALE_RESTART_EVENT));
    } finally {
      setLocaleBusy(false);
    }
  }

  const introText = !mayChangeKey
    ? t("settings.introRestricted", { workspaceName, gatewayName })
    : hasOpenai
      ? t("settings.intro", {
          workspaceName,
          gatewayName,
          gatewayHost: gatewayHostLabel(gatewayEndpoint),
        })
      : t("settings.introNeedsKey", { gatewayName });

  const statusDetails = !loaded
    ? t("settings.statusReading")
    : [
        runtimeStatusLabel(runtime, mayChangeKey),
        hasOpenai ? t("settings.keyGateway") : null,
        hasAnthropic ? t("settings.keyAnthropic") : null,
        hasGoogle ? t("settings.keyGoogle") : null,
        hasVolcengine ? t("settings.keyVolcengine") : null,
        probe?.detectedDialect ? t("settings.detected", { dialect: probe.detectedDialect }) : null,
        !hasOpenai && !hasGoogle && !hasAnthropic && !hasVolcengine ? t("settings.noKeys") : null,
      ]
        .filter(Boolean)
        .join(" · ");

  return (
    <main className="mx-auto max-w-[var(--content-narrow)] space-y-6 px-6 py-7 text-[var(--text)]">
      <div className="space-y-1.5">
        <p className="text-sm text-[var(--text-2)]" data-testid="settings-intro">
          {introText}
        </p>
        <p className="text-xs text-[var(--text-3)]" data-testid="runtime-status">
          {t("settings.status", { details: statusDetails })}
        </p>
        {loadError ? (
          <p className="pt-1 text-sm text-[var(--danger)]" role="alert" data-testid="settings-load-error">
            {loadError}
          </p>
        ) : null}
      </div>

      {/* Primary: Gateway key & spend cap */}
      <form onSubmit={(event) => void onSubmit(event)} className="space-y-3" data-testid="settings-form">
        <section className="space-y-4 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text)]">
                {t("settings.gatewayHeading", { gatewayName })}
              </h2>
              {mayChangeKey ? <p className="mt-0.5 text-xs text-[var(--text-3)]">{t("settings.gatewayHelp")}</p> : null}
            </div>
            <div
              className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-[var(--text-3)]"
              data-testid="settings-gateway-status"
            >
              {gateway ? (
                <span className="rounded-pill border border-[var(--line)] bg-[var(--surface-2)] px-2.5 py-0.5 font-medium text-[var(--text-2)]">
                  {t(gatewayStatusKey(gateway.status))}
                </span>
              ) : null}
              {gatewayCheckedAt ? <span>{t("settings.gateway.lastChecked", { date: gatewayCheckedAt })}</span> : null}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-[var(--text)] disabled:opacity-50"
                onClick={() => void onRecheckGateway()}
                disabled={gatewayBusy}
                data-testid="settings-gateway-recheck"
              >
                {t("settings.gateway.recheck")}
              </button>
            </div>
          </div>

          {gateway?.grace && gatewayLastOkAt ? (
            <p className="text-xs text-[var(--text-2)]" data-testid="settings-gateway-grace">
              {t("settings.gateway.grace", { date: gatewayLastOkAt })}
            </p>
          ) : null}
          {gatewayReason ? (
            <p className="text-sm text-[var(--danger)]" data-testid="settings-gateway-reason">
              {t(gatewayReason, { gatewayName })}
            </p>
          ) : null}

          {mayChangeKey ? (
            <label className="block text-xs font-medium text-[var(--text-2)]">
              {t("settings.keyLabel")}
              <input
                className={fieldClass}
                type="password"
                autoComplete="off"
                placeholder={hasOpenai ? t("settings.keyPlaceholderSaved") : t("settings.keyPlaceholderEmpty")}
                value={openaiApiKey}
                onChange={(event) => setOpenaiApiKey(event.target.value)}
                data-testid="openai-key"
              />
            </label>
          ) : (
            <p className="text-sm text-[var(--text-2)]" data-testid="settings-key-restricted">
              {t("settings.keyRestricted")}
            </p>
          )}

          {hasOpenai && mayChangeKey ? (
            <label className="block text-xs font-medium text-[var(--text-2)]">
              {t("settings.editCapLabel")}
              <input
                className={fieldClass}
                type="number"
                min={0.5}
                max={50}
                step={0.5}
                value={editTurnCapUsd}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (!Number.isFinite(next)) {
                    return;
                  }
                  setEditTurnCapUsd(Math.min(50, Math.max(0.5, next)));
                }}
                data-testid="settings-edit-turn-cap"
              />
            </label>
          ) : null}
          {hasOpenai && !mayChangeKey ? (
            <p className="text-xs text-[var(--text-2)]" data-testid="settings-edit-turn-cap-readonly">
              {t("settings.editCapLabel")}: ${editTurnCapUsd}
            </p>
          ) : null}

          {hasOpenai && openaiKeyFingerprint ? (
            <p className="text-xs text-[var(--text-3)]" data-testid="key-fingerprint">
              {t("settings.fingerprint", { fingerprint: openaiKeyFingerprint })}
            </p>
          ) : null}
          {error ? (
            <p className="text-sm text-[var(--danger)]" role="alert" data-testid="settings-error">
              {error}
            </p>
          ) : null}
          {message ? <p className="text-sm text-[var(--text-2)]">{message}</p> : null}
          <UsagePanel usage={usage} />
          <div className="flex flex-wrap gap-3 pt-1">
            <button
              type="submit"
              className="btn btn-primary disabled:opacity-50"
              data-testid="save-settings"
              disabled={busy}
            >
              {t("settings.save")}
            </button>
          </div>
        </section>

        <p className="px-1 text-xs text-[var(--text-3)]" data-testid="privacy-note">
          {t("settings.privacy", { productName, gatewayName, gatewayHost: gatewayHostLabel(gatewayEndpoint) })}
        </p>
      </form>

      {/* Preferences: Language (UiSelect) & Guide */}
      <section className="space-y-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5">
        <div className="space-y-1.5">
          <span className="block text-xs font-medium text-[var(--text-2)]" id="settings-locale-label">
            {t("settings.languageLabel")}
          </span>
          <UiSelect
            variant="field"
            ariaLabel={t("settings.languageLabel")}
            ariaLabelledBy="settings-locale-label"
            testId="settings-locale"
            value={savedLocale}
            disabled={localeSaving}
            onChange={(next) => void onLocaleChange(next)}
            options={[
              { value: "en", label: t("common.english") },
              { value: "id", label: t("common.bahasa") },
            ]}
          />
          <p className="text-xs text-[var(--text-3)]">{t("settings.languageHelp")}</p>
        </div>
        {localeError ? (
          <p className="text-sm text-[var(--danger)]" role="alert" data-testid="settings-locale-error">
            {localeError}
          </p>
        ) : null}
        {savedLocale !== locale ? (
          <div className="space-y-2 pt-1" data-testid="settings-locale-restart">
            <p className="text-sm text-[var(--text-2)]">{t("common.restartHint")}</p>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="settings-locale-restart-button"
              onClick={() => void onRestart()}
              disabled={localeBusy || localeSaving}
            >
              {t("common.restartApp")}
            </button>
          </div>
        ) : null}
      </section>

      <SettingsGuideCard />

      {/* Account, Plan & collapsible Advanced (Models, Storage) + Reset */}
      <div className="space-y-4">
        <AccountSessionRow />
        <AccountPlanPanel />
        <details
          className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] px-5 py-3.5"
          data-testid="settings-advanced"
        >
          <summary className="cursor-pointer select-none text-sm font-medium text-[var(--text)]">
            {t("settings.advancedHeading")}
          </summary>
          <div className="mt-2 space-y-4">
            <SettingsModelsCard availability={modelAvailability} onRefreshed={setModelAvailability} hasKey={hasOpenai} />
            <SettingsStorageCard />
          </div>
        </details>
        <SettingsResetCard resetPending={resetPending} />
      </div>
    </main>
  );
}
