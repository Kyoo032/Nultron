import { DELEGABLE_AGENTS, type DelegableAgent } from "./delegation";
import { PRODUCT_MODE_IDS, type ProductMode } from "./product-modes";

/**
 * Team bots: custom agents a desk hires next to the catalog specialists, so the orchestrator
 * (`delegate`) has more than the mode list to hand work to. A bot is an ordinary agent row whose
 * published version carries `config.teamBot === true` and a `role`; its slug always starts with
 * `tb-` so it can never collide with a mode agent's `va-` row or the default chat.
 *
 * This file holds what core owns: the slug rules, the wire shapes the host and the renderer share,
 * the deterministic proposal (the fallback when no model is reachable), and the boundary
 * validation the team routes run their bodies through. The rows and the routes are the host's
 * (`packages/host/src/team-bots.ts`, `handlers/team.ts`).
 */

export const TEAM_BOT_SLUG_PREFIX = "tb-";

/** The published version's `config` keys that mark a row as a team bot. */
export const TEAM_BOT_CONFIG_KEY = "teamBot";
export const TEAM_BOT_ROLE_KEY = "role";

/** The most bots one desk may hold. A proposal may draft fewer; the hire route caps at this. */
export const MAX_TEAM_BOTS = 4;

export const TEAM_BOT_NAME_MAX = 60;
export const TEAM_BOT_ROLE_MAX = 120;
export const TEAM_BOT_PROMPT_MAX = 4_000;

/** One hired bot, as the team routes and the renderer see it. */
export type TeamBotView = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly role: string;
  readonly description: string;
};

/** A bot the owner (or the proposer) wants hired: name, one-line role, and its system prompt. */
export type TeamBotProposal = {
  readonly name: string;
  readonly role: string;
  readonly prompt: string;
};

/** What `POST /api/v1/team/propose` answers: the modes to hire and the bots to draft. */
export type TeamProposal = {
  readonly brief: string;
  readonly modes: ProductMode[];
  readonly bots: TeamBotProposal[];
};

/** Who `delegate` may ask right now: the desk's hired modes and its live bots. */
export type TeamRoster = {
  readonly modes: ProductMode[];
  readonly bots: TeamBotView[];
};

/** True for a slug a team bot owns (`tb-<name>`). */
export function isTeamBotSlug(slug: string): boolean {
  return slug.startsWith(TEAM_BOT_SLUG_PREFIX) && slug.length > TEAM_BOT_SLUG_PREFIX.length;
}

/**
 * The slug suffix of a bot's name: lowercase, every run of non-letters/digits one dash, trimmed,
 * capped so `tb-` plus the suffix stays a short handle the model can pass to `delegate`. Falls back
 * to `bot` for a name with nothing slug-able in it.
 */
export function teamBotSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "bot";
}

/**
 * A proposal body parsed at the boundary: strings only, trimmed, cut to the field caps. Null when
 * there is no usable name or prompt — a bot with neither is not a bot.
 */
export function sanitizeTeamBotProposal(value: unknown): TeamBotProposal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim().slice(0, TEAM_BOT_NAME_MAX) : "";
  const role = typeof record.role === "string" ? record.role.trim().slice(0, TEAM_BOT_ROLE_MAX) : "";
  const prompt = typeof record.prompt === "string" ? record.prompt.trim().slice(0, TEAM_BOT_PROMPT_MAX) : "";
  if (!name || !prompt) {
    return null;
  }
  return { name, role, prompt };
}

/**
 * Which catalog modes a brief points at, as word matches. A mode scores one per keyword the brief
 * contains; ties keep catalog order. Substring-safe: keywords are matched on word boundaries so
 * "art" does not fire on "start".
 */
const MODE_KEYWORDS: Readonly<Record<DelegableAgent, readonly string[]>> = {
  research: ["research", "report", "briefing", "study", "investigate", "dossier", "sources"],
  documents: ["document", "memo", "letter", "proposal", "write", "writing", "draft", "brief"],
  finance: ["finance", "budget", "cash", "invoice", "accounting", "money", "cost", "revenue", "forecast"],
  data: ["data", "spreadsheet", "csv", "table", "dataset", "statistics", "analyze", "analysis", "chart"],
  market: ["market", "price", "prices", "competitor", "industry", "trend", "stock"],
  legal: ["legal", "contract", "clause", "law", "compliance", "agreement", "terms"],
  meeting: ["meeting", "minutes", "transcript", "agenda", "call notes"],
  images: ["image", "images", "picture", "photo", "illustration", "logo", "artwork"],
  videos: ["video", "videos", "clip", "clips", "film", "footage"],
  music: ["music", "song", "songs", "lyric", "lyrics", "jingle", "soundtrack"],
  edit: ["edit", "editing", "cut", "cuts", "caption", "captions", "timeline"],
  presentations: ["deck", "decks", "slide", "slides", "presentation", "pitch"],
  education: ["teach", "teaching", "lesson", "lessons", "course", "quiz", "study", "training", "tutorial"],
};

const MODE_PATTERNS: ReadonlyArray<{ mode: DelegableAgent; patterns: readonly RegExp[] }> = DELEGABLE_AGENTS.map(
  (mode) => ({
    mode,
    patterns: MODE_KEYWORDS[mode].map(
      (keyword) => new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
    ),
  }),
);

/** Up to five modes the brief's keywords point at, best score first, catalog order on ties. */
function scoredModes(brief: string): DelegableAgent[] {
  return MODE_PATTERNS.map(({ mode, patterns }) => ({
    mode,
    score: patterns.reduce((count, pattern) => count + (pattern.test(brief) ? 1 : 0), 0),
  }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || DELEGABLE_AGENTS.indexOf(a.mode) - DELEGABLE_AGENTS.indexOf(b.mode),
    )
    .slice(0, 5)
    .map((entry) => entry.mode);
}

/** The brief as the bots' shared context: its first sentence, capped so a prompt stays small. */
function briefDomain(brief: string): string {
  const first = (brief.trim().split(/(?<=[.!?])\s+/)[0] ?? brief.trim()).trim();
  return first.length > 80 ? `${first.slice(0, 79).trimEnd()}…` : first || "the owner's work";
}

/**
 * The three bots a desk can always use, drafted from the brief. They cover the work a mode
 * specialist does not: reading the brief for what is known and missing, writing it up, and
 * checking the result. A proposal may carry fewer; these are the deterministic floor.
 */
const DRAFT_BOTS: ReadonlyArray<{ name: string; role: string; focus: string }> = [
  {
    name: "Analyst",
    role: "Pulls the facts and the open questions out of a brief",
    focus:
      "read the owner's brief and the material it names, then answer with what is known, what is assumed and what is missing, facts first",
  },
  {
    name: "Writer",
    role: "Turns findings into clear documents and messages",
    focus:
      "write the finished piece in full, in clean Markdown with headings, in the language the owner writes in, and save it with write_file when asked to keep it",
  },
  {
    name: "Checker",
    role: "Reviews work for gaps, errors and missing sources",
    focus:
      "check claims against the sources they cite, say plainly what could not be verified, and never claim a check that did not run",
  },
];

function draftBots(brief: string): TeamBotProposal[] {
  const domain = briefDomain(brief);
  return DRAFT_BOTS.map((bot) => ({
    name: bot.name,
    role: bot.role,
    prompt: `You are ${bot.name}, a specialist bot on a one-person company's desk. The company works on: ${domain}. Your job: ${bot.focus}. You cannot see the orchestrator's chat, so a task must carry everything you need; when it does not, make reasonable assumptions and say what you assumed.`,
  }));
}

/**
 * The proposal when no model answers: modes scored from the brief's keywords (never empty —
 * research and documents are the desk's default hires), plus the three drafted bots.
 */
export function proposeTeamDeterministic(brief: string): TeamProposal {
  const text = brief.trim();
  const scored = scoredModes(text);
  const modes: ProductMode[] = scored.length > 0 ? scored : ["research", "documents"];
  return { brief: text, modes, bots: draftBots(text) };
}

/** The catalog order of `modes`, so a stored list reads the same however it was built. */
export function teamProposalModes(modes: unknown): ProductMode[] {
  const seen = new Set<string>();
  if (!Array.isArray(modes)) {
    return [];
  }
  for (const mode of modes) {
    if (typeof mode === "string" && (PRODUCT_MODE_IDS as readonly string[]).includes(mode)) {
      seen.add(mode);
    }
  }
  return PRODUCT_MODE_IDS.filter((id) => seen.has(id));
}
