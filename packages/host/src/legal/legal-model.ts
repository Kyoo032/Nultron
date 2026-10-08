/**
 * The gateway side of the Legal routes that read documents: is a live model configured, which model, and one
 * `ask` function the engines call. Shared by the extraction and the ask routes (and, for the stub check, the
 * full review), so they answer a keyless desk the same way and record the model that really answered.
 */
import { ApiError, hasLiveProvider, resolveChatModel, resolveRuntimeMode, type TenantContext } from "@agentforge/core";
import { legalOutputCopy } from "@agentforge/core/legal";
import { collectJobAssistantRun } from "../job-regen";
import { localeForRun } from "../run-context";
import { listSelectableModels, modeDefaultsFor } from "../selectable-models";
import { loadSettings } from "../settings-store";

/** A keyless desk records the stub runtime: refuse with the sentence that says what to do about it. */
export function requireLegalLive(tenant: TenantContext): ReturnType<typeof loadSettings> {
  const settings = loadSettings(tenant);
  const mode = resolveRuntimeMode({
    settingsHasKey: hasLiveProvider(settings),
    envRuntime: process.env.AGENTFORGE_RUNTIME,
  });
  if (mode === "stub") {
    throw new ApiError("runtime_stub", legalOutputCopy(localeForRun()).stubError, 503);
  }
  return settings;
}

/** The model for a Legal call: the one the person picked, else the desk's Legal default. */
export function resolveLegalModel(tenant: TenantContext, requested: string | undefined): string {
  return resolveChatModel(requested, modeDefaultsFor(tenant).legal, listSelectableModels(tenant));
}

export type LegalAsk = (args: { model: string; system: string; prompt: string }) => Promise<string>;

export type LegalAskBinding = {
  readonly ask: LegalAsk;
  /** The model that answered the last call made with `model`: after a fallback, the stand-in. */
  answered(model: string): string;
};

/**
 * `ask` for the engines: one gateway call through the job fallback. A picked model is never swapped
 * (`pinned`); `runId` groups the calls of one run.
 */
export function createLegalAsk(
  tenant: TenantContext,
  options: { readonly runId: string; readonly pinned: boolean; readonly abortSignal?: AbortSignal },
): LegalAskBinding {
  let answeredFor: Readonly<Record<string, string>> = {};
  return {
    ask: async ({ model, system, prompt }) => {
      const run = await collectJobAssistantRun({
        tenant,
        model,
        modelExplicit: options.pinned,
        systemPrompt: system,
        runPrefix: "legal",
        agentId: "legal",
        jobMode: "legal",
        versionId: options.runId,
        prompt,
        ...(options.abortSignal ? { signal: options.abortSignal } : {}),
      });
      answeredFor = { ...answeredFor, [model]: run.model };
      return run.text;
    },
    answered: (model) => answeredFor[model] ?? model,
  };
}
