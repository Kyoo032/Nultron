"use client";

import { useState } from "react";
import type { MediaRequest } from "@agentforge/core/media-permission";
import { t } from "@/lib/i18n";
import { grantOf, requestDetails, requestPriceLine, requestPrompt, type ShownMediaRequest } from "@/lib/media-permission";

type Props = {
  readonly requests: readonly ShownMediaRequest[];
  /** Absent once the turn has been followed up: the card then only records what was asked. */
  readonly onRun?: (requests: MediaRequest[]) => void;
  /** A run is in flight, so Run waits. */
  readonly disabled?: boolean;
};

function titleOf(request: ShownMediaRequest): string {
  return t(request.tool === "image_generate" ? "chat.media.imageTitle" : "chat.media.videoTitle");
}

/**
 * The paid pictures and clips a model asked for and was held back from (SR-167), under the answer. Each one
 * names what would be made and its list price; nothing starts until the person presses Run. Run sends the
 * requests back, one call each. Not now only hides the buttons: the model was already told to stop.
 */
export function MediaPermissionCards({ requests, onRun, disabled = false }: Props) {
  const [dismissed, setDismissed] = useState(false);
  if (requests.length === 0) {
    return null;
  }
  const actionable = onRun !== undefined && !dismissed;
  return (
    <section
      className="min-w-0 max-w-[32rem] rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-3 shadow-elev-1"
      data-testid="chat-media-permission"
      data-actionable={actionable ? "true" : "false"}
      aria-label={t("chat.media.listAria")}
    >
      {actionable ? (
        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-3)]">
          {t("chat.media.label")}
        </p>
      ) : null}
      <ul className="space-y-2">
        {requests.map((request, index) => {
          const details = requestDetails(request);
          return (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: a request has no id; the order the model made them in is its identity
              key={index}
              className="min-w-0"
              data-testid="chat-media-request"
              data-tool={request.tool}
            >
              <h4 className="text-sm font-semibold text-[var(--text)]">{titleOf(request)}</h4>
              <p
                className="mt-0.5 line-clamp-3 break-words text-sm text-[var(--text-2)] [overflow-wrap:anywhere]"
                data-testid="chat-media-prompt"
              >
                {requestPrompt(request)}
              </p>
              {details.length > 0 ? (
                <p className="mt-0.5 text-xs text-[var(--text-3)]" data-testid="chat-media-details">
                  {details.join(" · ")}
                </p>
              ) : null}
              <p className="mt-0.5 text-xs text-[var(--text-2)]" data-testid="chat-media-price">
                {requestPriceLine(request)}
              </p>
            </li>
          );
        })}
      </ul>
      {actionable ? (
        <>
          <p className="mt-2 text-xs text-[var(--text-3)]">{t("chat.media.spends")}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary"
              data-testid="chat-media-run"
              disabled={disabled}
              onClick={() => onRun?.(requests.map(grantOf))}
            >
              {requests.length === 1 ? t("chat.media.run") : t("chat.media.runAll", { n: requests.length })}
            </button>
            <button type="button" className="btn btn-secondary" data-testid="chat-media-dismiss" onClick={() => setDismissed(true)}>
              {t("chat.media.notNow")}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
