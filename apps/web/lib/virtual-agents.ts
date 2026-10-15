"use client";

import { useEffect, useState } from "react";
import { PRODUCT_MODES, type ProductMode } from "@agentforge/core/product-modes";
import { apiFetch } from "./api-client";
import { t } from "./i18n";

/**
 * The desk's virtual agents as the host reports them (`GET /api/v1/virtual-agents`, tester code).
 * One per harness the desk has, the generalist first. The renderer draws this and decides nothing:
 * which agents a desk has, what each may call and its limits are the host's.
 */

export type VirtualAgentSkill = { readonly id: string; readonly name: string; readonly status: "has" | "new" | "off" };

export type VirtualAgentInfo = {
  /** The product mode whose harness this agent is. `chat` is the generalist. */
  readonly id: ProductMode;
  readonly generalist: boolean;
  /** `harness`: it takes messages. `studio`: its conversation is not wired yet, it opens its screen. */
  readonly conversation: "harness" | "studio";
  /** The agent row that owns its threads. Null for a `studio` agent. */
  readonly agentId: string | null;
  readonly loop: "agent" | "pipeline" | "media" | "none";
  readonly tools: readonly string[];
  readonly budget: { readonly maxSteps: number; readonly maxToolCalls: number };
  readonly repairRounds: number;
  readonly skills: readonly VirtualAgentSkill[];
};

const MODE_IDS = new Set<string>(PRODUCT_MODES.map((mode) => mode.id));
const LOOPS = new Set(["agent", "pipeline", "media", "none"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toSkill(value: unknown): VirtualAgentSkill | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") {
    return null;
  }
  const status = value.status === "new" || value.status === "off" ? value.status : "has";
  return { id: value.id, name: value.name, status };
}

/** One row of the host's answer, or null when it is not a shape the screen can draw. */
export function toVirtualAgent(value: unknown): VirtualAgentInfo | null {
  if (!isRecord(value) || typeof value.id !== "string" || !MODE_IDS.has(value.id)) {
    return null;
  }
  const budget = isRecord(value.budget) ? value.budget : {};
  return {
    id: value.id as ProductMode,
    generalist: value.generalist === true,
    conversation: value.conversation === "harness" ? "harness" : "studio",
    agentId: typeof value.agentId === "string" && value.agentId ? value.agentId : null,
    loop: typeof value.loop === "string" && LOOPS.has(value.loop) ? (value.loop as VirtualAgentInfo["loop"]) : "none",
    tools: Array.isArray(value.tools) ? value.tools.filter((key): key is string => typeof key === "string") : [],
    budget: {
      maxSteps: typeof budget.maxSteps === "number" ? budget.maxSteps : 0,
      maxToolCalls: typeof budget.maxToolCalls === "number" ? budget.maxToolCalls : 0,
    },
    repairRounds: typeof value.repairRounds === "number" ? value.repairRounds : 0,
    skills: Array.isArray(value.skills)
      ? value.skills.map(toSkill).filter((skill): skill is VirtualAgentSkill => skill !== null)
      : [],
  };
}

export function readVirtualAgents(payload: unknown): VirtualAgentInfo[] {
  const rows = isRecord(payload) && Array.isArray(payload.agents) ? payload.agents : [];
  return rows.map(toVirtualAgent).filter((agent): agent is VirtualAgentInfo => agent !== null);
}

export type VirtualAgentCatalog = {
  /** On the desk, the generalist first. */
  readonly agents: VirtualAgentInfo[];
  /** Not on the desk: what the Virtual agents page offers to hire. `agentId` is always null here. */
  readonly available: VirtualAgentInfo[];
};

export function readVirtualAgentCatalog(payload: unknown): VirtualAgentCatalog {
  const rows = isRecord(payload) && Array.isArray(payload.available) ? payload.available : [];
  return {
    agents: readVirtualAgents(payload),
    available: rows.map(toVirtualAgent).filter((agent): agent is VirtualAgentInfo => agent !== null),
  };
}

export async function fetchVirtualAgentCatalog(): Promise<VirtualAgentCatalog> {
  const response = await apiFetch("/api/v1/virtual-agents");
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(t("agents.error.load"));
  }
  return readVirtualAgentCatalog(payload);
}

export async function fetchVirtualAgents(): Promise<VirtualAgentInfo[]> {
  return (await fetchVirtualAgentCatalog()).agents;
}

/** Fired after the desk's agents changed (one was hired or let go), so every list reads again. */
export const VIRTUAL_AGENTS_CHANGED_EVENT = "agentforge-virtual-agents-changed";

export function notifyVirtualAgentsChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(VIRTUAL_AGENTS_CHANGED_EVENT));
  }
}

/** The last answer, so a second list on screen (the rail, the page) draws at once instead of blank. */
let cached: VirtualAgentInfo[] | null = null;

export type VirtualAgentsState = {
  readonly agents: readonly VirtualAgentInfo[];
  /** False until the host has answered once in this page load. */
  readonly loaded: boolean;
  readonly error: string | null;
};

export function useVirtualAgents(): VirtualAgentsState {
  const [state, setState] = useState<VirtualAgentsState>(() => ({
    agents: cached ?? [],
    loaded: cached !== null,
    error: null,
  }));

  useEffect(() => {
    let cancelled = false;
    function load() {
      fetchVirtualAgents()
        .then((agents) => {
          cached = agents;
          if (!cancelled) {
            setState({ agents, loaded: true, error: null });
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setState((current) => ({
              agents: current.agents,
              loaded: true,
              error: error instanceof Error ? error.message : t("agents.error.load"),
            }));
          }
        });
    }
    load();
    window.addEventListener(VIRTUAL_AGENTS_CHANGED_EVENT, load);
    // A desk switch or a shell refresh changes which agents there are.
    window.addEventListener("agentforge-shell-refresh", load);
    return () => {
      cancelled = true;
      window.removeEventListener(VIRTUAL_AGENTS_CHANGED_EVENT, load);
      window.removeEventListener("agentforge-shell-refresh", load);
    };
  }, []);

  return state;
}

/**
 * The name on screen. The default agent is the brand's character (owner, 2026-10-09): callers pass
 * `assistantNameOf(brand)`, which is the product's name unless the brand names its character. Every
 * other agent is named for its mode. No brand is typed here.
 */
export function virtualAgentName(agent: Pick<VirtualAgentInfo, "id" | "generalist">, characterName: string): string {
  return agent.generalist ? characterName : t(`rail.${agent.id}`);
}

export function virtualAgentTagline(agent: Pick<VirtualAgentInfo, "id">): string {
  return t(`agents.tagline.${agent.id}`);
}

export const CHAT_PATH = "/chat";

/**
 * Where an agent lives. Every agent, the generalist included, is `/chat`: the generalist with no
 * `agent` parameter (so old `/chat?thread=` links keep working), the others with `?agent=<mode>`.
 */
export function virtualAgentHref(id: ProductMode, threadId?: string | null): string {
  const params = new URLSearchParams();
  if (id !== "chat") {
    params.set("agent", id);
  }
  if (threadId) {
    params.set("thread", threadId);
  }
  const query = params.toString();
  return query ? `${CHAT_PATH}?${query}` : CHAT_PATH;
}

/** The agent a `/chat` URL names. An unknown or missing `agent` is the generalist. */
export function agentIdFromSearch(params: URLSearchParams): ProductMode {
  const value = params.get("agent");
  return value && MODE_IDS.has(value) ? (value as ProductMode) : "chat";
}

export const MADE_AGENT_PARAM = "made";

/**
 * Which agent the current route belongs to, for the rail's highlight: the one `/chat` names, or the
 * one whose studio screen is open. Null on an account page (Knowledge, Settings and so on).
 */
export function activeAgentId(pathname: string, params: URLSearchParams): ProductMode | null {
  if (pathname === CHAT_PATH) {
    return params.get(MADE_AGENT_PARAM) ? null : agentIdFromSearch(params);
  }
  const studio = PRODUCT_MODES.find(
    (mode) => mode.id !== "chat" && (pathname === mode.href || pathname.startsWith(`${mode.href}/`)),
  );
  return studio ? studio.id : null;
}

export function studioHref(id: ProductMode): string {
  return PRODUCT_MODES.find((mode) => mode.id === id)?.href ?? CHAT_PATH;
}
