import { z } from "zod";
import {
  defineTool,
  harnessSpecFor,
  isServerMode,
  PRODUCT_MODE_IDS,
  type GatewayGatePayload,
  type GatewayGateStatus,
  type ProductMode,
  type TenantContext,
} from "@agentforge/core";
import { codeRunsEnabled } from "./code-runner/enabled";
import { checkShip, type ShipStatus } from "./code-runner/ship";
import { type BinaryStatus, resolveFfmpegAsync, resolveFfprobeAsync } from "./edit/ffmpeg-binary";
import { reportGatewayGate } from "./gateway-gate";
import { loadSettings } from "./settings-store";
import { currentToolRun } from "./tool-run-context";

/**
 * What `self_check` tells Chat: facts about what is in place on this desk right now, so the model can say
 * why something is unavailable instead of guessing. Every field is a boolean, a count or a word the host
 * chose. Nothing here is a path, a key, an id, a version or a message from a failed probe: this answer is
 * shown on screen, stored with the thread and read by the model, so it is the facts and no more.
 */
export type SelfCheckReport = {
  ok: true;
  server_mode: boolean;
  /** Null when the desk's gate could not be read. */
  gateway: { status: GatewayGateStatus; allowed: boolean; grace: boolean } | null;
  /** `not_checked`: code runs are off, so the sandbox's files were not read for this answer. */
  code_runs: {
    enabled: boolean;
    sandbox: "ready" | "missing" | "unusable" | "not_checked";
    python: boolean;
    javascript: boolean;
  };
  media_tools: { ffmpeg: boolean; ffprobe: boolean };
  /** Tools this run does not offer: turned off in Settings, or off by the server (code runs). */
  tools_not_offered: string[];
  /** The step and tool-call limits of this run's mode. Null outside a run. */
  run_limits: { max_steps: number; max_tool_calls: number; per_tool: Record<string, number> } | null;
};

/** The reads a report makes, behind one seam so a test can supply each fact. */
export type SelfCheckDeps = {
  serverMode: () => boolean;
  gate: (tenant: TenantContext) => Pick<GatewayGatePayload, "status" | "allowed" | "grace">;
  codeRunsEnabled: () => boolean;
  ship: () => Promise<ShipStatus>;
  ffmpeg: () => Promise<Pick<BinaryStatus, "found">>;
  ffprobe: () => Promise<Pick<BinaryStatus, "found">>;
  notOffered: (tenant: TenantContext) => string[];
};

export const defaultSelfCheckDeps: SelfCheckDeps = {
  serverMode: () => isServerMode(),
  gate: (tenant) => reportGatewayGate(loadSettings(tenant), { tenant }),
  codeRunsEnabled: () => codeRunsEnabled(),
  ship: () => checkShip(),
  ffmpeg: () => resolveFfmpegAsync(),
  ffprobe: () => resolveFfprobeAsync(),
  notOffered: (tenant) => [...(loadSettings(tenant).disabledTools ?? [])],
};

/** One fact, or `fallback` when reading it fails. A broken probe must not make the whole report fail. */
async function readFact<T>(read: () => T | Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

function isProductMode(mode: string): mode is ProductMode {
  return (PRODUCT_MODE_IDS as readonly string[]).includes(mode);
}

function runLimits(): SelfCheckReport["run_limits"] {
  const mode = currentToolRun()?.mode;
  if (!mode || !isProductMode(mode)) {
    return null;
  }
  const budget = harnessSpecFor(mode).budget;
  return { max_steps: budget.maxSteps, max_tool_calls: budget.maxToolCalls, per_tool: { ...(budget.perTool ?? {}) } };
}

function codeRunFacts(ship: ShipStatus): Pick<SelfCheckReport["code_runs"], "sandbox" | "python" | "javascript"> {
  if (!ship.ok) {
    return {
      sandbox: ship.why === "missing" ? "missing" : "unusable",
      python: false,
      javascript: false,
    };
  }
  return { sandbox: "ready", python: ship.languages.has("python"), javascript: ship.languages.has("javascript") };
}

/**
 * The sandbox check hashes every file of the ship directory the first time it runs in a process, which is
 * work for a tool the model cannot call while code runs are off. It is skipped then, and the report says so.
 */
async function codeRunsFact(enabled: boolean, deps: SelfCheckDeps): Promise<SelfCheckReport["code_runs"]> {
  if (!enabled) {
    return { enabled, sandbox: "not_checked", python: false, javascript: false };
  }
  const ship = await readFact<ShipStatus>(() => deps.ship(), { ok: false, why: "unreadable" });
  return { enabled, ...codeRunFacts(ship) };
}

export async function collectSelfCheck(
  tenant: TenantContext,
  deps: SelfCheckDeps = defaultSelfCheckDeps,
): Promise<SelfCheckReport> {
  const enabled = await readFact(() => deps.codeRunsEnabled(), false);
  const [gate, codeRuns, ffmpeg, ffprobe, notOffered] = await Promise.all([
    readFact(() => deps.gate(tenant), null),
    codeRunsFact(enabled, deps),
    readFact(() => deps.ffmpeg(), { found: false }),
    readFact(() => deps.ffprobe(), { found: false }),
    readFact(() => deps.notOffered(tenant), []),
  ]);
  return {
    ok: true,
    server_mode: await readFact(() => deps.serverMode(), false),
    // Copied field by field: the gate also carries the endpoint, times and a technical message.
    gateway: gate ? { status: gate.status, allowed: gate.allowed, grace: gate.grace } : null,
    code_runs: codeRuns,
    media_tools: { ffmpeg: ffmpeg.found, ffprobe: ffprobe.found },
    tools_not_offered: notOffered,
    run_limits: runLimits(),
  };
}

/** The tool over a given set of reads. Tests pass their own probes; the product uses `defaultSelfCheckDeps`. */
export function createSelfCheckTool(deps: SelfCheckDeps) {
  return defineTool({
    key: "self_check",
    name: "Self check",
    description:
      "Read-only report of what is in place on this desk right now, as facts: whether the gateway key works, whether " +
      "code runs are on and the sandbox is present, whether ffmpeg and ffprobe are installed, whether this is the " +
      "hosted server, which tools this run does not offer, and the step and tool-call limits of this run. " +
      "Call it when a tool fails or is unavailable and you want to know why, before you tell the person something " +
      "cannot be done. It changes nothing and takes no arguments.",
    schema: z.object({}).strict(),
    execute: (_args, tenant) => collectSelfCheck(tenant, deps),
  });
}

export const selfCheckTool = createSelfCheckTool(defaultSelfCheckDeps);
