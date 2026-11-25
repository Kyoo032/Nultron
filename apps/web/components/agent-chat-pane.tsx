"use client";

import { useEffect, useState } from "react";
import type { ProductMode } from "@agentforge/core/product-modes";
import { AgentHarnessToggle, AgentHistoryButton, AgentNewChatLink } from "@/components/agent-chat-controls";
import { AgentHarnessPanel } from "@/components/agent-harness-panel";
import { ChatSession } from "@/components/chat-session";
import { DirectChatAdvisory } from "@/components/direct-chat-advisory";
import { TeamSessionsPanel, TeamSessionsToggle } from "@/components/team-sessions-panel";
import { useRouter } from "@/lib/nav";
import { assistantNameOf, useProductBrand } from "@/lib/product-brand";
import { useThreadSubagents } from "@/lib/team-sessions";
import { studioHref, useVirtualAgents, virtualAgentHref, virtualAgentName } from "@/lib/virtual-agents";

type Props = {
  /** The agent `/chat` names: `chat` is the default agent. */
  agentMode: ProductMode;
  threadId?: string;
};

/**
 * One agent's place in the chat-first shell (tester code, chat-first plan track B1): its
 * conversation, with the harness panel beside it when that is open.
 *
 * Every agent is a full chat (owner, 2026-10-09): the same composer, tier choice and tools, under
 * its own name and specialty. An agent whose own harness still runs from its studio says so on its
 * empty conversation and offers the way in; it converses all the same.
 *
 * Which agents exist is the host's answer (`useVirtualAgents`); this only draws it. An agent the desk
 * does not have is not shown: the route goes back to the default agent.
 */
export function AgentChatPane({ agentMode, threadId }: Props) {
  const router = useRouter();
  const brand = useProductBrand();
  const { agents, loaded } = useVirtualAgents();
  const [panelOpen, setPanelOpen] = useState(false);
  const [teamPanelOpen, setTeamPanelOpen] = useState(false);
  const [detailsSlot, setDetailsSlot] = useState<HTMLElement | null>(null);
  const { sessions: teamSessions } = useThreadSubagents(agentMode === "chat" ? threadId : undefined);
  const activeTeamCount = teamSessions.filter((item) => item.status === "running").length;
  const agent = agents.find((entry) => entry.id === agentMode);
  // An agent with no row cannot hold a thread: the host has not hired it for this desk.
  const usable = agent && (agent.generalist || agent.agentId);
  const missing = loaded && !usable;

  useEffect(() => {
    if (missing) {
      router.replace(virtualAgentHref("chat"));
    }
  }, [missing, router]);

  // The panel belongs to the agent it was opened on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: closing on an agent change is the point
  useEffect(() => {
    setPanelOpen(false);
    setTeamPanelOpen(false);
  }, [agentMode]);

  useEffect(() => {
    if (!panelOpen && !teamPanelOpen) {
      return;
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) {
        setPanelOpen(false);
        setTeamPanelOpen(false);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panelOpen, teamPanelOpen]);

  if (!agent || !usable) {
    // Not answered yet, or on its way back to the default agent: nothing to draw that would not jump.
    return <div className="agent-chat-pane" data-testid="agent-chat-pane" aria-busy="true" />;
  }

  // The default agent is the brand's character by name; every other agent is named for its mode.
  const name = virtualAgentName(agent, assistantNameOf(brand));
  const agentKey = agent.id;
  /** A thread opened under the wrong agent's address moves to its own agent's, with the thread. */
  function openForeignThread(ownerAgentId: string, foreignThreadId: string) {
    const owner = agents.find((entry) => entry.agentId === ownerAgentId);
    router.replace(owner ? virtualAgentHref(owner.id, foreignThreadId) : virtualAgentHref(agentKey));
  }

  // Every non-generalist specialist has a dedicated Dashboard for deeper prompt customization.
  const openStudio = !agent.generalist ? () => router.push(studioHref(agentKey)) : undefined;

  const brandName = assistantNameOf(brand);
  return (
    <div className="agent-chat-pane" data-testid="agent-chat-pane" data-agent={agent.id}>
      <div className="agent-chat-main">
        {!agent.generalist ? <DirectChatAdvisory agentName={name} brandName={brandName} /> : null}
        <ChatSession
          // Each agent is its own session: its threads, its live state, its header.
          key={agent.id}
          agentId={agent.generalist ? undefined : (agent.agentId ?? undefined)}
          initialThreadId={threadId}
          // Live voice talks to the orchestrator only: the generalist keeps the mic, a hired
          // specialist's chat does not.
          voiceEnabled={agent.generalist}
          shell={{
            agent,
            name,
            controls: (
              <>
                <AgentNewChatLink agent={agent} />
                <AgentHistoryButton agent={agent} name={name} activeThreadId={threadId ?? null} />
                {agent.generalist ? (
                  <TeamSessionsToggle
                    count={teamSessions.length}
                    activeCount={activeTeamCount}
                    open={teamPanelOpen}
                    onToggle={() => {
                      setTeamPanelOpen((was) => !was);
                      setPanelOpen(false);
                    }}
                  />
                ) : null}
                <AgentHarnessToggle
                  name={name}
                  open={panelOpen}
                  onToggle={() => {
                    setPanelOpen((was) => !was);
                    setTeamPanelOpen(false);
                  }}
                />
              </>
            ),
            onForeignThread: openForeignThread,
            onOpenStudio: openStudio,
            detailsTarget: detailsSlot,
          }}
        />
      </div>
      {teamPanelOpen && agent.generalist ? (
        <TeamSessionsPanel sessions={teamSessions} onClose={() => setTeamPanelOpen(false)} />
      ) : null}
      {panelOpen ? (
        <AgentHarnessPanel
          agent={agent}
          name={name}
          onClose={() => setPanelOpen(false)}
          onOpenStudio={openStudio}
          detailsRef={setDetailsSlot}
        />
      ) : null}
    </div>
  );
}
