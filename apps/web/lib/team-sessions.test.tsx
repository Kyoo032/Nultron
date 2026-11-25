import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRailView } from "@/components/agent-rail";
import { DirectChatAdvisory } from "@/components/direct-chat-advisory";
import { TeamSessionsPanel, TeamSessionsToggle } from "@/components/team-sessions-panel";
import { THREADS_CHANGED_EVENT } from "./threads-events";
import { applyLocale, resetLocaleForTests } from "./i18n";
import {
  notifySubagentsChanged,
  SUBAGENTS_CHANGED_EVENT,
  useThreadSubagents,
  type DelegatedSessionInfo,
} from "./team-sessions";
import { installMiniDom } from "./test-dom";

const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(),
}));

vi.mock("@/lib/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-client")>()),
  apiFetch,
}));

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

beforeEach(() => {
  applyLocale("en");
  apiFetch.mockReset();
  apiFetch.mockResolvedValue(jsonSessions([]));
});
afterEach(() => resetLocaleForTests());

function jsonSessions(rows: readonly DelegatedSessionInfo[]): Response {
  return new Response(JSON.stringify({ sessions: rows }), { status: 200 });
}

function SubagentsProbe({ threadId, open }: { threadId?: string; open: boolean }) {
  const state = useThreadSubagents(threadId, { open });
  return (
    <output data-testid="subagents-probe">
      {state.sessions.length}:{state.loaded ? "loaded" : "loading"}
    </output>
  );
}

async function renderProbe(threadId: string | undefined, open: boolean) {
  const dom = installMiniDom();
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => {
    root.render(<SubagentsProbe threadId={threadId} open={open} />);
  });
  return { container, dom, root };
}

describe("live delegated-session reloading", () => {
  it("uses a lightweight subagents event rather than the full threads-changed event", () => {
    const dom = installMiniDom();
    try {
      let subagents = 0;
      let threads = 0;
      dom.window.addEventListener(SUBAGENTS_CHANGED_EVENT, () => {
        subagents += 1;
      });
      dom.window.addEventListener(THREADS_CHANGED_EVENT, () => {
        threads += 1;
      });
      notifySubagentsChanged();
      expect(subagents).toBe(1);
      expect(threads).toBe(0);
    } finally {
      dom.restore();
    }
  });

  it("reloads the thread's subagents when the lightweight event fires", async () => {
    const rendered = await renderProbe("thread_main", false);
    try {
      expect(apiFetch).toHaveBeenCalledTimes(1);
      await act(async () => {
        notifySubagentsChanged();
      });
      expect(apiFetch).toHaveBeenCalledTimes(2);
      expect(apiFetch.mock.calls[1]?.[0]).toBe("/api/v1/threads/thread_main/subagents");
      await act(async () => {
        rendered.root.unmount();
      });
    } finally {
      rendered.dom.restore();
    }
  });

  it("reloads when the drawer opens and keeps polling while open without a running session", async () => {
    vi.useFakeTimers();
    const rendered = await renderProbe("thread_main", false);
    try {
      expect(apiFetch).toHaveBeenCalledTimes(1);
      await act(async () => {
        vi.advanceTimersByTime(3100);
      });
      expect(apiFetch).toHaveBeenCalledTimes(1);

      await act(async () => {
        rendered.root.render(<SubagentsProbe threadId="thread_main" open />);
      });
      expect(apiFetch).toHaveBeenCalledTimes(2);

      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      expect(apiFetch).toHaveBeenCalledTimes(3);
      await act(async () => {
        rendered.root.unmount();
      });
    } finally {
      rendered.dom.restore();
      vi.useRealTimers();
    }
  });

  it("wires delegate tool starts and progress in ChatSession to the lightweight signal", () => {
    const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const chat = readFileSync(join(webRoot, "components/chat-session.tsx"), "utf8").replace(/\r\n/g, "\n");
    const progressStart = chat.indexOf("onToolProgress={(event) => {");
    const toolStart = chat.indexOf("onTool={(event) => {");
    const failedStart = chat.indexOf("onFailed={() => {");
    const progressHandler = chat.slice(progressStart, toolStart);
    const toolHandler = chat.slice(toolStart, failedStart);
    expect(progressHandler).toContain('event.toolKey === "delegate"');
    expect(progressHandler).toContain("notifySubagentsChanged()");
    expect(toolHandler).toContain('event.phase === "started" && event.toolKey === "delegate"');
    expect(toolHandler).toContain("notifySubagentsChanged()");
  });

  it("passes the drawer's open state into the hook", () => {
    const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const pane = readFileSync(join(webRoot, "components/agent-chat-pane.tsx"), "utf8").replace(/\r\n/g, "\n");
    expect(pane).toMatch(
      /useThreadSubagents\(agentMode === "chat" \? threadId : undefined, \{\s*open: teamPanelOpen,?\s*\}\)/,
    );
  });
});

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
