import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * How Chat sends a tier, pinned against the sources (chat-first plan, track M1-renderer).
 *
 * The pane and the composer are JSX with hooks and this package's vitest run is node-only, so the wiring
 * is pinned as text, the way `chat-run-scope-wiring.test.ts` pins the session key. The behaviour under
 * it is in `chat-tier-pref.test.ts`, `chat-tier-body.test.ts` and `tier-picker.test.tsx`.
 *
 * The rule: a Chat send names a tier and never a model, and the person's Thinking level is the tier's,
 * not a control of its own.
 */
const web = join(dirname(fileURLToPath(import.meta.url)), "..");

function source(relative: string): string {
  return readFileSync(join(web, relative), "utf8").replace(/\r\n/g, "\n");
}

const composer = source("components/chat-composer.tsx");
const session = source("components/chat-session.tsx");

/** The JSX element that opens at `marker`, up to the `/>` that closes it. */
function element(text: string, marker: string): string {
  const at = text.indexOf(marker);
  expect(at, `${marker} is missing`).toBeGreaterThan(-1);
  return text.slice(at, text.indexOf("/>", at) + 2);
}

describe("the composer's run requests", () => {
  it("builds the body through one helper at both send sites, the text run and the image or video run", () => {
    expect(composer.match(/JSON\.stringify\(buildChatRunBody\(/g)).toHaveLength(2);
    expect(composer).toContain("buildChatRunBody(outgoing, tier, retrying)");
    expect(composer).toContain("buildChatRunBody(parts, tier)");
    expect(composer).toContain('from "@/lib/chat-tier-body"');
  });

  it("posts no model, no Thinking flag and no reasoning level of its own", () => {
    const bodies = composer.match(/body: JSON\.stringify\([\s\S]*?\),\n\s*signal/g) ?? [];
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).not.toMatch(/\bmodel\b|thinking|reasoningEffort/);
    }
    expect(composer).not.toContain("thinkingRequestFields");
    expect(composer).not.toContain("@/lib/chat-thinking");
  });

  it("takes the tier from its props and defaults to Daily", () => {
    expect(composer).toContain("tier = DEFAULT_MODEL_TIER");
    expect(composer).toContain("tiers?: readonly ChatTierInfo[]");
    expect(composer).toContain("onTierChange?: (tier: ModelTierId) => void");
  });
});

describe("the composer's controls", () => {
  it("mounts the tier picker and not the model picker", () => {
    expect(composer).toContain("<TierPicker");
    expect(composer).not.toContain("<ModelPicker");
    expect(composer).not.toContain("@/components/model-picker");
    const picker = element(composer, "<TierPicker");
    expect(picker).toContain("tiers={tiers ?? []}");
    expect(picker).toContain("value={tier}");
    expect(picker).toContain("onChange={onTierChange}");
    expect(picker).toContain("returnFocusRef={textAreaRef}");
    expect(picker).toContain("disabled={busy}");
  });

  it("has no reasoning-effort select and none of the props that fed it", () => {
    for (const gone of [
      "reasoning-effort",
      "REASONING_EFFORTS",
      "reasoningEffortChosen",
      "onReasoningEffortChange",
      "composer-thinking",
      "chat.composer.thinkingPrefix",
    ]) {
      expect(composer, gone).not.toContain(gone);
    }
  });

  it("does not hand the enhance button a model", () => {
    const enhance = element(composer, "<EnhancePromptButton");
    expect(enhance).not.toMatch(/\bmodel=/);
  });
});

describe("the composer's failures", () => {
  it("names the tier, never a model, when the stream watchdog fires", () => {
    expect(composer).toContain("armStreamWatchdog(tierLabel, abort, tierStreamLimits(tier), Date.now, getLocale())");
    expect(composer).toMatch(/const tierLabel = t\(`chat\.tiers\.\$\{tier\}\.label`\)/);
    expect(composer).not.toContain("this model");
  });

  it("reads a tier error from the host's body at both refusal sites, ahead of the host's own sentence", () => {
    expect(composer.match(/tierErrorMessage\(payload\)/g)).toHaveLength(2);
    expect(composer.match(/payload\?\.error\?\.message \?\? t\("chat\.error\.runFailed"\)/g)).toHaveLength(2);
    expect(composer).toMatch(/tierErrorMessage\(payload\) \?\? payload\?\.error\?\.message/);
  });

  it("keeps the hosted no-key sentence ahead of everything at the text site", () => {
    expect(composer).toMatch(/hostedGatewayBlocked\(payload\)\s*\?\s*gatewayBlockedMessage\(\)/);
  });
});

describe("the chat pane", () => {
  it("reads the tiers and the default from both catalog payloads", () => {
    expect(session.match(/readTierCatalog\(/g)).toHaveLength(2);
    expect(session).toContain("readTierCatalog(modelPayload)");
    expect(session).toContain("readTierCatalog(home)");
  });

  it("no longer holds a model, a catalog default or the remembered model", () => {
    for (const gone of [
      "chat-model-pref",
      "pickChatModel",
      "setModelId",
      "setCatalogDefault",
      "rememberModel",
      "handleModelChange",
      "model={modelId}",
      "onModelChange",
    ]) {
      expect(session, gone).not.toContain(gone);
    }
  });

  it("starts on the thread's tier or the last choice, not on Daily, so the last choice can seed a new pane", () => {
    expect(session).toContain("useState<ModelTierId>(() => initialChatTier(initialThreadId))");
  });

  it("seeds the tier from the thread, then the current one, then the last, then the default", () => {
    const seed = session.slice(session.indexOf("pickChatTier({"));
    const call = seed.slice(0, seed.indexOf("}),") + 3);
    for (const part of [
      "tiers,",
      "current,",
      'threadTier: threadKey ? readThreadChatTier(threadKey) : ""',
      "lastTier: readLastChatTier()",
      "defaultTier,",
    ]) {
      expect(call, part).toContain(part);
    }
  });

  it("remembers the tier per thread and as the last choice, where it used to remember the model", () => {
    const remember = session.slice(session.indexOf("function rememberTier("));
    const body = remember.slice(0, remember.indexOf("\n  }\n"));
    expect(body).toContain("writeLastChatTier(tier)");
    expect(body).toContain("writeThreadChatTier(thread, tier)");
    expect(session).toContain("rememberTier(tierId, id)");
    expect(session).toContain("rememberTier(tierId);");
    expect(session).toContain("rememberTier(next)");
  });

  it("hands the composer the tier and the list, and the change handler only outside the agent shell", () => {
    const composerProps = element(session, "<ChatComposer");
    expect(composerProps).toContain("tier={tierId}");
    expect(composerProps).toContain("tiers={tiers}");
    // In the chat-first shell the choice is made in the agent's header, so the composer draws no picker.
    expect(composerProps).toContain("onTierChange={shell ? undefined : handleTierChange}");
    expect(composerProps).not.toMatch(/\bmodel=|\bmodels=|reasoningEffort|thinkingEnabled|onThinkingChange/);
  });

  it("puts the tier choice in the agent's header in the chat-first shell", () => {
    const header = element(session, "<AgentChatHeader");
    expect(header).toContain("<TierPicker tiers={tiers} value={tierId} onChange={handleTierChange}");
  });

  it("takes the Thinking row from the tier: off for Fastest, on for the others", () => {
    expect(session).toContain("thinkingEnabled: tierThinkingEnabled(tierId)");
    expect(session).not.toContain("setThinkingEnabled");
    expect(session).not.toContain("readStoredThinkingPref");
    expect(session).not.toContain("setReasoningPref");
  });

  it("sizes the context chip and the attachment modalities from the tier", () => {
    expect(session).toContain("contextLength={selectedTier?.contextLength ?? undefined}");
    expect(session).toContain("selectedTier?.inputModalities");
    expect(session).not.toContain("selectedModel");
  });
});
