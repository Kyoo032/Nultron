"use client";

import { useEffect } from "react";
import { ChatSession, type ChatSessionShell } from "@/components/chat-session";
import { t } from "@/lib/i18n";
import { Link, useRouter } from "@/lib/nav";
import { virtualAgentHref, type VirtualAgentInfo } from "@/lib/virtual-agents";
import { madeAgentHref, useMadeAgents, type MadeAgent } from "@/lib/virtual-agents-made";
import "./agent-made.css";

function madeShellAgent(agent: MadeAgent): VirtualAgentInfo {
  return {
    id: "chat",
    generalist: false,
    conversation: "harness",
    agentId: agent.id,
    loop: "agent",
    tools: [],
    budget: { maxSteps: 0, maxToolCalls: 0 },
    repairRounds: 0,
    skills: [],
  };
}

export function MadeAgentHome({ name, description }: { name: string; description: string }) {
  return (
    <section className="agent-home" data-testid="agent-home">
      <h1 className="agent-home-greeting">{t("agents.home.greeting", { name })}</h1>
      {description ? <p className="agent-home-tagline">{description}</p> : null}
    </section>
  );
}

function NewChatLink({ agentId }: { agentId: string }) {
  const label = t("agents.header.newChat");
  return (
    <Link
      href={madeAgentHref(agentId)}
      className="agent-chat-btn"
      aria-label={label}
      title={label}
      data-testid="made-new-chat-link"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
      </svg>
    </Link>
  );
}

export function AgentMadeChatPane({ agentId, threadId }: { agentId: string; threadId?: string }) {
  const router = useRouter();
  const { agents, loaded } = useMadeAgents();
  const agent = agents.find((entry) => entry.id === agentId);
  const missing = loaded && !agent;

  useEffect(() => {
    if (missing) {
      router.replace(virtualAgentHref("chat"));
    }
  }, [missing, router]);

  if (!agent) {
    return <div className="agent-chat-pane" data-testid="agent-chat-pane" aria-busy="true" />;
  }

  const shell: ChatSessionShell = {
    agent: madeShellAgent(agent),
    name: agent.name,
    controls: <NewChatLink agentId={agent.id} />,
    threadHref: (id) => madeAgentHref(agent.id, id),
    onForeignThread: () => router.replace(virtualAgentHref("chat")),
    emptyState: <MadeAgentHome name={agent.name} description={agent.description} />,
  };

  return (
    <div className="agent-chat-pane" data-testid="agent-chat-pane" data-made-agent={agent.id}>
      <div className="agent-chat-main">
        <ChatSession key={agent.id} agentId={agent.id} initialThreadId={threadId} shell={shell} />
      </div>
    </div>
  );
}
