"use client";

import { useEffect, useState } from "react";
import { PRODUCT_MODE_IDS, type ProductMode } from "@agentforge/core/product-modes";
import { apiFetch } from "./api-client";
import { parseGatewayBlocked } from "./gateway-gate";
import { t } from "./i18n";
import {
  CHAT_PATH,
  MADE_AGENT_PARAM,
  notifyVirtualAgentsChanged,
  VIRTUAL_AGENTS_CHANGED_EVENT,
} from "./virtual-agents";

export type MadeAgent = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly deletable: boolean;
};

export type AgentDraftFields = {
  name: string;
  description: string;
  instructions: string;
  baseMode: ProductMode;
  tools: string[];
};

export type DraftAnswer = { draft: AgentDraftFields; source: "live" | "stub" };

export type MadeAgentFailure = { kind: "gateway" } | { kind: "message"; key: string };

export type DraftResult = { ok: true; answer: DraftAnswer } | { ok: false; failure: MadeAgentFailure };
export type CreateResult = { ok: true; agent: { id: string; name: string } } | { ok: false; failure: MadeAgentFailure };
export type DeleteResult = { ok: true; agentId: string } | { ok: false; failure: MadeAgentFailure };

const JSON_HEADERS = { "Content-Type": "application/json" };
const NAME_MAX = 80;
const DESCRIPTION_MAX = 200;
const INSTRUCTIONS_MAX = 6000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

function message(key: string): MadeAgentFailure {
  return { kind: "message", key };
}

function errorCode(payload: unknown): string | null {
  return isRecord(payload) && isRecord(payload.error) && typeof payload.error.code === "string"
    ? payload.error.code
    : null;
}

function draftFailure(payload: unknown): MadeAgentFailure {
  if (parseGatewayBlocked(payload)) {
    return { kind: "gateway" };
  }
  switch (errorCode(payload)) {
    case "invalid_request":
      return message("agents.made.error.invalidPrompt");
    case "model_output_invalid":
      return message("agents.made.error.draftInvalid");
    default:
      return message("agents.made.error.draft");
  }
}

function createFailure(payload: unknown): MadeAgentFailure {
  switch (errorCode(payload)) {
    case "invalid_request":
      return message("agents.made.error.invalidAgent");
    case "forbidden":
      return message("agents.made.error.forbidden");
    default:
      return message("agents.made.error.create");
  }
}

function deleteFailure(payload: unknown): MadeAgentFailure {
  switch (errorCode(payload)) {
    case "not_found":
      return message("agents.made.error.notFound");
    case "forbidden":
      return message("agents.made.error.forbidden");
    case "not_deletable":
      return message("agents.made.error.notDeletable");
    case "agent_in_use":
      return message("agents.made.error.inUse");
    default:
      return message("agents.made.error.delete");
  }
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

function readDraft(value: unknown): AgentDraftFields | null {
  if (!isRecord(value)) {
    return null;
  }
  const name = text(value.name, NAME_MAX);
  const instructions = text(value.instructions, INSTRUCTIONS_MAX);
  const baseMode = PRODUCT_MODE_IDS.find((id) => id === value.baseMode);
  if (name === null || instructions === null || baseMode === undefined) {
    return null;
  }
  const description = text(value.description, DESCRIPTION_MAX) ?? "";
  const tools = Array.isArray(value.tools)
    ? value.tools.flatMap((key) => (typeof key === "string" && key.trim().length > 0 ? [key.trim()] : []))
    : [];
  return { name, description, instructions, baseMode, tools };
}

export function readDraftResult(status: number, payload: unknown): DraftResult {
  if (!isOk(status)) {
    return { ok: false, failure: draftFailure(payload) };
  }
  const draft = isRecord(payload) ? readDraft(payload.draft) : null;
  if (draft === null) {
    return { ok: false, failure: message("agents.made.error.draftInvalid") };
  }
  const source = isRecord(payload) && payload.source === "stub" ? "stub" : "live";
  return { ok: true, answer: { draft, source } };
}

export function readCreateResult(status: number, payload: unknown): CreateResult {
  if (!isOk(status)) {
    return { ok: false, failure: createFailure(payload) };
  }
  const agent = isRecord(payload) && isRecord(payload.agent) ? payload.agent : null;
  if (agent === null || typeof agent.id !== "string" || agent.id.length === 0 || typeof agent.name !== "string") {
    return { ok: false, failure: message("agents.made.error.create") };
  }
  return { ok: true, agent: { id: agent.id, name: agent.name } };
}

export function readDeleteResult(status: number, payload: unknown, agentId: string): DeleteResult {
  if (!isOk(status) || !isRecord(payload) || payload.ok !== true) {
    return { ok: false, failure: deleteFailure(payload) };
  }
  return { ok: true, agentId };
}

export function readMadeAgents(payload: unknown): MadeAgent[] {
  const rows = isRecord(payload) && Array.isArray(payload.specialists) ? payload.specialists : [];
  return rows.flatMap((row) => {
    if (!isRecord(row) || row.madeFromPrompt !== true || typeof row.id !== "string" || row.id.length === 0) {
      return [];
    }
    if (typeof row.name !== "string") {
      return [];
    }
    return [
      {
        id: row.id,
        name: row.name,
        description: typeof row.description === "string" ? row.description : "",
        deletable: row.deletable === true,
      },
    ];
  });
}

export function madeAgentHref(agentId: string, threadId?: string | null): string {
  const params = new URLSearchParams({ [MADE_AGENT_PARAM]: agentId });
  if (threadId) {
    params.set("thread", threadId);
  }
  return `${CHAT_PATH}?${params.toString()}`;
}

export function madeAgentIdFromSearch(params: URLSearchParams): string | null {
  const value = params.get(MADE_AGENT_PARAM);
  return value && value.length > 0 ? value : null;
}

export async function fetchMadeAgents(): Promise<MadeAgent[]> {
  const response = await apiFetch("/api/v1/chat");
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(t("agents.error.load"));
  }
  return readMadeAgents(payload);
}

export async function draftMadeAgent(prompt: string): Promise<DraftResult> {
  try {
    const response = await apiFetch("/api/v1/agents/draft", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ prompt }),
    });
    return readDraftResult(response.status, await response.json().catch(() => null));
  } catch {
    return { ok: false, failure: message("agents.made.error.draft") };
  }
}

export async function createMadeAgent(fields: AgentDraftFields): Promise<CreateResult> {
  try {
    const response = await apiFetch("/api/v1/agents", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: fields.name,
        description: fields.description,
        instructions: fields.instructions,
        baseMode: fields.baseMode,
        tools: fields.tools,
      }),
    });
    const result = readCreateResult(response.status, await response.json().catch(() => null));
    if (result.ok) {
      notifyVirtualAgentsChanged();
    }
    return result;
  } catch {
    return { ok: false, failure: message("agents.made.error.create") };
  }
}

export async function deleteMadeAgent(agentId: string): Promise<DeleteResult> {
  try {
    const response = await apiFetch(`/api/v1/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" });
    const result = readDeleteResult(response.status, await response.json().catch(() => null), agentId);
    if (result.ok) {
      notifyVirtualAgentsChanged();
    }
    return result;
  } catch {
    return { ok: false, failure: message("agents.made.error.delete") };
  }
}

let cachedMade: MadeAgent[] | null = null;

export type MadeAgentsState = {
  readonly agents: readonly MadeAgent[];
  readonly loaded: boolean;
};

export function useMadeAgents(): MadeAgentsState {
  const [state, setState] = useState<MadeAgentsState>(() => ({
    agents: cachedMade ?? [],
    loaded: cachedMade !== null,
  }));

  useEffect(() => {
    let cancelled = false;
    function load() {
      fetchMadeAgents()
        .then((agents) => {
          cachedMade = agents;
          if (!cancelled) {
            setState({ agents, loaded: true });
          }
        })
        .catch(() => {
          if (!cancelled) {
            setState((current) => ({ agents: current.agents, loaded: true }));
          }
        });
    }
    load();
    window.addEventListener(VIRTUAL_AGENTS_CHANGED_EVENT, load);
    window.addEventListener("agentforge-shell-refresh", load);
    return () => {
      cancelled = true;
      window.removeEventListener(VIRTUAL_AGENTS_CHANGED_EVENT, load);
      window.removeEventListener("agentforge-shell-refresh", load);
    };
  }, []);

  return state;
}
