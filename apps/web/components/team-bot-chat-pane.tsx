"use client";

import { useEffect } from "react";
import "@/components/agent-chat.css";
import { ChatSession } from "@/components/chat-session";
import { DirectChatAdvisory } from "@/components/direct-chat-advisory";
import { useRouter } from "@/lib/nav";
import { assistantNameOf, useProductBrand } from "@/lib/product-brand";
import { teamBotHref, useTeam, type TeamBotSlug } from "@/lib/team";

type Props = {
  /** The `tb-…` agent id `/chat` names. */
  slug: TeamBotSlug;
  threadId?: string;
};

/**
 * One team bot's chat. The bot row is the host's answer (`useTeam`): its `id` owns the threads, its
 * `slug` is the address. A slug the desk does not have goes back to the generalist, the same rule an
 * unknown mode agent follows.
 */
export function TeamBotChatPane({ slug, threadId }: Props) {
  const router = useRouter();
  const brand = useProductBrand();
  const { roster, loaded } = useTeam();
  const bot = roster.bots.find((entry) => entry.slug === slug);
  const missing = loaded && !bot;

  useEffect(() => {
    if (missing) {
      router.replace("/chat");
    }
  }, [missing, router]);

  if (!bot) {
    // Not answered yet, or on its way back to the generalist: nothing to draw that would not jump.
    return <div className="agent-chat-pane" data-testid="team-bot-chat-pane" data-bot={slug} aria-busy="true" />;
  }

  return (
    <div className="agent-chat-pane" data-testid="team-bot-chat-pane" data-bot={bot.slug}>
      <div className="agent-chat-main">
        <DirectChatAdvisory agentName={bot.name} brandName={assistantNameOf(brand)} />
        <ChatSession
          key={bot.id}
          agentId={bot.id}
          initialThreadId={threadId}
          hrefForThread={(id) => teamBotHref(bot.slug, id)}
          // Live voice talks to the orchestrator only; a team bot's chat has no microphone.
          voiceEnabled={false}
        />
      </div>
    </div>
  );
}
