import { bareModelId } from "./request-constraints";

/**
 * Chat models the product no longer runs by default, each with the newer id that took its place.
 *
 * Owner's rule (2026-11-10): everyone gets the newest models at the lowest price, and nothing the
 * product picks on its own is an older generation that costs more for the same job. An id here may
 * still be listed by the gateway, and nothing stops the gateway serving it; it is only kept out of
 * every list the product walks by itself: the Chat default and the Recommended set, the three Chat
 * tiers, each job mode's list, the job fallback tail and the choice profiles.
 * `model-policy-guard.test.ts` fails if one of those lists names an id below. The studios' pickers and
 * their Recommended group leave it out too, unless the desk has it selected already, so a saved choice
 * is never stranded (`pickerGroups`).
 *
 * Prices are USD per 1M input / output tokens from the gateway's public price list
 * (`GET /api/pricing`, group ratio 1) on 2026-11-10. A successor is never dearer than what it replaces.
 * They are a record of why each line exists, not a live price: the usage panel reads the live list.
 */

export type SupersededModel = Readonly<{
  /** The id that runs in its place, in every list. */
  successor: string;
  /** Price per 1M tokens, input then output, of the old id and of its successor, on 2026-11-10. */
  was: readonly [number, number];
  now: readonly [number, number];
  why: string;
}>;

export const SUPERSEDED_MODELS: Readonly<Record<string, SupersededModel>> = Object.freeze({
  "gpt-5.6-luna": {
    successor: "gpt-6-luna",
    was: [0.2, 1.2],
    now: [0.1, 0.5],
    why: "GPT 6 Luna is the newer small tier at half the input price.",
  },
  "gpt-5.6-terra": {
    successor: "gpt-6-sol",
    was: [2, 12],
    now: [2, 10],
    why: "GPT 6 Sol is the newer everyday tier and cheaper on output.",
  },
  "gpt-5.6-sol": {
    successor: "claude-opus-5-5",
    was: [4, 20],
    now: [4, 20],
    why: "Its job-mode slots go to Claude Opus 5.5, the probed deep model at the same price; GPT 6 Sol ($2 / $10) already heads those lists.",
  },
  "gpt-5-mini": {
    successor: "gpt-6-luna",
    was: [0.25, 2],
    now: [0.1, 0.5],
    why: "OpenAI shuts gpt-5-mini down on 2026-12-11.",
  },
  "claude-sonnet-5": {
    successor: "claude-sonnet-5-5",
    was: [2, 10],
    now: [2, 10],
    why: "Claude Sonnet 5.5 is the newer version at the same price.",
  },
  "claude-opus-5": {
    successor: "claude-opus-5-5",
    was: [5, 25],
    now: [4, 20],
    why: "Claude Opus 5.5 is the newer version and cheaper.",
  },
  "claude-haiku-4-5": {
    successor: "claude-haiku-5-5",
    was: [1, 5],
    now: [0.1, 0.5],
    why: "Claude Haiku 5.5 is a generation newer at a tenth of the price.",
  },
  "deepseek-v4-flash": {
    successor: "deepseek-v4-1-flash",
    was: [0.44, 1.32],
    now: [0.03, 1.2],
    why: "DeepSeek V4.1 Flash is the newer version and cheaper (both peak-hour prices; off-peak halves each).",
  },
  "gemini-3.5-flash": {
    successor: "gemini-3.8-flash",
    was: [1.5, 9],
    now: [0.5, 3],
    why: "Gemini 3.8 Flash is three versions newer at a third of the price.",
  },
  "kimi-k3": {
    successor: "kimi-k3.1-pro",
    was: [2.86, 14.29],
    now: [2, 10],
    why: "Kimi K3.1 Pro is the newer version and cheaper.",
  },
});

/** Whether the product should never pick `id` by itself. Case, outer space and a vendor prefix do not matter. */
export function isSupersededModel(id: string): boolean {
  return Object.hasOwn(SUPERSEDED_MODELS, bareModelId(id));
}
