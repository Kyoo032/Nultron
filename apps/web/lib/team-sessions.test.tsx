import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRailView } from "@/components/agent-rail";
import { DirectChatAdvisory } from "@/components/direct-chat-advisory";
import { TeamSessionsPanel, TeamSessionsToggle } from "@/components/team-sessions-panel";
import { applyLocale, resetLocaleForTests } from "./i18n";
import type { DelegatedSessionInfo } from "./team-sessions";

const SESSIONS: DelegatedSessionInfo[] = [
  {
    id: "del_1",
    parentThreadId: "thread_main",
    childThreadId: "thread_sub_1",
    agentKey: "research",
    agentKind: "mode",
    agentName: "Research",
    task: "Compare cloud pricing across regions",
    status: "completed",
    summary: "Jakarta region is 12% lower for compute.",
    truncated: false,
    toolsUsed: ["web_search", "research_dossier"],
    createdAt: "2026-11-25T10:00:00.000Z",
    updatedAt: "2026-11-25T10:01:00.000Z",
    finishedAt: "2026-11-25T10:01:00.000Z",
  },
  {
    id: "del_2",
    parentThreadId: "thread_main",
    childThreadId: "thread_sub_2",
    agentKey: "tb-finance-bot",
    agentKind: "bot",
    agentName: "Finance Bot",
    task: "Compute monthly burn projection",
    status: "running",
    summary: "",
    truncated: false,
    toolsUsed: [],
    createdAt: "2026-11-25T10:02:00.000Z",
    updatedAt: "2026-11-25T10:02:00.000Z",
  },
];

beforeEach(() => applyLocale("en"));
afterEach(() => resetLocaleForTests());

describe("TeamSessionsToggle & TeamSessionsPanel", () => {
  it("renders count badge and tracks both running and completed subagent sessions with direct-chat links", () => {
    const toggle = renderToStaticMarkup(
      <TeamSessionsToggle count={2} activeCount={1} open={false} onToggle={() => {}} />,
    );
    expect(toggle).toContain('data-testid="team-sessions-toggle"');
    expect(toggle).toContain('data-testid="team-sessions-badge"');
    expect(toggle).toContain(">2<");

    const panel = renderToStaticMarkup(
      <MemoryRouter>
        <TeamSessionsPanel sessions={SESSIONS} onClose={() => {}} />
      </MemoryRouter>,
    );
    expect(panel).toContain('data-testid="team-sessions-panel"');
    expect(panel).toContain("Research");
    expect(panel).toContain("Completed");
    expect(panel).toContain("Finance Bot");
    expect(panel).toContain("Running");
    expect(panel).toContain('href="/chat?agent=research&amp;thread=thread_sub_1"');
    expect(panel).toContain('href="/chat?agent=tb-finance-bot&amp;thread=thread_sub_2"');
  });

  it("translates team sessions panel into Bahasa Indonesia", () => {
    applyLocale("id");
    const panel = renderToStaticMarkup(
      <MemoryRouter>
        <TeamSessionsPanel sessions={SESSIONS} onClose={() => {}} />
      </MemoryRouter>,
    );
    expect(panel).toContain("Sesi tim agen");
    expect(panel).toContain("Selesai");
    expect(panel).toContain("Berjalan");
    expect(panel).toContain("Buka obrolan langsung");
  });
});

describe("DirectChatAdvisory", () => {
  it("advises staying in main Chat while preserving direct chat access in EN and ID", () => {
    const en = renderToStaticMarkup(
      <MemoryRouter>
        <DirectChatAdvisory agentName="Sales Bot" brandName="Nultron" />
      </MemoryRouter>,
    );
    expect(en).toContain('data-testid="direct-chat-advisory"');
    expect(en).toContain("Sales Bot");
    expect(en).toContain('href="/chat"');
    expect(en).toContain("Back to Nultron Chat");

    applyLocale("id");
    const id = renderToStaticMarkup(
      <MemoryRouter>
        <DirectChatAdvisory agentName="Sales Bot" brandName="Nultron" />
      </MemoryRouter>,
    );
    expect(id).toContain("Kembali ke Chat Nultron");
  });
});

describe("AgentRailView chat sessions with subagent badges", () => {
  it("renders chat sessions in expanded rail with subagent count badge", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AgentRailView
          agents={[]}
          loaded
          activeId="chat"
          activeThreadId="thread_main"
          sessions={[
            {
              id: "thread_main",
              title: "Q4 Expansion Plan",
              agentId: "agent_chat",
              agentName: "Nultron",
              createdAt: "2026-11-25T10:00:00.000Z",
              isDefaultChat: true,
              subagentCount: 2,
              activeSubagents: 1,
            },
          ]}
          pathname="/chat"
          productName="Nultron"
          logoSrc=""
          bundledMark
        />
      </MemoryRouter>,
    );
    expect(html).toContain('data-testid="rail-chat-sessions"');
    expect(html).toContain("Q4 Expansion Plan");
    expect(html).toContain('data-testid="rail-session-subagents"');
    expect(html).toContain("1 running");
  });
});
