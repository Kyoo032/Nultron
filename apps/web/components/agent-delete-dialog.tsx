"use client";

import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { deleteMadeAgent, type MadeAgent } from "@/lib/virtual-agents-made";
import "./agent-made.css";

type Props = {
  agent: MadeAgent;
  onCancel: () => void;
  onDeleted: (agentId: string) => void;
};

export function AgentDeleteDialog({ agent, onCancel, onDeleted }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) {
        onCancel();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  async function confirm() {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    const result = await deleteMadeAgent(agent.id);
    if (result.ok) {
      onDeleted(result.agentId);
      return;
    }
    setBusy(false);
    setError(t(result.failure.kind === "message" ? result.failure.key : "agents.made.error.delete"));
  }

  return (
    <div className="agent-made-scrim" data-testid="made-agent-delete-dialog">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="made-agent-delete-title"
        aria-describedby="made-agent-delete-body"
        className="agent-made-dialog"
      >
        <h2 id="made-agent-delete-title" className="agent-made-dialog-title">
          {t("agents.made.deleteTitle", { name: agent.name })}
        </h2>
        <p id="made-agent-delete-body" className="agent-made-dialog-body" data-testid="made-agent-delete-body">
          {t("agents.made.deleteBody", { name: agent.name })}
        </p>
        {error ? (
          <p role="alert" className="agent-made-dialog-error" data-testid="made-agent-delete-error">
            {error}
          </p>
        ) : null}
        <div className="agent-made-dialog-actions">
          <button
            type="button"
            className="btn btn-secondary"
            data-testid="made-agent-delete-cancel"
            onClick={onCancel}
            disabled={busy}
          >
            {t("agents.made.deleteCancel")}
          </button>
          <button
            type="button"
            className="agent-made-danger"
            data-testid="made-agent-delete-confirm"
            onClick={() => void confirm()}
            disabled={busy}
          >
            {busy ? t("agents.made.deleting") : t("agents.made.deleteConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
