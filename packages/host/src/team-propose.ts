import {
  createRuntime,
  isDelegableAgent,
  proposeTeamDeterministic,
  sanitizeTeamBotProposal,
  teamProposalModes,
  type AgentVersionRecord,
  type TenantContext,
  type TeamBotProposal,
  type TeamProposal,
} from "@agentforge/core";
import { DEFAULT_MODEL_TIER } from "@agentforge/core/tiers";
import { requireGatewayAllowed } from "./gateway-gate";
import { loadSettings } from "./settings-store";
import { listSelectableModels, toolMediaModels } from "./selectable-models";
import { chooseTierRun } from "./tier-resolve";
import { localeForRun } from "./run-context";
import { recordChatRunUsage } from "./usage-record";

/**
 * `POST /api/v1/team/propose`: one model call that reads the owner's brief and answers which
 * specialist modes to hire plus up to three drafted bots, as strict JSON. Every failure — no
 * reachable model, a timeout, prose instead of JSON, fields out of bounds — falls back to
 * `proposeTeamDeterministic`, so the route always answers a usable proposal.
 */

/** How long the one-shot proposal call may take before the deterministic answer is used. */
const PROPOSE_TIMEOUT_MS = 45_000;

/** The most bots a proposal may carry; `MAX_TEAM_BOTS` bounds what a desk holds at once. */
const PROPOSE_MAX_BOTS = 3;

const MODE_CATALOG = [
  "research — Research: research questions, reports, briefings, sourced dossiers",
  "documents — Documents: briefs, reports, letters, proposals, writing",
  "finance — Finance: budgets, ratios, cash flow, figures the owner attached",
  "data — Data: tables, spreadsheets, analysis in code",
  "market — Market: prices, competitors, industry news",
  "legal — Legal: contracts, clauses, compliance reading",
  "meeting — Meeting: transcripts and notes into minutes and actions",
  "images — Images: pictures, illustrations, logos",
  "videos — Videos: short clips",
  "music — Music: songs, lyrics, music briefs",
  "edit — Edit: video editing plans, cuts, captions",
  "presentations — Presentation: slide decks and pitches",
  "education — Education: lessons, quizzes, study material",
].join("\n");

export const TEAM_PROPOSE_PROMPT = [
  "You staff a one-person company's desk. From the owner's brief, choose which specialist modes to hire and draft custom bots for the work the specialists do not cover.",
  "",
  "Modes you may choose (id — what it does):",
  MODE_CATALOG,
  "",
  "Answer with JSON only, no prose and no code fence:",
  '{"modes":["research"],"bots":[{"name":"Analyst","role":"one line","prompt":"the bot\'s system prompt"}]}',
  "",
  "Rules: modes is 1 to 5 ids from the list above, most useful first. bots is 0 to 3 entries; each bot needs a name of at most 60 characters, a role of at most 120, and a prompt of at most 4000 that says who the bot is and how it works for this company. Bots should not repeat what a mode already does.",
].join("\n");

/** The first `{...}` block of the reply, parsed; null when there is none or it is not an object. */
function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** A parsed proposal with every field re-validated at the boundary; null when nothing usable came back. */
function parseProposal(text: string, brief: string): TeamProposal | null {
  const value = extractJson(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const modes = teamProposalModes(Array.isArray(record.modes) ? record.modes : []).filter(isDelegableAgent);
  const bots = (Array.isArray(record.bots) ? record.bots : [])
    .map((bot) => sanitizeTeamBotProposal(bot))
    .filter((bot): bot is TeamBotProposal => bot !== null)
    .slice(0, PROPOSE_MAX_BOTS);
  if (modes.length === 0 && bots.length === 0) {
    return null;
  }
  return { brief, modes, bots };
}

/** The synthetic version the one-shot call runs under: the propose prompt and the resolved model. */
function proposalVersion(tenant: TenantContext, model: string, prompt: string): AgentVersionRecord {
  return {
    id: `team-propose-${crypto.randomUUID()}`,
    agentId: "team-propose",
    organizationId: tenant.organizationId,
    version: 1,
    systemPrompt: prompt,
    model,
    inputModalities: ["text"],
    productModes: ["chat"],
    config: {},
    createdAt: new Date(),
  };
}

/**
 * The model-drafted proposal, or the deterministic one. The gateway gate and plan entitlement run
 * first and propagate refusals (`403 gateway_blocked`, plan blocks) rather than swallowing them into
 * the deterministic fallback; `chooseTierRun` throwing or a model failure / unparseable reply still
 * falls back.
 */
export async function proposeTeam(tenant: TenantContext, brief: string): Promise<TeamProposal> {
  const settings = loadSettings(tenant);
  requireGatewayAllowed(settings, { tenant });
  const fallback = () => proposeTeamDeterministic(brief);
  try {
    const catalog = listSelectableModels(tenant);
    const tier = chooseTierRun({ tier: DEFAULT_MODEL_TIER }, "text", catalog);
    if (!tier) {
      return fallback();
    }
    const runId = `team-propose-${crypto.randomUUID()}`;
    let text = "";
    let usageRecorded = false;
    await createRuntime(settings, toolMediaModels(tenant)).execute({
      tenant,
      runId,
      modality: "text",
      version: proposalVersion(tenant, tier.model, TEAM_PROPOSE_PROMPT),
      bindings: [],
      history: [{ role: "user", parts: [{ type: "text", text: brief }] }],
      thinking: false,
      locale: localeForRun(),
      signal: AbortSignal.timeout(PROPOSE_TIMEOUT_MS),
      budget: { maxSteps: 1, maxToolCalls: 0 },
      onEvent: (event) => {
        if (event.type === "assistant.delta") {
          text += event.text;
        } else if (event.type === "run.completed" && !usageRecorded) {
          usageRecorded = true;
          try {
            recordChatRunUsage(tenant, runId, true, (event.usage as Record<string, unknown> | undefined) ?? null);
          } catch {
            // The ledger never fails a proposal; `recordUsage` logs its own failure.
          }
        }
      },
    });
    return parseProposal(text, brief) ?? fallback();
  } catch {
    return fallback();
  }
}
