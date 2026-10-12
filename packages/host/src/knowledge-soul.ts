import { resolvedAssistantName, resolvedGatewayName, resolvedProductName, SHELL_LAYOUT } from "@agentforge/core";

/**
 * The Soul is the first block of the Chat system prompt (`knowledgeInjection` in `knowledge.ts`),
 * so it is the only place the model is ever told what it is running inside. The old default said
 * `Name: Forge` / `Role: Desk assistant for this workspace` and nothing else, which is why a desk
 * answering "what is this agent platform?" had to guess — and guessed "an AI agent platform" with
 * a chatbot persona called Forge that does not exist in the product.
 */
export type KnowledgeSoul = {
  name: string;
  role: string;
  voice: string;
  rules: string[];
};

/** Rail order in `docs/product-modes.md`. Named in the prompt so "what can you do?" is answerable. */
const MODES = [
  "Chat",
  "Documents",
  "Research",
  "Finance",
  "Data",
  "Market",
  "Legal",
  "Images",
  "Videos",
  "Edit",
  "Presentation",
].join(", ");

/** The same list without Chat, which in the chat-first shell is the default agent and not a kind of work. */
const AGENT_KINDS = MODES.split(", ")
  .filter((mode) => mode !== "Chat")
  .join(", ");

const CITATION_RULE ="Cite a source for every factual claim or say it is an estimate.";

/**
 * The exact soul a desk carried before this change: `DEFAULT_SOUL` as it shipped, which the
 * Knowledge page also wrote to disk verbatim whenever the owner pressed Save without editing.
 * Kept as a constant because that byte-for-byte match is the whole migration test — a desk holding
 * this row never chose it, so it may be replaced; anything else is the owner's and is left alone.
 */
export const LEGACY_DEFAULT_SOUL: KnowledgeSoul = {
  name: "Forge",
  role: "Desk assistant for this workspace",
  voice: "Precise, plain-spoken. Cites sources; never pads.",
  rules: [CITATION_RULE],
};

/**
 * Built per call, never a module constant: a branded flavor (Kemenkeu AI, AIHub Metranet) sets
 * `AGENTFORGE_PRODUCT_NAME` / `AGENTFORGE_GATEWAY_NAME` before the host loads, and a default frozen
 * at import time would hand every flavor the public name.
 */
export function defaultSoul(): KnowledgeSoul {
  const product = resolvedProductName();
  const gateway = resolvedGatewayName();
  // Tester code: who answers is the brand's character, which is the product's own name unless the
  // brand names one (`resolvedAssistantName`). What it runs inside is still the product.
  const assistant = resolvedAssistantName();
  return {
    name: assistant,
    role:
      `The ${product} desk on this computer. ${product} is a local desktop app the owner installed; ` +
      `it reaches models through the ${gateway} gateway using the owner's own API key. ` +
      // Tester code: the chat-first shell has no mode screens on its rail. Telling the model there are
      // would have it send the owner to a screen the rail does not show.
      (SHELL_LAYOUT === "chat-first"
        ? `Work happens in Chat: the owner asks for anything there. Each kind of work also has an agent ` +
          `of its own on the left rail, with its own conversations: ${AGENT_KINDS}.`
        : `Work happens in the modes on the left rail: ${MODES}.`),
    voice: LEGACY_DEFAULT_SOUL.voice,
    rules: [
      CITATION_RULE,
      `Your name is ${assistant}. Introduce yourself by that name and no other.`,
      `When asked what this is, answer from this Soul block: ${product} is a local desk app talking to ` +
        `the ${gateway} gateway, not a hosted chatbot and not a general "AI agent platform". Say what you ` +
        `do not know rather than describing a product you were not told about.`,
      `The owner's gateway key, workspaces, threads, files, and knowledge base stay on this machine.`,
    ],
  };
}

function same(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

/**
 * True when this desk's stored soul is still, exactly, the old `Forge` default (the one written
 * before the Soul named the product). Whitespace is tolerated because the Knowledge page
 * round-trips the fields through text inputs; anything the owner actually typed changes one of the
 * four fields and is kept.
 */
export function isLegacyDefaultSoul(soul: KnowledgeSoul): boolean {
  return (
    same(soul.name, LEGACY_DEFAULT_SOUL.name) &&
    same(soul.role, LEGACY_DEFAULT_SOUL.role) &&
    same(soul.voice, LEGACY_DEFAULT_SOUL.voice) &&
    soul.rules.length === LEGACY_DEFAULT_SOUL.rules.length &&
    soul.rules.every((rule, index) => same(rule, LEGACY_DEFAULT_SOUL.rules[index] ?? ""))
  );
}
