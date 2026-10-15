import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AgentRailView, type AgentRailViewProps } from "@/components/agent-rail";
import { WEB_LOGO_SRC } from "./product-brand";

const BEFORE_THE_ANSWER: AgentRailViewProps = {
  agents: [],
  loaded: false,
  activeId: null,
  pathname: "/chat",
  productName: "Acme Desk",
  logoSrc: WEB_LOGO_SRC,
  bundledMark: false,
  onToggle: () => undefined,
};

function rail(over: Partial<AgentRailViewProps> = {}): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/chat"]}>
      <AgentRailView {...BEFORE_THE_ANSWER} {...over} />
    </MemoryRouter>,
  );
}

const JOB_MODE_TESTIDS = [
  "mode-research",
  "mode-images",
  "mode-videos",
  "mode-presentations",
  "mode-documents",
  "mode-finance",
];

describe("the chat-first rail before the host answers", () => {
  it("default shell: draws the three skeleton tiles while the agents load, as before", () => {
    const html = rail();
    expect(html.match(/data-testid="agent-rail-skeleton"/g)).toHaveLength(3);
    expect(html).not.toContain('data-testid="rail-modes-skeleton"');
  });

  it("enterprise look: draws no skeleton tile and no job-mode row while the agents load", () => {
    const html = rail({ look: "enterprise" });
    expect(html).not.toContain('data-testid="agent-rail-skeleton"');
    expect(html).not.toContain('data-testid="rail-modes-skeleton"');
    expect(html).not.toContain('data-testid="rail-modes-skeleton-row"');
    for (const testId of JOB_MODE_TESTIDS) {
      expect(html, testId).not.toContain(`data-testid="${testId}"`);
    }
  });

  it("enterprise look: the Chat link is still there before the answer, so the desk is never empty", () => {
    const html = rail({ look: "enterprise" });
    expect(html).toContain('data-testid="mode-chat"');
  });
});
