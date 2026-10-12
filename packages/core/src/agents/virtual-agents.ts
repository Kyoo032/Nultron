import { DEFAULT_CHAT_PROMPT, DEFAULT_CHAT_SLUG } from "./default-chat";
import { PRODUCT_MODE_IDS, productModeLabel, type ProductMode } from "./product-modes";
import type { HarnessSkill } from "../harness/mode-skills";
import type { HarnessLoop, RunBudget } from "../harness/spec";
import { MODE_HARNESS_SPECS } from "../harness/specs";

/**
 * A virtual agent is one product-mode harness shown as a worker with its own conversations
 * (`docs/internal/chat-first-plan.md`, track B). There is exactly one per harness spec, so this file
 * adds no mode: it reads `MODE_HARNESS_SPECS` and says how each one is reached from the chat shell.
 *
 * Every agent is a full chat (owner, 2026-10-09: "not just default agents, all virtual agents able to
 * do everything, its a chat mode now"). Each one binds the whole chat tool set and every worker, and
 * differs from the next by its specialty: what it is told it is for, and the conversations it keeps.
 * Nobody has to hire a second agent to get a picture, a clip, a deck or a dossier.
 *
 * What the host enforces from this table on every run of an agent's conversation: the prompt, the
 * tools it may call (`tools`, never the stored binding rows) and the step and call budget. A person
 * cannot widen any of them.
 */

export const VIRTUAL_AGENT_SLUG_PREFIX = "va-";

/**
 * Where an agent's OWN harness runs today. Every agent converses and can do the general work either way.
 * `harness`: its harness is a tool of its conversation, so the specialty runs, with its checks, in chat.
 * `studio`: its harness still runs from its studio screen. In chat the agent does that work with the
 * general tools, and says so; it never claims the studio's checks ran.
 */
export type VirtualAgentConversation = "harness" | "studio";

export type VirtualAgent = {
  /** The product mode whose harness spec this agent is. */
  readonly id: ProductMode;
  /** The slug of the agent row that owns its conversations on a desk. */
  readonly slug: string;
  /** The default agent, first on every desk. It carries the brand character's name, not a mode's. */
  readonly generalist: boolean;
  readonly conversation: VirtualAgentConversation;
  /** How the agent's own harness drives the model (its spec's loop), for the "how it works" panel. */
  readonly loop: HarnessLoop;
  /** The tools a run of this agent's conversation binds: the same full set for every agent. */
  readonly tools: readonly string[];
  /** The budget of a run of this agent's conversation. */
  readonly budget: RunBudget;
  /** The skills of the agent's own harness. */
  readonly skills: readonly HarnessSkill[];
  /** Check-and-repair rounds the agent's own harness runs on its output. */
  readonly repairRounds: number;
  /** The system prompt of a run of this agent's conversation. */
  readonly prompt: string;
  /**
   * Said last, after everything the host appends to the prompt (the desk's Soul block, the knowledge
   * it retrieved). The Soul block names the desk's default assistant and tells the model to use that
   * name and no other; driven on 2026-10-09, the Images agent answered "I'm" the default agent's name.
   * The last word on who is speaking has to be the agent's own. Empty for the default agent, whose
   * name the Soul block is.
   */
  readonly closing: string;
};

/**
 * The harnesses that are tools of a conversation. Every agent binds all of them, whatever the desk
 * has hired: hiring a mode's agent gives that work its own conversations and is never what makes the
 * work possible. A mode joins this table in the same change that registers its worker on the host.
 *
 * Pictures, clips and decks are already chat's own tools (`DEFAULT_CHAT_TOOLS`: `image_generate`,
 * `video_generate`, `build_deck`), so they are not listed here.
 *
 * Each entry is the call ceiling for one turn and the sentence the prompt gains. A worker's question
 * leaves the desk for the web the way a `web_search` query does, so it is bounded the same way: the
 * egress guard (`runtime/egress-guard.ts`) lets a search run after a private read, and so this.
 */
const CHAT_WORKERS: Readonly<Record<string, { readonly perTurn: number; readonly sentence: string }>> = {
  research_dossier: {
    // One dossier is a long run; a turn gets two so a follow-up can ask for a second angle.
    perTurn: 2,
    sentence:
      "research_dossier researches one question on the web and writes a sourced dossier, in a few minutes: use it when the owner asks for research, a report or a briefing on a subject, not for a quick fact that web_search answers. It returns a short summary and the dossier is shown to the owner as a card under your answer, so say what it covers and any check that failed, and do not paste it.",
  },
};

/** The worker tool keys every agent binds after chat's own tools, in a stable order. */
export const GENERALIST_WORKER_TOOLS: readonly string[] = Object.freeze(Object.keys(CHAT_WORKERS));

/** The paragraph every agent's prompt gains for the workers. Empty when there are none. */
export const GENERALIST_WORKER_PROMPT: string =
  GENERALIST_WORKER_TOOLS.length === 0
    ? ""
    : [
        "",
        "Bigger jobs, each run by its own harness with its own checks:",
        ...GENERALIST_WORKER_TOOLS.map((key) => `- ${CHAT_WORKERS[key]?.sentence ?? key}`),
      ].join("\n");

const CHAT_SPEC = MODE_HARNESS_SPECS.chat;

/** Every agent's tools: chat's own, then the workers. */
const FULL_CHAT_TOOLS: readonly string[] = Object.freeze([...CHAT_SPEC.tools, ...GENERALIST_WORKER_TOOLS]);

/**
 * Paid media a model may start in one turn (`chat-workers-spec.md`, section 7: four pictures, one
 * clip). Every agent's prompt now tells it to make them, so a model that decides on ten clips must
 * meet a ceiling the host holds. This is a ceiling only: the cost card with a Run control that the
 * plan's decision D4 asks for before a clip is made is not built.
 */
export const PAID_MEDIA_PER_TURN: Readonly<Record<string, number>> = Object.freeze({
  image_generate: 4,
  video_generate: 1,
});

/** Every agent's budget: Chat's declared one, plus a ceiling for paid media and for each worker. */
const FULL_CHAT_BUDGET: RunBudget = Object.freeze({
  ...CHAT_SPEC.budget,
  perTool: Object.freeze({
    ...CHAT_SPEC.budget.perTool,
    ...PAID_MEDIA_PER_TURN,
    ...Object.fromEntries(GENERALIST_WORKER_TOOLS.map((key) => [key, CHAT_WORKERS[key]?.perTurn ?? 1])),
  }),
});

/**
 * The published Chat prompt opens by saying who the model is. A mode agent says that in its own
 * words, so its prompt takes the rest of Chat's (the tools, the rules) without that sentence.
 * `virtual-agents.test.ts` fails if the published prompt stops opening this way.
 */
export const CHAT_IDENTITY_SENTENCE = "You are the general assistant on the owner's desk. ";

const CHAT_BODY = DEFAULT_CHAT_PROMPT.startsWith(CHAT_IDENTITY_SENTENCE)
  ? DEFAULT_CHAT_PROMPT.slice(CHAT_IDENTITY_SENTENCE.length)
  : DEFAULT_CHAT_PROMPT;

type Specialty = {
  /** What the agent is for and how it goes about it, said to the model in two or three sentences. */
  readonly brief: string;
  /** The worker that runs this agent's own harness in chat. Absent while it still runs from its studio. */
  readonly worker?: string;
};

type ModeAgentId = Exclude<ProductMode, "chat">;

/** One specialty per mode agent. The `Record` type makes a missing mode a compile error. */
const SPECIALTIES: Readonly<Record<ModeAgentId, Specialty>> = {
  documents: {
    brief:
      "Your specialty is writing documents: briefs, reports, letters, proposals. Write the document in full, in clean Markdown with headings, and save it with write_file when the owner wants to keep it. Stay inside the sources the owner gave you and say what you assumed.",
  },
  research: {
    worker: "research_dossier",
    brief:
      "Your specialty is research. For a research question, a report or a briefing on a subject, call research_dossier with one clear question in the language of this conversation: it plans the queries, searches, reads the pages, writes the dossier and checks that every finding cites a source. Do not write research findings from memory. If the request is too vague to research, ask one short question first.",
  },
  finance: {
    brief:
      "Your specialty is finance: briefs, ratios, budgets, cash flow and appraisals. Never work out a figure in your head: compute every figure with run_code or calculator from the owner's numbers or files, show the inputs, and say a number is missing rather than guess it.",
  },
  data: {
    brief:
      "Your specialty is data analysis. Read the owner's table with read_file and answer with run_code: query, never guess, and show the numbers your answer rests on.",
  },
  market: {
    brief:
      "Your specialty is markets. Use web_search and web_fetch for prices and news, give the date and time of every figure, and say plainly that what you give is information and not investment advice.",
  },
  legal: {
    brief:
      "Your specialty is contracts and matters. Read the documents the owner attaches, quote the clause you rely on, keep what the text says apart from your reading of it, and say that this is not legal advice.",
  },
  meeting: {
    brief:
      "Your specialty is meetings: turn a transcript or notes into minutes, decisions and actions, each with its owner and date. Keep every name exactly as it is written.",
  },
  images: {
    brief:
      "Your specialty is pictures. For a picture call image_generate with a full brief: subject, setting, light, style and framing. Ask one question first only when the subject itself is unclear.",
  },
  videos: {
    brief:
      "Your specialty is short video clips. For a clip call video_generate with one clear shot: subject, action, camera, light and length.",
  },
  music: {
    brief:
      "Your specialty is songs and music: write lyrics, a structure and a style brief the owner can take to the Music studio, in the language they ask for.",
  },
  edit: {
    brief:
      "Your specialty is video editing: plan the cuts, the captions and the structure from what the owner describes or attaches, shot by shot.",
  },
  presentations: {
    brief:
      "Your specialty is slide decks. For a deck call build_deck with an outline you write: one claim per slide, three to five short bullets, and what the presenter says in the notes.",
  },
  education: {
    brief:
      "Your specialty is teaching material: lesson plans, quizzes and study guides for a topic or a file, pitched at the level the owner names.",
  },
};

/** Said to an agent whose own harness still runs from its studio, so it never claims that run happened. */
function studioNote(label: string): string {
  return `The ${label} studio runs this work with its own checks. In this chat you do it with the tools below; when the owner needs the studio's checked run, tell them it opens from your page, and never say its checks ran here.`;
}

function modeAgentPrompt(mode: ModeAgentId): string {
  const label = productModeLabel(mode);
  const specialty = SPECIALTIES[mode];
  return [
    `You are the ${label} agent on the owner's desk. ${specialty.brief}`,
    ...(specialty.worker ? [] : [studioNote(label)]),
    "You are not limited to your specialty. Every tool below is yours, so do whatever the owner asks in this chat: write, research, compute, work with files, and make pictures, clips and decks.",
    // The desk's Soul block follows the prompt and names the desk's default assistant. Its voice and
    // rules hold here; its name does not, or every agent would introduce itself as the default one.
    `A Soul block may follow. Take its voice and its rules, but in this chat you are the ${label} agent, whatever name it gives.`,
    "",
    `${CHAT_BODY}${GENERALIST_WORKER_PROMPT}`,
  ].join("\n");
}

function modeAgentClosing(mode: ModeAgentId): string {
  const label = productModeLabel(mode);
  return `\n\nWho is speaking: in this chat you are the ${label} agent. A name given in the Soul block above is the desk's default assistant, not you. When asked who you are, say you are the ${label} agent, and that you can also do everything else the owner asks here.`;
}

function agentFor(mode: ProductMode): VirtualAgent {
  const spec = MODE_HARNESS_SPECS[mode];
  const shared = {
    id: mode,
    loop: spec.loop,
    tools: FULL_CHAT_TOOLS,
    budget: FULL_CHAT_BUDGET,
    skills: spec.skills,
    repairRounds: spec.repairRounds,
  };
  if (mode === "chat") {
    return {
      ...shared,
      slug: DEFAULT_CHAT_SLUG,
      generalist: true,
      conversation: "harness",
      prompt: `${DEFAULT_CHAT_PROMPT}${GENERALIST_WORKER_PROMPT}`,
      closing: "",
    };
  }
  return {
    ...shared,
    slug: `${VIRTUAL_AGENT_SLUG_PREFIX}${mode}`,
    generalist: false,
    conversation: SPECIALTIES[mode].worker ? "harness" : "studio",
    prompt: modeAgentPrompt(mode),
    closing: modeAgentClosing(mode),
  };
}

/** Every virtual agent, the generalist first, then catalog order. One per harness spec. */
export const VIRTUAL_AGENTS: readonly VirtualAgent[] = Object.freeze(
  [...PRODUCT_MODE_IDS].sort((a, b) => Number(b === "chat") - Number(a === "chat")).map(agentFor),
);

const BY_ID = new Map<ProductMode, VirtualAgent>(VIRTUAL_AGENTS.map((agent) => [agent.id, agent]));
const BY_SLUG = new Map<string, VirtualAgent>(VIRTUAL_AGENTS.map((agent) => [agent.slug, agent]));

export function virtualAgentFor(mode: ProductMode): VirtualAgent {
  // The registry is built from `PRODUCT_MODE_IDS`, so every mode has an entry.
  return BY_ID.get(mode) as VirtualAgent;
}

export function virtualAgentBySlug(slug: string): VirtualAgent | undefined {
  return BY_SLUG.get(slug);
}

/** A mode agent's row, as opposed to the generalist's `quick-chat` row or an agent a person built. */
export function isVirtualAgentSlug(slug: string): boolean {
  return slug.startsWith(VIRTUAL_AGENT_SLUG_PREFIX) && BY_SLUG.has(slug);
}

/**
 * The agents a desk shows: the generalist always, then the desk's own modes in catalog order. The
 * desk's stored `productModes` decide it, so the first-desk rule (`FIRST_RUN_MODES`) carries over
 * to agents without a second list.
 */
export function virtualAgentsForDesk(visibleModes: readonly ProductMode[]): VirtualAgent[] {
  const visible = new Set<ProductMode>(visibleModes);
  return VIRTUAL_AGENTS.filter((agent) => agent.generalist || visible.has(agent.id));
}

/** The keys from `requested` this agent may bind, in the agent's own order. Anything else is dropped. */
export function toolKeysWithinVirtualAgent(agent: VirtualAgent, requested: readonly string[]): string[] {
  const asked = new Set(requested);
  return agent.tools.filter((key) => asked.has(key));
}

export function virtualAgentMayCall(agent: VirtualAgent, toolKey: string): boolean {
  return agent.tools.includes(toolKey);
}
