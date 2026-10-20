"use client";

import { createPortal } from "react-dom";
import { CONTEXT_NEAR_FULL, ChatContextChip, type ContextPart } from "@/components/chat-context-chip";
import { type ChatHeaderLayout, ChatHeaderLayoutContext } from "@/components/chat-header-layout";
import { ChatUsageChip } from "@/components/chat-usage-chip";
import { t } from "@/lib/i18n";

const PANEL_LAYOUT: ChatHeaderLayout = Object.freeze({ presentation: "menu", menuOpen: true, epoch: 0 });

export function contextNearlyFull(usedTokens: number, contextLength?: number): boolean {
  return Boolean(contextLength && contextLength > 0 && usedTokens / contextLength >= CONTEXT_NEAR_FULL);
}

type Props = {
  target: HTMLElement | null | undefined;
  usedTokens: number;
  contextLength?: number;
  parts: ContextPart[];
};

export function AgentChatDetails({ target, usedTokens, contextLength, parts }: Props) {
  if (!target) {
    return null;
  }
  return createPortal(
    <section
      className="agent-harness-part agent-chat-details"
      data-testid="agent-harness-this-chat"
      aria-labelledby="agent-harness-this-chat-title"
    >
      <h3 className="agent-harness-part-title" id="agent-harness-this-chat-title">
        {t("harness.panel.contextUsage")}
      </h3>
      <ChatHeaderLayoutContext.Provider value={PANEL_LAYOUT}>
        <div className="agent-chat-details-chips">
          <ChatContextChip usedTokens={usedTokens} contextLength={contextLength} parts={parts} />
          <ChatUsageChip />
        </div>
      </ChatHeaderLayoutContext.Provider>
    </section>,
    target,
  );
}
