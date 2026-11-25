"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { DEFAULT_MCP_POLICY, type McpAccessMode, type McpConnectorId } from "@agentforge/core/mcp";
import { ModeHeader } from "@/components/mode-header";
import { t } from "@/lib/i18n";
import {
  McpError,
  disconnectMcpConnector,
  loadMcpConnectors,
  saveMcpConnector,
  testMcpConnector,
  type McpBoundaryRulesView,
  type McpConnectorMutationPayload,
  type McpConnectorTestPayload,
  type McpConnectorView,
} from "@/lib/mcp-client";

export type McpConnectorDraft = {
  readonly endpointUrl: string;
  readonly token: string;
  readonly accessMode: McpAccessMode;
  readonly allowSubagents: boolean;
  /** Text while editing. It becomes the policy's integer at the save boundary. */
  readonly maxCallsPerTurn: string;
};

export type McpConnectorDrafts = Record<McpConnectorId, McpConnectorDraft>;

export type McpPageLoadState =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | {
      readonly status: "ready";
      readonly connectors: readonly McpConnectorView[];
      readonly boundaries: McpBoundaryRulesView;
    };

export type McpActionKind = "save" | "test" | "disconnect";
export type McpActionState = { readonly connectorId: McpConnectorId; readonly kind: McpActionKind } | null;
export type McpFeedback = {
  readonly connectorId: McpConnectorId;
  readonly kind: "error" | "notice";
  readonly text: string;
} | null;

const ACTION_ERROR_KEYS: Record<McpActionKind, string> = {
  save: "mcp.errors.save",
  test: "mcp.errors.test",
  disconnect: "mcp.errors.disconnect",
};

const BOUNDARY_ITEMS = [
  {
    testId: "mcp-boundary-read-only",
    titleKey: "mcp.boundaries.readOnlyTitle",
    bodyKey: "mcp.boundaries.readOnlyBody",
  },
  {
    testId: "mcp-boundary-sandbox",
    titleKey: "mcp.boundaries.sandboxTitle",
    bodyKey: "mcp.boundaries.sandboxBody",
  },
  {
    testId: "mcp-boundary-subagents",
    titleKey: "mcp.boundaries.subagentsTitle",
    bodyKey: "mcp.boundaries.subagentsBody",
  },
  {
    testId: "mcp-boundary-scan",
    titleKey: "mcp.boundaries.scanTitle",
    bodyKey: "mcp.boundaries.scanBody",
  },
] as const;

const ACCESS_OPTIONS: readonly {
  value: McpAccessMode;
  slug: string;
  titleKey: string;
  helpKey: string;
}[] = [
  {
    value: "read_only",
    slug: "read-only",
    titleKey: "mcp.connector.readOnly",
    helpKey: "mcp.connector.readOnlyHelp",
  },
  {
    value: "disabled",
    slug: "disabled",
    titleKey: "mcp.connector.disabled",
    helpKey: "mcp.connector.disabledHelp",
  },
];

function defaultDraft(): McpConnectorDraft {
  return {
    endpointUrl: "",
    token: "",
    accessMode: DEFAULT_MCP_POLICY.accessMode,
    allowSubagents: DEFAULT_MCP_POLICY.allowSubagents,
    maxCallsPerTurn: String(DEFAULT_MCP_POLICY.maxCallsPerTurn),
  };
}

export function draftFromConnector(connector: McpConnectorView): McpConnectorDraft {
  return {
    endpointUrl: connector.endpointUrl ?? "",
    token: "",
    accessMode: connector.policy.accessMode,
    allowSubagents: connector.policy.allowSubagents,
    maxCallsPerTurn: String(connector.policy.maxCallsPerTurn),
  };
}

export function draftsFromConnectors(connectors: readonly McpConnectorView[]): McpConnectorDrafts {
  const drafts: McpConnectorDrafts = {
    gmail: defaultDraft(),
    google_drive: defaultDraft(),
    onedrive: defaultDraft(),
    notion: defaultDraft(),
  };
  for (const connector of connectors) {
    drafts[connector.id] = draftFromConnector(connector);
  }
  return drafts;
}

/** The integer the number input represents, or null while the draft cannot be saved. */
export function mcpMaxCallsValue(value: string): number | null {
  if (!value.trim()) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 10 ? parsed : null;
}

function errorText(error: unknown, fallbackKey: string): string {
  return error instanceof McpError && error.message ? error.message : t(fallbackKey);
}

function BoundaryCard({ boundaries }: { boundaries: McpBoundaryRulesView }) {
  return (
    <section
      className="raise rounded-2xl border border-[var(--accent)]/35 bg-[var(--surface)] p-5 shadow-sm"
      data-testid="mcp-boundaries"
    >
      <div className="max-w-[var(--content-narrow)]">
        <h2 className="font-heading text-base font-semibold tracking-[var(--track)] text-[var(--text)]">
          {t("mcp.boundaries.title")}
        </h2>
        <p className="mt-1 text-sm text-[var(--text-2)]">{t("mcp.boundaries.intro")}</p>
      </div>
      <ul className="mt-4 grid gap-3 md:grid-cols-2">
        {BOUNDARY_ITEMS.map((item) => (
          <li
            key={item.testId}
            className="rounded-xl border border-[var(--line)] bg-[var(--surface-2)]/55 p-3"
            data-testid={item.testId}
          >
            <p className="text-sm font-semibold text-[var(--text)]">{t(item.titleKey)}</p>
            <p className="mt-1 text-[13px] leading-5 text-[var(--text-2)]">{t(item.bodyKey)}</p>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-[12px] font-medium text-[var(--text-2)]" data-testid="mcp-boundary-limits">
        {t("mcp.boundaries.limits", {
          maxCalls: boundaries.maxCallsPerTurn,
          subagentMaxCalls: boundaries.subagentMaxCallsPerTurn,
        })}
      </p>
    </section>
  );
}

function ConnectorHeader({ connector }: { connector: McpConnectorView }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="font-heading text-base font-semibold tracking-[var(--track)] text-[var(--text)]">
          {connector.label}
        </h3>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-[var(--text-2)]">
          {connector.endpointHost ? <span>{t("mcp.connector.endpointHost", { host: connector.endpointHost })}</span> : null}
          {connector.connectedAt ? (
            <span>{t("mcp.connector.connectedAt", { date: new Date(connector.connectedAt).toLocaleString() })}</span>
          ) : null}
        </div>
      </div>
      <span
        className={
          connector.connected
            ? "rounded-full border border-emerald-600/30 bg-emerald-500/10 px-2.5 py-1 text-[12px] font-medium text-emerald-700"
            : "rounded-full border border-[var(--line)] bg-[var(--surface-2)] px-2.5 py-1 text-[12px] font-medium text-[var(--text-2)]"
        }
        data-testid={`mcp-status-${connector.id}`}
      >
        {connector.connected ? t("mcp.connector.statusConnected") : t("mcp.connector.statusDisconnected")}
      </span>
    </div>
  );
}

function ConnectorActions({ connector }: { connector: McpConnectorView }) {
  const actions =
    connector.discoveredTools.length > 0
      ? { kind: "discovered" as const, items: connector.discoveredTools }
      : { kind: "allowlisted" as const, items: connector.allowedActions };

  return (
    <div className="mt-4" data-testid={`mcp-actions-${connector.id}`} data-source={actions.kind}>
      <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--text-3)]">
        {t("mcp.connector.actions")}
      </p>
      {actions.items.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {actions.items.map((action) => (
            <li
              key={action}
              className="rounded-full border border-[var(--line)] bg-[var(--surface-2)] px-2 py-1 font-mono text-[11px] text-[var(--text-2)]"
            >
              {action}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[12px] text-[var(--text-2)]">{t("mcp.connector.noActions")}</p>
      )}
      <p className="mt-2 text-[12px] text-[var(--text-3)]">
        {actions.kind === "discovered" ? t("mcp.connector.actionsDiscovered") : t("mcp.connector.actionsAllowlisted")}
      </p>
    </div>
  );
}

function ConnectorCard({
  connector,
  draft,
  action,
  feedback,
  onDraftChange,
  onSave,
  onTest,
  onDisconnect,
}: {
  connector: McpConnectorView;
  draft: McpConnectorDraft;
  action: McpActionState;
  feedback: McpFeedback;
  onDraftChange: (connectorId: McpConnectorId, patch: Partial<McpConnectorDraft>) => void;
  onSave: (connectorId: McpConnectorId) => void;
  onTest: (connectorId: McpConnectorId) => void;
  onDisconnect: (connectorId: McpConnectorId) => void;
}) {
  const busy = action !== null;
  const busyKind = action && action.connectorId === connector.id ? action.kind : null;
  const maxCalls = mcpMaxCallsValue(draft.maxCallsPerTurn);
  const needsToken = !connector.connected;
  const canSave =
    !busy && draft.endpointUrl.trim().length > 0 && maxCalls !== null && (!needsToken || draft.token.trim().length > 0);
  const canDisconnect = connector.connected || connector.endpointUrl !== null;
  const cardFeedback = feedback?.connectorId === connector.id ? feedback : null;
  const endpointId = `mcp-${connector.id}-endpoint`;
  const tokenId = `mcp-${connector.id}-token`;
  const maxCallsId = `mcp-${connector.id}-max-calls`;
  const accessName = `mcp-${connector.id}-access`;

  return (
    <section
      className="raise rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5"
      data-testid={`mcp-connector-${connector.id}`}
      data-connected={connector.connected ? "true" : "false"}
    >
      <ConnectorHeader connector={connector} />
      <form
        className="mt-4"
        data-testid={`mcp-form-${connector.id}`}
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (canSave) {
            onSave(connector.id);
          }
        }}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="text-sm font-medium text-[var(--text)]" htmlFor={endpointId}>
              {t("mcp.connector.endpoint")}
            </label>
            <input
              id={endpointId}
              className="input mt-1.5 w-full"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder={connector.defaultEndpointHint || t("mcp.connector.endpointPlaceholder")}
              value={draft.endpointUrl}
              disabled={busy}
              data-testid={`mcp-endpoint-${connector.id}`}
              onChange={(event) => onDraftChange(connector.id, { endpointUrl: event.target.value })}
            />
            <p className="mt-1 text-[12px] text-[var(--text-3)]">{t("mcp.connector.endpointHelp")}</p>
          </div>

          <div>
            <label className="text-sm font-medium text-[var(--text)]" htmlFor={tokenId}>
              {t("mcp.connector.token")}
            </label>
            <input
              id={tokenId}
              className="input mt-1.5 w-full"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={
                connector.connected ? t("mcp.connector.tokenSavedPlaceholder") : t("mcp.connector.tokenPlaceholder")
              }
              value={draft.token}
              disabled={busy}
              data-testid={`mcp-token-${connector.id}`}
              onChange={(event) => onDraftChange(connector.id, { token: event.target.value })}
            />
            <p className="mt-1 text-[12px] text-[var(--text-3)]">{t("mcp.connector.tokenHelp")}</p>
            {connector.connected && connector.fingerprint ? (
              <p className="mt-1 text-[12px] font-medium text-[var(--text-2)]" data-testid={`mcp-fingerprint-${connector.id}`}>
                {t("mcp.connector.fingerprint", { fingerprint: connector.fingerprint })}
              </p>
            ) : null}
          </div>
        </div>

        <fieldset className="mt-4">
          <legend className="text-sm font-medium text-[var(--text)]">{t("mcp.connector.accessMode")}</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2" data-testid={`mcp-access-${connector.id}`}>
            {ACCESS_OPTIONS.map((option) => (
              <label
                key={option.value}
                className={`flex cursor-pointer items-start gap-2 rounded-xl border p-3 ${
                  draft.accessMode === option.value
                    ? "border-[var(--accent)] bg-[var(--accent-soft)]/45"
                    : "border-[var(--line)] bg-[var(--surface-2)]/45"
                }`}
              >
                <input
                  type="radio"
                  name={accessName}
                  value={option.value}
                  checked={draft.accessMode === option.value}
                  disabled={busy}
                  data-testid={`mcp-access-${option.slug}-${connector.id}`}
                  onChange={() => onDraftChange(connector.id, { accessMode: option.value })}
                />
                <span>
                  <span className="block text-sm font-medium text-[var(--text)]">{t(option.titleKey)}</span>
                  <span className="mt-0.5 block text-[12px] text-[var(--text-2)]">{t(option.helpKey)}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="mt-4 grid gap-4 md:grid-cols-[1fr_180px]">
          <div>
            <label className="flex items-start gap-2 text-sm text-[var(--text)]" data-testid={`mcp-subagents-label-${connector.id}`}>
              <input
                type="checkbox"
                className="mt-1"
                checked={draft.allowSubagents}
                disabled={busy}
                data-testid={`mcp-subagents-${connector.id}`}
                onChange={(event) => onDraftChange(connector.id, { allowSubagents: event.target.checked })}
              />
              <span>
                <span className="block font-medium">{t("mcp.connector.allowSubagents")}</span>
                <span className="mt-0.5 block text-[12px] font-normal text-[var(--text-2)]">
                  {t("mcp.connector.allowSubagentsHelp")}
                </span>
              </span>
            </label>
          </div>
          <div>
            <label className="text-sm font-medium text-[var(--text)]" htmlFor={maxCallsId}>
              {t("mcp.connector.maxCallsPerTurn")}
            </label>
            <input
              id={maxCallsId}
              className="input mt-1.5 w-full"
              type="number"
              min={1}
              max={10}
              step={1}
              inputMode="numeric"
              value={draft.maxCallsPerTurn}
              disabled={busy}
              data-testid={`mcp-max-calls-${connector.id}`}
              onChange={(event) => onDraftChange(connector.id, { maxCallsPerTurn: event.target.value })}
            />
            <p className="mt-1 text-[12px] text-[var(--text-3)]">{t("mcp.connector.maxCallsHelp")}</p>
          </div>
        </div>

        <ConnectorActions connector={connector} />

        {cardFeedback ? (
          <p
            className={`mt-4 text-sm ${cardFeedback.kind === "error" ? "text-red-700" : "text-[var(--text-2)]"}`}
            role={cardFeedback.kind === "error" ? "alert" : undefined}
            data-testid={`mcp-feedback-${connector.id}`}
          >
            {cardFeedback.text}
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary" disabled={!canSave} data-testid={`mcp-save-${connector.id}`}>
            {busyKind === "save"
              ? t("mcp.connector.saving")
              : connector.connected
                ? t("mcp.connector.save")
                : t("mcp.connector.connect")}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || !connector.connected}
            data-testid={`mcp-test-${connector.id}`}
            onClick={() => onTest(connector.id)}
          >
            {busyKind === "test" ? t("mcp.connector.testing") : t("mcp.connector.test")}
          </button>
          <button
            type="button"
            className="btn btn-quiet text-red-700"
            disabled={busy || !canDisconnect}
            data-testid={`mcp-disconnect-${connector.id}`}
            onClick={() => onDisconnect(connector.id)}
          >
            {busyKind === "disconnect" ? t("mcp.connector.disconnecting") : t("mcp.connector.disconnect")}
          </button>
        </div>
      </form>
    </section>
  );
}

export type McpPageViewProps = {
  state: McpPageLoadState;
  drafts: McpConnectorDrafts;
  action: McpActionState;
  feedback: McpFeedback;
  onDraftChange: (connectorId: McpConnectorId, patch: Partial<McpConnectorDraft>) => void;
  onSave: (connectorId: McpConnectorId) => void;
  onTest: (connectorId: McpConnectorId) => void;
  onDisconnect: (connectorId: McpConnectorId) => void;
};

/** The MCP settings page as a pure function of its props. The container below owns every fetch and mutation. */
export function McpPageView({
  state,
  drafts,
  action,
  feedback,
  onDraftChange,
  onSave,
  onTest,
  onDisconnect,
}: McpPageViewProps) {
  const header = (
    <div className="mb-6">
      <ModeHeader icon="settings" title={t("mcp.title")} outcomeTestId="mcp-intro" outcome={t("mcp.intro")} />
    </div>
  );

  if (state.status !== "ready") {
    return (
      <main
        className="mx-auto w-full max-w-[var(--content-stage)] px-6 py-8 text-[var(--text)]"
        data-testid="mcp-page"
        aria-busy={state.status === "loading" ? true : undefined}
      >
        {header}
        <p
          className={`text-sm ${state.status === "failed" ? "text-red-700" : "text-[var(--text-2)]"}`}
          role={state.status === "failed" ? "alert" : undefined}
          data-testid="mcp-page-status"
        >
          {state.status === "failed" ? state.message : t("mcp.loading")}
        </p>
      </main>
    );
  }

  return (
    <main
      className="mx-auto w-full max-w-[var(--content-stage)] px-6 py-8 text-[var(--text)]"
      data-testid="mcp-page"
    >
      {header}
      <BoundaryCard boundaries={state.boundaries} />
      <div className="mt-4 grid gap-4 xl:grid-cols-2" data-testid="mcp-connectors">
        {state.connectors.map((connector) => (
          <ConnectorCard
            key={connector.id}
            connector={connector}
            draft={drafts[connector.id]}
            action={action}
            feedback={feedback}
            onDraftChange={onDraftChange}
            onSave={onSave}
            onTest={onTest}
            onDisconnect={onDisconnect}
          />
        ))}
      </div>
    </main>
  );
}

export function McpPage() {
  const [state, setState] = useState<McpPageLoadState>({ status: "loading" });
  const [drafts, setDrafts] = useState<McpConnectorDrafts>(() => draftsFromConnectors([]));
  const [action, setAction] = useState<McpActionState>(null);
  const [feedback, setFeedback] = useState<McpFeedback>(null);
  const actionRef = useRef<McpActionState>(null);
  const setBusyAction = useCallback((next: McpActionState) => {
    actionRef.current = next;
    setAction(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadMcpConnectors()
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setState({ status: "ready", connectors: payload.connectors, boundaries: payload.boundaries });
        setDrafts(draftsFromConnectors(payload.connectors));
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setState({ status: "failed", message: errorText(caught, "mcp.errors.load") });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const applyConnector = useCallback((payload: McpConnectorMutationPayload | McpConnectorTestPayload) => {
    setState((current) => {
      if (current.status !== "ready") {
        return current;
      }
      return {
        ...current,
        boundaries: payload.boundaries,
        connectors: current.connectors.map((connector) =>
          connector.id === payload.connector.id ? payload.connector : connector,
        ),
      };
    });
  }, []);

  const runAction = useCallback(
    (
      connectorId: McpConnectorId,
      kind: McpActionKind,
      operation: () => Promise<McpConnectorMutationPayload | McpConnectorTestPayload>,
    ) => {
      if (actionRef.current) {
        return;
      }
      setBusyAction({ connectorId, kind });
      setFeedback(null);
      void operation()
        .then((payload) => {
          applyConnector(payload);
          if (kind !== "test") {
            setDrafts((current) => ({ ...current, [connectorId]: draftFromConnector(payload.connector) }));
          }
          const text =
            kind === "test" && "safeTools" in payload
              ? t("mcp.connector.testOk", { label: payload.connector.label, count: payload.safeTools.length })
              : kind === "disconnect"
                ? t("mcp.connector.disconnectOk", { label: payload.connector.label })
                : t("mcp.connector.saveOk", { label: payload.connector.label });
          setFeedback({ connectorId, kind: "notice", text });
        })
        .catch((caught: unknown) => {
          setFeedback({ connectorId, kind: "error", text: errorText(caught, ACTION_ERROR_KEYS[kind]) });
        })
        .finally(() => {
          setBusyAction(null);
        });
    },
    [applyConnector, setBusyAction],
  );

  const changeDraft = useCallback((connectorId: McpConnectorId, patch: Partial<McpConnectorDraft>) => {
    setDrafts((current) => ({ ...current, [connectorId]: { ...current[connectorId], ...patch } }));
  }, []);

  const save = useCallback(
    (connectorId: McpConnectorId) => {
      const draft = drafts[connectorId];
      const maxCallsPerTurn = mcpMaxCallsValue(draft.maxCallsPerTurn);
      const connector = state.status === "ready" ? state.connectors.find((row) => row.id === connectorId) : undefined;
      const token = draft.token.trim();
      const needsToken = connector ? !connector.connected : true;
      if (!draft.endpointUrl.trim() || maxCallsPerTurn === null || (needsToken && token.length === 0)) {
        setFeedback({ connectorId, kind: "error", text: t("mcp.errors.invalidInput") });
        return;
      }
      const endpointUrl = draft.endpointUrl.trim();
      const endpointChanged = connector ? endpointUrl !== (connector.endpointUrl ?? "") : true;
      const verify = !connector?.connected || endpointChanged || token.length > 0;
      runAction(connectorId, "save", () =>
        saveMcpConnector(connectorId, {
          endpointUrl,
          ...(token ? { token } : {}),
          policy: {
            accessMode: draft.accessMode,
            allowSubagents: draft.allowSubagents,
            maxCallsPerTurn,
          },
          verify,
        }),
      );
    },
    [drafts, runAction, state],
  );

  const test = useCallback(
    (connectorId: McpConnectorId) => {
      runAction(connectorId, "test", () => testMcpConnector(connectorId));
    },
    [runAction],
  );

  const disconnect = useCallback(
    (connectorId: McpConnectorId) => {
      runAction(connectorId, "disconnect", () => disconnectMcpConnector(connectorId));
    },
    [runAction],
  );

  return (
    <McpPageView
      state={state}
      drafts={drafts}
      action={action}
      feedback={feedback}
      onDraftChange={changeDraft}
      onSave={save}
      onTest={test}
      onDisconnect={disconnect}
    />
  );
}
