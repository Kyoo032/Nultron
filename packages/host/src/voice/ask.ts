/**
 * `ask_nultron`, the talker's one tool (plan W3, W5). The thinker is the Chat run the thread already
 * has, so facts come from the same tools and Knowledge Base as a typed turn. Lane C owns this file.
 * The signatures are the contract the relay codes against.
 */
import type { TenantContext } from "@agentforge/core";
import type { VoiceCard } from "@agentforge/core/voice";

export const ASK_NULTRON_TOOL_NAME = "ask_nultron";

/** The tool as the realtime session declares it (`session.update` `tools`). */
export const ASK_NULTRON_TOOL = {
  type: "function",
  name: ASK_NULTRON_TOOL_NAME,
  description:
    "Ask Nultron's desk for facts, the person's files and Knowledge Base, or to start work. Use it for every factual or task question. Pass the person's request in their own words.",
  parameters: {
    type: "object",
    properties: { question: { type: "string", description: "The person's request, in their own words." } },
    required: ["question"],
    additionalProperties: false,
  },
} as const;

export type AskResult =
  | { readonly kind: "answer"; readonly text: string }
  | { readonly kind: "needs_tap"; readonly text: string; readonly card: VoiceCard }
  | { readonly kind: "refused"; readonly reason: "gateway_blocked" | "busy" | "timeout" | "failed"; readonly text: string };

export type AskInput = {
  readonly tenant: TenantContext;
  readonly threadId: string;
  readonly question: string;
  readonly signal: AbortSignal;
};

/** Runs one thinker turn and returns what the talker should read back. Never throws. */
export async function askNultron(_input: AskInput): Promise<AskResult> {
  return { kind: "refused", reason: "failed", text: "The desk cannot answer by voice yet." };
}

/** The talker's instructions for one session, in the person's language. */
export function talkerInstructions(locale: "en" | "id"): string {
  return locale === "id"
    ? "Kamu Nultron. Jawab singkat dalam bahasa Indonesia. Untuk fakta atau tugas, panggil ask_nultron."
    : "You are Nultron. Answer briefly. For facts or tasks, call ask_nultron.";
}
