import {
  ApiError,
  enhanceSystemPrompt,
  enhanceUserPrompt,
  hasLiveProvider,
  isEnhanceSurface,
  isServerMode,
  resolveChatModel,
  resolveRuntimeMode,
  stubEnhancePrompt,
  stripWrappingQuotes,
} from "@agentforge/core";
import type { HostRequest, HostResult } from "../types";
import { jsonError, jsonOk } from "../errors";
import { getTenant } from "../tenant";
import { loadSettings } from "../settings-store";
import { requireGatewayAllowed } from "../gateway-gate";
import { getBootLocale } from "../locale-boot";
import { collectJobAssistantText } from "../job-regen";
import { listSelectableModels, modeDefaultsFor } from "../selectable-models";

function readText(body: unknown): string {
  if (!body || typeof body !== "object") {
    throw new ApiError("empty_input", "text is required", 400);
  }
  const text = (body as { text?: unknown }).text;
  if (typeof text !== "string" || !text.trim()) {
    throw new ApiError("empty_input", "text is required", 400);
  }
  return text.trim();
}

export async function handlePostEnhancePrompt(request: HostRequest): Promise<HostResult> {
  try {
    const text = readText(request.body ?? null);
    const rawSurface =
      request.body && typeof request.body === "object" ? (request.body as { surface?: unknown }).surface : "chat";
    const surface = isEnhanceSurface(rawSurface) ? rawSurface : "chat";
    const tenant = await getTenant(request);
    const settings = loadSettings(tenant);
    const locale = getBootLocale();
    const mode = resolveRuntimeMode({
      settingsHasKey: hasLiveProvider(settings),
      envRuntime: process.env.AGENTFORGE_RUNTIME,
    });
    // Stub text is for a desk running offline or under test. The hosted server never stubs: a tenant
    // with no key is told so by the same gate as every other route (403 gateway_blocked, needs_key),
    // not handed a "rewrite" no model made. On a desk this condition is exactly what it always was.
    if (mode === "stub" && !isServerMode()) {
      return jsonOk({ text: stubEnhancePrompt(text, surface, locale), source: "stub" });
    }
    // Past the stub short-circuit this is a real model call, so the gate decides.
    requireGatewayAllowed(settings, { tenant });
    const catalog = listSelectableModels(tenant);
    const defaults = modeDefaultsFor(tenant);
    const requested =
      request.body &&
      typeof request.body === "object" &&
      typeof (request.body as { model?: unknown }).model === "string"
        ? (request.body as { model: string }).model
        : undefined;
    const model = resolveChatModel(requested, defaults.chat, catalog);
    const raw = await collectJobAssistantText({
      tenant,
      model,
      systemPrompt: enhanceSystemPrompt(surface, locale),
      runPrefix: "enhance",
      agentId: "enhance-prompt",
      // Nearest studio: this only picks the thinking knob, and rewriting a prompt needs none.
      jobMode: "documents",
      versionId: "enhance-prompt",
      prompt: enhanceUserPrompt(text, locale),
    });
    const next = stripWrappingQuotes(raw);
    if (!next) {
      throw new ApiError("llm_error", "Enhance returned an empty prompt", 502);
    }
    return jsonOk({ text: next.length > 800 ? `${next.slice(0, 797)}…` : next, source: "live" });
  } catch (error) {
    return jsonError(error);
  }
}
