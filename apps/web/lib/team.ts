"use client";

import { useEffect, useState } from "react";
import { isProductMode, PRODUCT_MODE_IDS, type ProductMode } from "@agentforge/core/product-modes";
import { apiFetch } from "./api-client";
import { t } from "./i18n";

/**
 * The owner's team as the host reports it (`/api/v1/team`, the orchestrator demo). Specialists are
 * product modes the desk can delegate to; bots are custom agents with their own `tb-` chat address.
 * The renderer draws the answer and decides nothing: who may be hired, what a bot may call and what
 * it answers are the host's.
 */

export type TeamBotSlug = `tb-${string}`;

/** A hired bot as `GET /api/v1/team` and `POST /api/v1/team/hire` report it. */
export type TeamBotView = {
  /** The agents row that owns the bot's threads. */
  readonly id: string;
  readonly slug: TeamBotSlug;
  readonly name: string;
  readonly role: string;
  readonly description: string;
};

/** The bot shape a proposal or a hire sends: the prompt is the bot's whole instruction. */
export type TeamBotInput = {
  readonly name: string;
  readonly role: string;
  readonly prompt: string;
};

export type TeamProposal = {
  readonly brief: string;
  readonly modes: readonly ProductMode[];
  readonly bots: readonly TeamBotInput[];
};

export type TeamRoster = {
  readonly modes: readonly ProductMode[];
  readonly bots: readonly TeamBotView[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A `/chat?agent=` value that names a team bot, never a product mode. */
export function isTeamBotParam(value: string): value is TeamBotSlug {
  return value.startsWith("tb-") && value.length > 3;
}

function toTeamBotSlug(value: unknown): TeamBotSlug | null {
  return typeof value === "string" && isTeamBotParam(value) ? value : null;
}

function toMode(value: unknown): ProductMode | null {
  return typeof value === "string" && isProductMode(value) ? value : null;
}

function readModes(value: unknown): ProductMode[] {
  const seen = new Set<ProductMode>();
  for (const item of Array.isArray(value) ? value : []) {
    const mode = toMode(item);
    if (mode) {
      seen.add(mode);
    }
  }
  return PRODUCT_MODE_IDS.filter((id) => seen.has(id));
}

/** One bot row of the host's answer, or null when it is not a shape the rail and chat can use. */
export function toTeamBot(value: unknown): TeamBotView | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = readString(value.id);
  const slug = toTeamBotSlug(value.slug);
  const name = readString(value.name);
  if (!id || !slug || !name) {
    return null;
  }
  return {
    id,
    slug,
    name,
    role: typeof value.role === "string" ? value.role : "",
    description: typeof value.description === "string" ? value.description : "",
  };
}

function toTeamBotInput(value: unknown): TeamBotInput | null {
  if (!isRecord(value)) {
    return null;
  }
  const name = readString(value.name);
  if (!name) {
    return null;
  }
  return {
    name,
    role: typeof value.role === "string" ? value.role : "",
    prompt: typeof value.prompt === "string" ? value.prompt : "",
  };
}

function readBots(value: unknown): TeamBotView[] {
  return (Array.isArray(value) ? value : []).map(toTeamBot).filter((bot): bot is TeamBotView => bot !== null);
}

function readBotInputs(value: unknown): TeamBotInput[] {
  return (Array.isArray(value) ? value : [])
    .map(toTeamBotInput)
    .filter((bot): bot is TeamBotInput => bot !== null);
}

export function readTeamRoster(payload: unknown): TeamRoster {
  const body = isRecord(payload) ? payload : {};
  return { modes: readModes(body.modes), bots: readBots(body.bots) };
}

export function readTeamProposal(payload: unknown): TeamProposal {
  const body = isRecord(payload) ? payload : {};
  return {
    brief: typeof body.brief === "string" ? body.brief : "",
    modes: readModes(body.modes),
    bots: readBotInputs(body.bots),
  };
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function fail(key: string): never {
  throw new Error(t(key));
}

export async function fetchTeam(): Promise<TeamRoster> {
  const response = await apiFetch("/api/v1/team");
  const payload = await readJson(response);
  if (!response.ok) {
    fail("team.error.load");
  }
  return readTeamRoster(payload);
}

export async function proposeTeam(brief: string): Promise<TeamProposal> {
  const response = await apiFetch("/api/v1/team/propose", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brief: brief.trim() }),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    fail("team.error.propose");
  }
  return readTeamProposal(payload);
}

export type TeamHireInput = {
  readonly modes?: readonly ProductMode[];
  readonly bots?: readonly TeamBotInput[];
};

export async function hireTeam(input: TeamHireInput): Promise<TeamRoster> {
  const response = await apiFetch("/api/v1/team/hire", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    fail("team.error.hire");
  }
  return readTeamRoster(payload);
}

/** What one release names: a specialist mode, or a bot by its `tb-` slug. */
export type TeamReleaseTarget = { readonly mode: ProductMode } | { readonly bot: TeamBotSlug };

export async function releaseTeam(target: TeamReleaseTarget): Promise<TeamRoster> {
  const response = await apiFetch("/api/v1/team/release", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify("mode" in target ? { mode: target.mode } : { bot: target.bot }),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    fail("team.error.release");
  }
  return readTeamRoster(payload);
}

const CHAT_PATH = "/chat";

/** The agent id a bot's chat address carries. A slug that already has `tb-` is used as it is. */
export function teamBotAgent(slug: string): TeamBotSlug {
  return isTeamBotParam(slug) ? slug : (`tb-${slug}` as TeamBotSlug);
}

export function teamBotHref(slug: string, threadId?: string | null): string {
  const params = new URLSearchParams();
  params.set("agent", teamBotAgent(slug));
  if (threadId) {
    params.set("thread", threadId);
  }
  return `${CHAT_PATH}?${params.toString()}`;
}

/** Fired after the team changed (hired, let go, proposed and hired), so every list reads again. */
export const TEAM_CHANGED_EVENT = "agentforge-team-changed";

export function notifyTeamChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(TEAM_CHANGED_EVENT));
  }
}

/** The last answer, so the rail and the page draw at once instead of blank. */
let cached: TeamRoster | null = null;

export type TeamState = {
  readonly roster: TeamRoster;
  /** False until the host has answered once in this page load. */
  readonly loaded: boolean;
  readonly error: string | null;
};

const EMPTY_ROSTER: TeamRoster = { modes: [], bots: [] };

export function useTeam(): TeamState {
  const [state, setState] = useState<TeamState>(() => ({
    roster: cached ?? EMPTY_ROSTER,
    loaded: cached !== null,
    error: null,
  }));

  useEffect(() => {
    let cancelled = false;
    function load() {
      fetchTeam()
        .then((roster) => {
          cached = roster;
          if (!cancelled) {
            setState({ roster, loaded: true, error: null });
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setState((current) => ({
              roster: current.roster,
              loaded: true,
              error: error instanceof Error ? error.message : t("team.error.load"),
            }));
          }
        });
    }
    load();
    window.addEventListener(TEAM_CHANGED_EVENT, load);
    // A desk switch or a shell refresh changes which specialists and bots there are.
    window.addEventListener("agentforge-shell-refresh", load);
    return () => {
      cancelled = true;
      window.removeEventListener(TEAM_CHANGED_EVENT, load);
      window.removeEventListener("agentforge-shell-refresh", load);
    };
  }, []);

  return state;
}
