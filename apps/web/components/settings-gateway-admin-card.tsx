"use client";

import { useEffect, useState } from "react";
import { useMayChangeCompanyKey } from "@/lib/company-key-access";
import { formatGateTimestamp } from "@/lib/gateway-gate";
import { readGatewayAdmin, type GatewayAdminState } from "@/lib/gateway-admin-client";
import { runRemove, runSave, statusKey } from "@/lib/gateway-admin-flow";
import { getLocale, t } from "@/lib/i18n";
import { useHostCapabilities } from "@/lib/host-capabilities";

const fieldClass =
  "mt-1 w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]";
const dangerPanelClass = "space-y-2 rounded-md border border-[var(--danger)]/30 bg-[var(--danger)]/5 p-3";

export type GatewayAdminPanelProps = {
  state: GatewayAdminState | null;
  loadFailed: boolean;
  token: string;
  accountIdText: string;
  busy: boolean;
  confirming: boolean;
  message: string | null;
  error: string | null;
  onTokenChange: (value: string) => void;
  onAccountIdChange: (value: string) => void;
  onSave: () => void;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
};

function statusLine(state: GatewayAdminState | null): string | null {
  if (!state) {
    return null;
  }
  const checked = formatGateTimestamp(state.checkedAt, getLocale(), true);
  return [t(statusKey(state)), checked ? t("settings.gateway.lastChecked", { date: checked }) : null]
    .filter(Boolean)
    .join(" · ");
}

export function GatewayAdminPanel({
  state,
  loadFailed,
  token,
  accountIdText,
  busy,
  confirming,
  message,
  error,
  onTokenChange,
  onAccountIdChange,
  onSave,
  onAskRemove,
  onCancelRemove,
  onRemove,
}: GatewayAdminPanelProps) {
  const canSave = !busy && token.trim() !== "";
  const status = statusLine(state);
  return (
    <section
      className="mt-6 space-y-4 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4"
      data-testid="settings-gateway-admin"
    >
      <div>
        <h2 className="font-medium text-[var(--text)]">{t("settings.gatewayAdmin.heading")}</h2>
        <p className="mt-1 text-xs text-[var(--text-3)]">{t("settings.gatewayAdmin.help")}</p>
      </div>
      {status ? (
        <p className="text-xs text-[var(--text-3)]" data-testid="settings-gateway-admin-status">
          {status}
        </p>
      ) : null}
      {loadFailed ? (
        <p className="text-sm text-[var(--danger)]" role="alert" data-testid="settings-gateway-admin-load-error">
          {t("settings.gatewayAdmin.loadFailed")}
        </p>
      ) : null}
      <form
        className="space-y-3"
        data-testid="settings-gateway-admin-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave) {
            onSave();
          }
        }}
      >
        <label className="block text-sm text-[var(--text)]">
          {t("settings.gatewayAdmin.tokenLabel")}
          <input
            className={fieldClass}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={
              state?.configured
                ? t("settings.gatewayAdmin.tokenPlaceholderSaved")
                : t("settings.gatewayAdmin.tokenPlaceholderEmpty")
            }
            value={token}
            onChange={(event) => onTokenChange(event.target.value)}
            data-testid="settings-gateway-admin-token"
          />
        </label>
        <label className="block text-sm text-[var(--text)]">
          {t("settings.gatewayAdmin.accountIdLabel")}
          <input
            className={fieldClass}
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            placeholder={
              state?.accountIdSet
                ? t("settings.gatewayAdmin.accountIdPlaceholderSaved")
                : t("settings.gatewayAdmin.accountIdPlaceholderEmpty")
            }
            value={accountIdText}
            onChange={(event) => onAccountIdChange(event.target.value)}
            data-testid="settings-gateway-admin-account-id"
          />
        </label>
        {error ? (
          <p className="text-sm text-[var(--danger)]" role="alert" data-testid="settings-gateway-admin-error">
            {error}
          </p>
        ) : null}
        {message ? (
          <p className="text-sm text-[var(--text-2)]" data-testid="settings-gateway-admin-message">
            {message}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <button
            type="submit"
            className="btn btn-primary disabled:opacity-50"
            disabled={!canSave}
            data-testid="settings-gateway-admin-save"
          >
            {t("settings.gatewayAdmin.save")}
          </button>
          {confirming ? null : (
            <button
              type="button"
              className="btn disabled:opacity-50"
              disabled={busy || !state?.configured}
              onClick={onAskRemove}
              data-testid="settings-gateway-admin-remove"
            >
              {t("settings.gatewayAdmin.remove")}
            </button>
          )}
        </div>
        {confirming ? (
          <div className={dangerPanelClass} data-testid="settings-gateway-admin-confirm">
            <p className="text-sm text-[var(--text)]">{t("settings.gatewayAdmin.removeConfirm")}</p>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                className="rounded-pill bg-[var(--danger)] px-3 py-1.5 text-sm text-[var(--surface)] disabled:opacity-50"
                disabled={busy}
                onClick={onRemove}
                data-testid="settings-gateway-admin-remove-confirm"
              >
                {t("settings.gatewayAdmin.removeConfirmSubmit")}
              </button>
              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm text-[var(--text-2)] underline disabled:opacity-50"
                disabled={busy}
                onClick={onCancelRemove}
                data-testid="settings-gateway-admin-remove-cancel"
              >
                {t("settings.gatewayAdmin.cancel")}
              </button>
            </div>
          </div>
        ) : null}
      </form>
    </section>
  );
}

export function SettingsGatewayAdminCard() {
  const capabilities = useHostCapabilities();
  const mayChange = useMayChangeCompanyKey();
  const shown = capabilities.sessions && mayChange;
  const [state, setState] = useState<GatewayAdminState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [token, setToken] = useState("");
  const [accountIdText, setAccountIdText] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!shown) {
      return;
    }
    let live = true;
    void readGatewayAdmin().then((result) => {
      if (!live) {
        return;
      }
      setLoadFailed(!result.ok);
      if (result.ok) {
        setState(result.state);
      }
    });
    return () => {
      live = false;
    };
  }, [shown]);

  if (!shown) {
    return null;
  }

  async function onSave() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const outcome = await runSave({ token, accountIdText });
      if (outcome.ok) {
        setState(outcome.state);
        setToken("");
        setAccountIdText("");
        setMessage(outcome.message);
      } else {
        setError(outcome.error);
      }
    } finally {
      setBusy(false);
    }
  }

  async function onRemove() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const outcome = await runRemove();
      setConfirming(false);
      if (outcome.ok) {
        setState(outcome.state);
        setMessage(outcome.message);
      } else {
        setError(outcome.error);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <GatewayAdminPanel
      state={state}
      loadFailed={loadFailed}
      token={token}
      accountIdText={accountIdText}
      busy={busy}
      confirming={confirming}
      message={message}
      error={error}
      onTokenChange={setToken}
      onAccountIdChange={setAccountIdText}
      onSave={() => void onSave()}
      onAskRemove={() => setConfirming(true)}
      onCancelRemove={() => setConfirming(false)}
      onRemove={() => void onRemove()}
    />
  );
}
