import { describe, expect, it } from "vitest";
import { MODE_HARNESS_SPECS } from "../harness/specs";
import { PAID_MEDIA_PER_TURN, VIRTUAL_AGENTS } from "./virtual-agents";

/**
 * Every agent's prompt tells it to make pictures and clips, and each one costs the owner money. A
 * model that decides on ten clips has to meet a ceiling the host holds, on every agent, not only on
 * the ones whose specialty is media (`chat-workers-spec.md`, section 7).
 */
describe("paid media a model may start in one turn", () => {
  it("is four pictures and one clip", () => {
    expect(PAID_MEDIA_PER_TURN).toEqual({ image_generate: 4, video_generate: 1 });
  });

  it("is in every agent's budget, the default agent's included", () => {
    for (const agent of VIRTUAL_AGENTS) {
      expect(agent.budget.perTool?.image_generate, agent.id).toBe(4);
      expect(agent.budget.perTool?.video_generate, agent.id).toBe(1);
    }
  });

  it("never loosens a ceiling the published Chat spec already sets", () => {
    const published = MODE_HARNESS_SPECS.chat.budget.perTool ?? {};
    for (const agent of VIRTUAL_AGENTS) {
      for (const [key, cap] of Object.entries(published)) {
        expect(agent.budget.perTool?.[key], `${agent.id} ${key}`).toBeLessThanOrEqual(cap);
      }
    }
  });
});
