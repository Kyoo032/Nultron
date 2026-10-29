"use client";

import "./agent-harness.css";
import { ChatKeyStatus } from "@/components/chat-key-status";
import { t } from "@/lib/i18n";
import { assistantNameOf, useProductBrand } from "@/lib/product-brand";
import { useDeskNeedsKey } from "@/lib/use-desk-needs-key";

export const CHAT_IDEAS = ["plan", "summarise", "rewrite", "decide"] as const;

export function ChatGreeting() {
  const brand = useProductBrand();
  const needsKey = useDeskNeedsKey();
  return (
    <section
      className="chat-greeting"
      data-testid="chat-empty"
      data-layout="greeting"
      data-needs-key={needsKey ? "true" : "false"}
    >
      <p className="chat-greeting-hello" data-testid="chat-greeting-hello">
        {t("agents.home.greeting", { name: assistantNameOf(brand) })}
      </p>
      <h1 className="agent-home-greeting">{t("chat.empty.headline")}</h1>
      <div className="chat-greeting-status">
        <ChatKeyStatus />
      </div>
    </section>
  );
}

export function ChatIdeaChips({ onSuggest }: { onSuggest?: (text: string) => void }) {
  return (
    <div className="chat-idea-row">
      <ul className="agent-harness-chips chat-idea-chips" data-testid="chat-suggestions">
        {CHAT_IDEAS.map((id) => (
          <li key={id}>
            <button
              type="button"
              className="agent-harness-chip chat-idea-chip"
              title={t(`chat.empty.ideas.${id}.hint`)}
              onClick={() => onSuggest?.(t(`chat.empty.ideas.${id}.prompt`))}
              data-testid="chat-suggestion"
              data-idea={id}
            >
              {t(`chat.empty.ideas.${id}.label`)}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
