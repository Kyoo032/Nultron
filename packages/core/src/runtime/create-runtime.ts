import { AiSdkRuntime } from "./ai-sdk-runtime";
import { StubRuntime } from "./stub-runtime";
import type { AgentRuntime } from "./types";
import { resolveProviderKeys, resolveRuntimeMode, hasLiveProvider, type StoredSecrets } from "../secrets";
import { buildToolSecretScope } from "../tools/credentials";
import { runWithToolSecrets, type MediaModelCatalog } from "../tools/secret-scope";
import { readGeneratePin } from "../agents/generate-defaults";
import { maskOutboundRunInput } from "../security/pii";
import { runWithSpotlight } from "../security/spotlight";
import { canaryLeak, canaryLeakJson, runWithCanary } from "../security/canary";
import { reportAuditEvent } from "../audit/sink";
import { runWithToolIoSink } from "./tool-io";

function withToolSecrets(runtime: AgentRuntime, settings: StoredSecrets, mediaModels: MediaModelCatalog): AgentRuntime {
  const scope = { ...buildToolSecretScope(settings), mediaModels };
  return {
    execute: (input) => {
      const image = readGeneratePin(input.version.config, "image");
      const video = readGeneratePin(input.version.config, "video");
      const next = {
        ...scope,
        secrets: {
          ...scope.secrets,
          ...(image ? { IMAGE_GEN_MODEL: image } : {}),
          ...(video ? { VIDEO_GEN_MODEL: video } : {}),
        },
      };
      return runWithToolSecrets(next, () => runWithToolIoSink(() => runtime.execute(maskOutboundRunInput(input))));
    },
  };
}

/**
 * F6 layer 2 (B3 + B5): wrap `execute` in the run's spotlight and canary scopes.
 * The canary is appended to the MASKED system prompt — the stored prompt is never
 * touched — and the model's own deltas are scanned for it: an echo means the prompt
 * leaked, so the run stops emitting text and the hit is logged with the rule id only.
 */
function withInjectionLayer2(runtime: AgentRuntime): AgentRuntime {
  return {
    execute: (input) =>
      runWithSpotlight(() =>
        runWithCanary(input.version.systemPrompt, (prompt) => {
          const canaried = { ...input, version: { ...input.version, systemPrompt: prompt } };
          let canaryStopped = false;
          // The token can split across deltas; the tail carries the last few characters
          // forward so a leak landing on an event boundary still trips.
          let canaryTail = "";
          const onEvent = canaried.onEvent;
          return runtime.execute({
            ...canaried,
            onEvent: async (event) => {
              if (event.type === "assistant.delta" || event.type === "assistant.thinking") {
                if (canaryStopped) {
                  return;
                }
                canaryTail += event.text;
                if (canaryLeak(canaryTail)) {
                  canaryStopped = true;
                  reportAuditEvent({
                    tenantId: input.tenant.tenantId,
                    event: "guardrail.decision",
                    actorKind: "system",
                    agentId: input.version.agentId,
                    targetKind: "run",
                    targetId: input.runId,
                    outcome: "denied",
                    rule: "canary_output",
                  });
                  return onEvent({
                    type: "assistant.delta",
                    text: "[Output blocked by injection guard (rule: canary)]",
                  });
                }
                // Keep enough tail to catch a token split across events (token is 16
                // hex chars); nothing older can still match.
                if (canaryTail.length > 64) {
                  canaryTail = canaryTail.slice(-32);
                }
              }
              // Tool arguments streaming to the UI are another leak path: a refused
              // canary call must not show the token in the event payload either.
              if (event.type === "tool.started" && canaryLeakJson(event.input)) {
                return onEvent({ ...event, input: "[omitted]" });
              }
              return onEvent(event);
            },
          });
        }),
      ),
  };
}

export function createRuntime(settings: StoredSecrets, mediaModels: MediaModelCatalog): AgentRuntime {
  const keys = resolveProviderKeys(settings);
  const mode = resolveRuntimeMode({
    settingsHasKey: hasLiveProvider(settings),
    envRuntime: process.env.AGENTFORGE_RUNTIME,
  });
  const runtime = mode === "ai" ? new AiSdkRuntime(keys) : new StubRuntime();
  return withInjectionLayer2(withToolSecrets(runtime, settings, mediaModels));
}
