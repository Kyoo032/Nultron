import { describe, expect, it } from "vitest";
import {
  MAX_TEAM_BOTS,
  isTeamBotSlug,
  proposeTeamDeterministic,
  sanitizeTeamBotProposal,
  teamBotSlug,
  teamProposalModes,
} from "./team-bots";

describe("teamBotSlug", () => {
  it("slugifies a name the way a handle should read", () => {
    expect(teamBotSlug("Tide Analyst")).toBe("tide-analyst");
    expect(teamBotSlug("  Harbor & Co.  ")).toBe("harbor-co");
    expect(teamBotSlug("Finance_Bot!!")).toBe("finance-bot");
  });

  it("collapses repeats, trims dashes and caps the length", () => {
    expect(teamBotSlug("a---b___c")).toBe("a-b-c");
    expect(teamBotSlug("-lead-and-trail-")).toBe("lead-and-trail");
    const long = teamBotSlug("x".repeat(60));
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith("-")).toBe(false);
  });

  it("falls back to bot when nothing slug-able remains", () => {
    expect(teamBotSlug("!!!")).toBe("bot");
    expect(teamBotSlug("")).toBe("bot");
  });
});

describe("isTeamBotSlug", () => {
  it("accepts tb- slugs and rejects everything else", () => {
    expect(isTeamBotSlug("tb-analyst")).toBe(true);
    expect(isTeamBotSlug("tb-")).toBe(false);
    expect(isTeamBotSlug("va-research")).toBe(false);
    expect(isTeamBotSlug("analyst")).toBe(false);
    expect(isTeamBotSlug("atb-x")).toBe(false);
  });
});

describe("sanitizeTeamBotProposal", () => {
  it("trims strings and keeps a valid proposal", () => {
    expect(
      sanitizeTeamBotProposal({ name: "  Analyst ", role: " reads briefs ", prompt: " You read. " }),
    ).toEqual({ name: "Analyst", role: "reads briefs", prompt: "You read." });
  });

  it("caps each field at its limit", () => {
    const parsed = sanitizeTeamBotProposal({
      name: "n".repeat(80),
      role: "r".repeat(200),
      prompt: "p".repeat(5000),
    });
    expect(parsed?.name).toHaveLength(60);
    expect(parsed?.role).toHaveLength(120);
    expect(parsed?.prompt).toHaveLength(4000);
  });

  it("rejects non-objects and empty names or prompts", () => {
    expect(sanitizeTeamBotProposal(null)).toBeNull();
    expect(sanitizeTeamBotProposal("bot")).toBeNull();
    expect(sanitizeTeamBotProposal([1, 2])).toBeNull();
    expect(sanitizeTeamBotProposal({ name: "", prompt: "x" })).toBeNull();
    expect(sanitizeTeamBotProposal({ name: "x", prompt: "  " })).toBeNull();
    expect(sanitizeTeamBotProposal({ name: "x" })).toBeNull();
  });
});

describe("proposeTeamDeterministic", () => {
  it("scores the modes the brief's keywords point at, best first, capped at five", () => {
    const proposal = proposeTeamDeterministic(
      "I need market research market research every week and a slide deck for the board, plus invoices for clients.",
    );
    expect(proposal.modes.length).toBeLessThanOrEqual(5);
    // "slide" and "deck" are two presentation keywords; research and market score one each.
    expect(proposal.modes[0]).toBe("presentations");
    expect(proposal.modes).toContain("research");
    expect(proposal.modes).toContain("market");
  });

  it("does not fire on substrings inside other words", () => {
    const proposal = proposeTeamDeterministic("The quick brown fox jumps over the lazy dog.");
    expect(proposal.modes).toEqual(["research", "documents"]);
  });

  it("never returns an empty mode list and drafts up to three bots naming the brief", () => {
    const proposal = proposeTeamDeterministic("help me with stuff");
    expect(proposal.modes).toEqual(["research", "documents"]);
    expect(proposal.bots.length).toBeLessThanOrEqual(3);
    expect(proposal.bots.length).toBeGreaterThan(0);
    for (const bot of proposal.bots) {
      expect(bot.name.length).toBeLessThanOrEqual(60);
      expect(bot.role.length).toBeLessThanOrEqual(120);
      expect(bot.prompt).toContain("help me with stuff");
    }
    expect(MAX_TEAM_BOTS).toBeGreaterThanOrEqual(proposal.bots.length);
  });

  it("echoes the brief and keeps every bot prompt inside its cap", () => {
    const brief = "a".repeat(1500);
    const proposal = proposeTeamDeterministic(brief);
    expect(proposal.brief).toBe(brief);
    for (const bot of proposal.bots) {
      expect(bot.prompt.length).toBeLessThanOrEqual(4000);
    }
  });
});

describe("teamProposalModes", () => {
  it("keeps catalog ids in catalog order and drops the rest", () => {
    expect(teamProposalModes(["videos", "bogus", "research", "chat", "research"])).toEqual([
      "chat",
      "research",
      "videos",
    ]);
    expect(teamProposalModes("nope")).toEqual([]);
    expect(teamProposalModes(null)).toEqual([]);
  });
});
