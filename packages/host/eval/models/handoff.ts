/**
 * Entry point of `pnpm --filter @agentforge/host eval:models:handoff`. Thin wiring: the work is in
 * `run-handoff.ts`, which the tests drive with fakes. This is the one file that hands the desk's saved key
 * to the real runtime, and only through `GatewayCredentials`. Reads the desk named by AGENTFORGE_DATA_DIR.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ApiError,
  applyCuration,
  createRuntime,
  estimateRunUsd,
  fetchPricingCatalog,
  probeOpenAIModels,
  resolvedGatewayBaseUrl,
} from "@agentforge/core";
import { UsageError } from "./args";
import { EvalRefusal, loadGatewayCredentials, type SettingsLoader } from "./credentials";
import { HANDOFF_USAGE, parseHandoffArgs, runHandoffCommand, type PriceEstimator } from "./run-handoff";

const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "results");
const SYSTEM_IN_MESSAGES_WARNING = "AI SDK Warning: System messages in the prompt or messages fields";

async function main(): Promise<number> {
  const args = parseHandoffArgs(process.argv.slice(2), RESULTS_DIR);
  if (args.help) {
    process.stdout.write(HANDOFF_USAGE);
    return 0;
  }
  // The host's own modules, loaded after the arguments are read.
  const { loadModelCache } = await import("../../src/model-cache");
  const { listProbedModels } = await import("../../src/selectable-models");
  const { chooseTierRun } = await import("../../src/tier-resolve");
  // Only a run that sends needs the desk's settings; a dry run never opens them.
  const loadSettings: SettingsLoader | undefined = args.dryRun
    ? undefined
    : (await import("../../src/settings-store")).loadSettings;

  return runHandoffCommand(args, {
    env: process.env,
    now: () => new Date(),
    nowMs: () => performance.now(),
    readSavedModels: () => {
      const cache = loadModelCache();
      return { models: listProbedModels(cache), probedAt: cache.openaiProbedAt, error: cache.openaiError };
    },
    // The very call the host's own refresh makes for this gateway (`GET <endpoint>/models`), but the
    // answer goes into this run only: the desk's saved cache is never written.
    fetchLiveModels: async (workspace) => {
      if (!loadSettings) {
        throw new EvalRefusal("internal: a live model list was asked for on a run that should not send");
      }
      const credentials = loadGatewayCredentials({ env: process.env, workspace, loadSettings });
      return credentials.withKey((apiKey) => probeOpenAIModels({ baseURL: credentials.baseUrl, apiKey }));
    },
    // The real tier resolver, the one a Chat request that names a tier goes through. It is handed the
    // catalogue as plain ids (text only: that is all this tool sends), never a model id of this file's own.
    resolveTier: (tier, ids) => {
      const catalog = applyCuration(
        ids.map((id) => ({ id, label: id, provider: "openai" as const, inputModalities: ["text" as const] })),
      );
      try {
        const run = chooseTierRun({ tier }, "text", catalog);
        if (!run) {
          // Only a body that names no tier gets null, and this one always names one.
          throw new Error(`The tier resolver gave no answer for ${tier}.`);
        }
        return { model: run.model, reasoning: run.reasoning };
      } catch (error) {
        if (error instanceof ApiError && error.code === "tier_unavailable") {
          return null;
        }
        throw error;
      }
    },
    // The gateway's public, keyless price list, through the same estimator the app's usage panel uses
    // (`pricing.ts` only prints per-million labels, so it cannot give a figure for a call).
    loadPrices: async (): Promise<PriceEstimator> => {
      try {
        const catalog = await fetchPricingCatalog({ baseURL: resolvedGatewayBaseUrl() });
        return {
          estimate: (usage) => estimateRunUsd(usage, catalog),
          note: `from the gateway's public price list (${catalog.models.length} models), at group ratio 1`,
        };
      } catch (error) {
        const why = error instanceof Error && error.message ? error.message : "unknown error";
        return { estimate: undefined, note: `price list unavailable (${why.slice(0, 120)})` };
      }
    },
    // The runtime Chat itself builds (`createRuntime`, packages/host/src/runs.ts), holding only the desk's
    // saved gateway key. The shell's provider variables are removed first (`scrubProviderEnv`).
    makeRuntime: () => {
      if (!loadSettings) {
        throw new EvalRefusal("internal: a runtime was asked for on a run that should not send");
      }
      const credentials = loadGatewayCredentials({ env: process.env, workspace: args.workspace, loadSettings });
      const runtime = credentials.withKey((apiKey) =>
        createRuntime({ openaiApiKey: apiKey }, { image: [], video: [] }),
      );
      // The runtime logs a gateway refusal's text with `console.warn` (already through `redactSecrets`);
      // this makes sure a key a gateway echoed back is not printed by that line either. It also drops the AI
      // SDK's one-line warning, printed on every call, that the system prompt rides in the messages: Chat has
      // the same shape, so it is not news here and it would bury the progress lines.
      const warn = console.warn.bind(console);
      console.warn = (...parts: unknown[]) => {
        if (typeof parts[0] === "string" && parts[0].startsWith(SYSTEM_IN_MESSAGES_WARNING)) {
          return;
        }
        warn(...parts.map((part) => (typeof part === "string" ? credentials.redact(part) : part)));
      };
      return { host: credentials.host, runtime, redact: (text) => credentials.redact(text) };
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    out: (text) => {
      process.stdout.write(text);
    },
  });
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : "The run failed.";
    if (error instanceof UsageError) {
      process.stderr.write(`${message}\n\n${HANDOFF_USAGE}`);
    } else if (error instanceof EvalRefusal) {
      process.stderr.write(`Refused: ${message}\n`);
    } else {
      process.stderr.write(`handoff failed: ${message}\n`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = 2;
  },
);
