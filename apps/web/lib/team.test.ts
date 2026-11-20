import { describe, expect, it } from "vitest";
import {
  isTeamBotParam,
  readTeamProposal,
  readTeamRoster,
  teamBotAgent,
  teamBotHref,
  toTeamBot,
} from "./team";

const bot = {
  id: "agent-row-1",
  slug: "tb-sales",
  name: "Sales assistant",
  role: "Answers pricing questions",
  description: "Knows the current price list.",
};

describe("reading the host's team", () => {
  it("keeps a well-formed roster in catalog order", () => {
    expect(
      readTeamRoster({
        modes: ["research", "chat", "nope", "documents"],
        bots: [bot, { id: "x" }, "junk"],
      }),
    ).toEqual({
      modes: ["chat", "documents", "research"],
      bots: [bot],
    });
  });

  it("drops malformed payloads instead of throwing", () => {
    expect(readTeamRoster(null)).toEqual({ modes: [], bots: [] });
    expect(readTeamRoster({ modes: "research", bots: {} })).toEqual({ modes: [], bots: [] });
    expect(toTeamBot({ ...bot, slug: "sales" })).toBeNull();
    expect(toTeamBot({ ...bot, id: "" })).toBeNull();
    expect(toTeamBot({ ...bot, name: 7 })).toBeNull();
  });

  it("reads a proposal's editable bots and tolerates missing fields", () => {
    expect(
      readTeamProposal({
        brief: "Sell more coffee",
        modes: ["market", "unknown"],
        bots: [
          { name: "Barista", role: "Drinks", prompt: "Answer like a barista." },
          { role: "No name", prompt: "drop me" },
          { name: "Minimal" },
        ],
      }),
    ).toEqual({
      brief: "Sell more coffee",
      modes: ["market"],
      bots: [
        { name: "Barista", role: "Drinks", prompt: "Answer like a barista." },
        { name: "Minimal", role: "", prompt: "" },
      ],
    });
    expect(readTeamProposal("junk")).toEqual({ brief: "", modes: [], bots: [] });
  });
});

describe("a team bot's address", () => {
  it("knows a tb- agent parameter and nothing else", () => {
    expect(isTeamBotParam("tb-sales")).toBe(true);
    expect(isTeamBotParam("research")).toBe(false);
    expect(isTeamBotParam("tb-")).toBe(false);
  });

  it("builds /chat?agent=tb-… with an optional thread", () => {
    expect(teamBotHref("tb-sales")).toBe("/chat?agent=tb-sales");
    expect(teamBotHref("tb-sales", "thread-1")).toBe("/chat?agent=tb-sales&thread=thread-1");
    expect(teamBotHref("sales", "thread-1")).toBe("/chat?agent=tb-sales&thread=thread-1");
    expect(teamBotAgent("tb-sales")).toBe("tb-sales");
    expect(teamBotAgent("sales")).toBe("tb-sales");
  });
});
