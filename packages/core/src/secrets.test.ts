import { describe, expect, it } from "vitest";
import { maskSecrets, mergeSecrets, hasLiveProvider, resolveProviderKeys, resolveRuntimeMode } from "./secrets";
import { keyFingerprint } from "./security/fingerprint";
import { DEFAULT_OPENAI_BASE_URL } from "./models/probe";

describe("mergeSecrets", () => {
  it("sets a new key and leaves blank patches unchanged", () => {
    const merged = mergeSecrets(
      { openaiApiKey: "sk-old" },
      { openaiApiKey: "sk-new", googleApiKey: "  ", openaiBaseUrl: "https://openrouter.ai/api/v1/" },
    );
    expect(merged.openaiApiKey).toBe("sk-new");
    expect(merged.googleApiKey).toBeUndefined();
    expect(merged.openaiBaseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("stores tool keys separately from the chat model key", () => {
    const merged = mergeSecrets({ openaiApiKey: "sk-model" }, { toolKeys: { TAVILY_API_KEY: "tvly-test" } });
    expect(merged.openaiApiKey).toBe("sk-model");
    expect(merged.toolKeys).toEqual({ TAVILY_API_KEY: "tvly-test" });
  });

  it("clears an endpoint when the field is blank", () => {
    const merged = mergeSecrets({ openaiBaseUrl: "https://example.com/v1" }, { openaiBaseUrl: "  " });
    expect(merged.openaiBaseUrl).toBeUndefined();
  });

  it("clears a key field when the patch value is empty string", () => {
    const merged = mergeSecrets({ openaiApiKey: "sk-old" }, { openaiApiKey: "" });
    expect(merged.openaiApiKey).toBeUndefined();
  });

  it("clears a key field when the patch value is whitespace-only", () => {
    const merged = mergeSecrets({ openaiApiKey: "sk-old" }, { openaiApiKey: "   " });
    expect(merged.openaiApiKey).toBeUndefined();
  });

  it("clears a single tool key when patched with empty string", () => {
    const merged = mergeSecrets(
      { toolKeys: { TAVILY_API_KEY: "x", BRAVE_SEARCH_API_KEY: "y" } },
      { toolKeys: { TAVILY_API_KEY: "" } },
    );
    expect(merged.toolKeys?.TAVILY_API_KEY).toBeUndefined();
    expect(merged.toolKeys?.BRAVE_SEARCH_API_KEY).toBe("y");
  });

  it("clears all tool keys and removes toolKeys field when all are blanked", () => {
    const merged = mergeSecrets(
      { toolKeys: { TAVILY_API_KEY: "x" } },
      { toolKeys: { TAVILY_API_KEY: "" } },
    );
    expect(merged.toolKeys).toBeUndefined();
  });

  it("stores default image/video gen models and clears them on blank patch", () => {
    const set = mergeSecrets({}, { imageGenModel: "gpt-image-2", videoGenModel: "grok-imagine-video" });
    expect(set.imageGenModel).toBe("gpt-image-2");
    expect(set.videoGenModel).toBe("grok-imagine-video");
    const cleared = mergeSecrets(set, { imageGenModel: "  ", videoGenModel: "" });
    expect(cleared.imageGenModel).toBeUndefined();
    expect(cleared.videoGenModel).toBeUndefined();
  });

  it("stores document/research/presentation job models", () => {
    const set = mergeSecrets(
      {},
      { documentGenModel: "claude-sonnet-5", researchGenModel: "deepseek-v4-pro", presentationGenModel: "gpt-5.6-sol" },
    );
    expect(set.documentGenModel).toBe("claude-sonnet-5");
    expect(set.researchGenModel).toBe("deepseek-v4-pro");
    expect(set.presentationGenModel).toBe("gpt-5.6-sol");
  });

  it("replaces disabledTools when the patch includes the array", () => {
    const set = mergeSecrets({}, { disabledTools: ["image_generate", "web_search"] });
    expect(set.disabledTools).toEqual(["image_generate", "web_search"]);
    const emptied = mergeSecrets(set, { disabledTools: [] });
    expect(emptied.disabledTools).toEqual([]);
    const untouched = mergeSecrets(set, { openaiApiKey: "sk-x" });
    expect(untouched.disabledTools).toEqual(["image_generate", "web_search"]);
  });

  it("never merges injectionGuardBypass, so a patch cannot put it in a saved file", () => {
    expect(mergeSecrets({}, { injectionGuardBypass: true }).injectionGuardBypass).toBeUndefined();
    expect(mergeSecrets({}, { injectionGuardBypass: false }).injectionGuardBypass).toBeUndefined();
    expect(mergeSecrets({ openaiApiKey: "sk-x" }, { injectionGuardBypass: true })).toEqual({ openaiApiKey: "sk-x" });
  });

  it("clamps editTurnCapUsd to 0.5–50 and leaves it absent when unpatched", () => {
    const set = mergeSecrets({}, { editTurnCapUsd: 2 });
    expect(set.editTurnCapUsd).toBe(2);
    expect(mergeSecrets({}, { editTurnCapUsd: 0.1 }).editTurnCapUsd).toBe(0.5);
    expect(mergeSecrets({}, { editTurnCapUsd: 99 }).editTurnCapUsd).toBe(50);
    expect(mergeSecrets(set, { openaiApiKey: "sk-x" }).editTurnCapUsd).toBe(2);
  });
});

describe("maskSecrets", () => {
  it("never returns the raw key", () => {
    expect(maskSecrets({ openaiApiKey: "sk-secret" }).openaiBaseUrl).toBe(DEFAULT_OPENAI_BASE_URL);
    // The endpoint is pinned: a stored value from an older build is never reported back.
    expect(maskSecrets({ openaiApiKey: "sk-secret", openaiBaseUrl: "https://api.openai.com/v1" })).toEqual({
      hasOpenai: true,
      hasGoogle: false,
      hasAnthropic: false,
      hasVolcengine: false,
      hasTelegramBot: false,
      openaiKeyFingerprint: keyFingerprint("sk-secret"),
      googleKeyFingerprint: null,
      anthropicKeyFingerprint: null,
      volcengineKeyFingerprint: null,
      telegramBotFingerprint: null,
      openaiBaseUrl: DEFAULT_OPENAI_BASE_URL,
      googleBaseUrl: undefined,
      anthropicBaseUrl: undefined,
      volcengineBaseUrl: undefined,
      hasToolKeys: {
        TAVILY_API_KEY: false,
        TAVILY_BASE_URL: false,
        BRAVE_SEARCH_API_KEY: false,
        FAL_KEY: false,
      },
      toolBackends: {},
      imageGenModel: undefined,
      videoGenModel: undefined,
      documentGenModel: undefined,
      researchGenModel: undefined,
      presentationGenModel: undefined,
      disabledTools: [],
      injectionGuardBypass: false,
      editTurnCapUsd: undefined,
    });
  });

  it("reports a saved Telegram bot token as a boolean and a fingerprint, never as the token", () => {
    const token = "123456789:AAtokenvaluegoeshere0000000000000000";
    const masked = maskSecrets({ telegramBotToken: token });
    expect(masked.hasTelegramBot).toBe(true);
    expect(masked.telegramBotFingerprint).toBe(keyFingerprint(token));
    expect(JSON.stringify(masked)).not.toContain(token);
  });

  it("clears the Telegram bot token on an empty patch, like every other key", () => {
    const token = "123456789:AAtokenvaluegoeshere0000000000000000";
    expect(mergeSecrets({}, { telegramBotToken: ` ${token} ` }).telegramBotToken).toBe(token);
    expect(mergeSecrets({ telegramBotToken: token }, { telegramBotToken: "" }).telegramBotToken).toBeUndefined();
    // A saved bot token is not a model provider: it must not flip the runtime to live.
    expect(hasLiveProvider({ telegramBotToken: token })).toBe(false);
  });

  it("exposes sha256 fingerprints and never embeds the raw keys in JSON", () => {
    const secrets = {
      openaiApiKey: "sk-secret",
      googleApiKey: "google-secret",
      anthropicApiKey: "sk-ant-secret",
      volcengineApiKey: "ark-secret",
    };
    const masked = maskSecrets(secrets);
    expect(masked.openaiKeyFingerprint).toBe(keyFingerprint("sk-secret"));
    expect(masked.googleKeyFingerprint).toBe(keyFingerprint("google-secret"));
    expect(masked.anthropicKeyFingerprint).toBe(keyFingerprint("sk-ant-secret"));
    expect(masked.volcengineKeyFingerprint).toBe(keyFingerprint("ark-secret"));
    expect(masked.openaiKeyFingerprint).toMatch(/^sha256:[0-9a-f]{12}$/);
    const json = JSON.stringify(masked);
    expect(json).not.toContain("sk-secret");
    expect(json).not.toContain("google-secret");
    expect(json).not.toContain("sk-ant-secret");
    expect(json).not.toContain("ark-secret");
  });

  it("returns null fingerprints when no provider keys are saved", () => {
    const masked = maskSecrets({});
    expect(masked.openaiKeyFingerprint).toBeNull();
    expect(masked.googleKeyFingerprint).toBeNull();
    expect(masked.anthropicKeyFingerprint).toBeNull();
    expect(masked.volcengineKeyFingerprint).toBeNull();
  });

  it("masks tool keys without returning them", () => {
    expect(maskSecrets({ toolKeys: { TAVILY_API_KEY: "tvly-secret" }, toolBackends: { web: "tavily" } }).hasToolKeys).toEqual(
      expect.objectContaining({ TAVILY_API_KEY: true, BRAVE_SEARCH_API_KEY: false }),
    );
    expect(JSON.stringify(maskSecrets({ toolKeys: { TAVILY_API_KEY: "tvly-secret" } }))).not.toContain("tvly-secret");
  });

  it("returns image/video models and disabledTools for Settings round-trip", () => {
    const masked = maskSecrets({
      imageGenModel: "gpt-image-2",
      videoGenModel: "grok-imagine-video",
      documentGenModel: "claude-sonnet-5",
      disabledTools: ["calculator"],
    });
    expect(masked.imageGenModel).toBe("gpt-image-2");
    expect(masked.videoGenModel).toBe("grok-imagine-video");
    expect(masked.documentGenModel).toBe("claude-sonnet-5");
    expect(masked.disabledTools).toEqual(["calculator"]);
  });

  it("masks injectionGuardBypass as false when absent", () => {
    expect(maskSecrets({}).injectionGuardBypass).toBe(false);
    expect(maskSecrets({ injectionGuardBypass: true }).injectionGuardBypass).toBe(true);
  });

  it("exposes editTurnCapUsd when stored", () => {
    expect(maskSecrets({ editTurnCapUsd: 2 }).editTurnCapUsd).toBe(2);
  });
});

describe("resolveRuntimeMode", () => {
  it("uses live models once the owner saved a key", () => {
    expect(resolveRuntimeMode({ settingsHasKey: true, envRuntime: "stub" })).toBe("ai");
    expect(resolveRuntimeMode({ settingsHasKey: false, envRuntime: "stub" })).toBe("stub");
  });
});

describe("resolveProviderKeys", () => {
  it("prefers settings over env", () => {
    const keys = resolveProviderKeys(
      { openaiApiKey: "from-settings" },
      { OPENAI_API_KEY: "from-env" } as NodeJS.ProcessEnv,
    );
    expect(keys.openai).toBe("from-settings");
    expect(keys.openaiBaseUrl).toBe(DEFAULT_OPENAI_BASE_URL);
  });

  it("defaults the OpenAI-compatible endpoint to Toko Token", () => {
    const keys = resolveProviderKeys({}, {} as NodeJS.ProcessEnv);
    expect(keys.openaiBaseUrl).toBe("https://api.tokotokenai.com/v1");
  });

  it("reuses the OpenAI-compatible key when auto-detect finds another dialect", () => {
    const anthropic = resolveProviderKeys({ openaiApiKey: "sk-ant-test" }, {} as NodeJS.ProcessEnv);
    expect(anthropic.anthropic).toBe("sk-ant-test");
  });

  it("ignores a stored endpoint and OPENAI_BASE_URL: the gateway is pinned", () => {
    const keys = resolveProviderKeys(
      { openaiApiKey: "sk-test", openaiBaseUrl: "https://ark.cn-beijing.volces.com/api/v3" },
      { OPENAI_BASE_URL: "https://elsewhere.example/v1" } as NodeJS.ProcessEnv,
    );
    expect(keys.openaiBaseUrl).toBe(DEFAULT_OPENAI_BASE_URL);
    expect(keys.volcengineBaseUrl).toBeUndefined();
  });
});

describe("hasLiveProvider", () => {
  it("needs a key: the pinned endpoint can no longer be re-pointed", () => {
    expect(hasLiveProvider({ openaiBaseUrl: "http://127.0.0.1:11434/v1" })).toBe(false);
    expect(hasLiveProvider({ anthropicApiKey: "sk-ant-test" })).toBe(true);
    expect(hasLiveProvider({})).toBe(false);
    expect(hasLiveProvider({ openaiBaseUrl: DEFAULT_OPENAI_BASE_URL })).toBe(false);
    expect(hasLiveProvider({ openaiApiKey: "sk-test" })).toBe(true);
  });
});

/**
 * Enterprise BYOK, Phase A (2026-10-01): on the hosted server a provider's base URL comes from the
 * provider registry and from nowhere else. A stored value from an older build, or one written
 * through the file by hand, is never honoured, and neither is a process variable (the operator's own
 * endpoints were already empty there). Off the hosted server nothing below changes.
 */
describe("provider base URLs in server mode", () => {
  const SERVER = { AGENTFORGE_SERVER: "1" } as NodeJS.ProcessEnv;
  const HOSTILE = {
    googleApiKey: "AIza-test-google",
    anthropicApiKey: "sk-ant-test-anthropic",
    volcengineApiKey: "ark-test",
    googleBaseUrl: "https://evil.example/v1beta",
    anthropicBaseUrl: "https://evil.example/v1",
    volcengineBaseUrl: "https://evil.example/api/v3",
  };

  it("takes the Google and Anthropic base URLs from the registry, not from the stored settings", () => {
    const keys = resolveProviderKeys(HOSTILE, SERVER);
    expect(keys.googleBaseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(keys.anthropicBaseUrl).toBe("https://api.anthropic.com/v1");
  });

  it("gives Volcengine no base URL at all, so the runtime uses its own pinned constant", () => {
    expect(resolveProviderKeys(HOSTILE, SERVER).volcengineBaseUrl).toBeUndefined();
  });

  it("offers a native base URL only behind a key for that provider", () => {
    const keys = resolveProviderKeys({ googleBaseUrl: "https://evil.example/v1beta" }, SERVER);
    expect(keys.googleBaseUrl).toBeUndefined();
    expect(keys.anthropicBaseUrl).toBeUndefined();
    expect(keys.volcengineBaseUrl).toBeUndefined();
  });

  it("keeps the gateway endpoint pinned, as before", () => {
    expect(resolveProviderKeys({ openaiApiKey: "sk-test", openaiBaseUrl: "https://evil.example/v1" }, SERVER).openaiBaseUrl).toBe(
      DEFAULT_OPENAI_BASE_URL,
    );
  });

  it("does not let a stored base URL make a keyless tenant live", () => {
    expect(hasLiveProvider({ anthropicBaseUrl: "https://evil.example/v1" }, SERVER)).toBe(false);
    expect(hasLiveProvider({ volcengineBaseUrl: "https://evil.example/api/v3" }, SERVER)).toBe(false);
    expect(hasLiveProvider({ anthropicApiKey: "sk-ant-test" }, SERVER)).toBe(true);
    expect(hasLiveProvider({ openaiApiKey: "sk-test" }, SERVER)).toBe(true);
  });

  it("never reports a stored base URL back to the renderer", () => {
    const masked = maskSecrets(HOSTILE, SERVER);
    expect(masked.googleBaseUrl).toBeUndefined();
    expect(masked.anthropicBaseUrl).toBeUndefined();
    expect(masked.volcengineBaseUrl).toBeUndefined();
    expect(masked.hasGoogle).toBe(true);
    expect(masked.hasAnthropic).toBe(true);
  });

  describe("Personal parity: off the hosted server the answers are exactly what they were", () => {
    const PERSONAL = {} as NodeJS.ProcessEnv;

    it("still honours a stored base URL on the desktop and webdev", () => {
      const keys = resolveProviderKeys(HOSTILE, PERSONAL);
      expect(keys.googleBaseUrl).toBe("https://evil.example/v1beta");
      expect(keys.anthropicBaseUrl).toBe("https://evil.example/v1");
      expect(keys.volcengineBaseUrl).toBe("https://evil.example/api/v3");
    });

    it("still returns no base URL when none is stored", () => {
      const keys = resolveProviderKeys({ googleApiKey: "AIza-test-google" }, PERSONAL);
      expect(keys.googleBaseUrl).toBeUndefined();
      expect(keys.anthropicBaseUrl).toBeUndefined();
    });

    it("still reads the operator's endpoint variables off the desktop", () => {
      const keys = resolveProviderKeys({}, {
        GOOGLE_GENERATIVE_AI_BASE_URL: "https://proxy.example/v1beta",
        ANTHROPIC_BASE_URL: "https://proxy.example/v1",
        ARK_BASE_URL: "https://proxy.example/api/v3",
      } as NodeJS.ProcessEnv);
      expect(keys.googleBaseUrl).toBe("https://proxy.example/v1beta");
      expect(keys.anthropicBaseUrl).toBe("https://proxy.example/v1");
      expect(keys.volcengineBaseUrl).toBe("https://proxy.example/api/v3");
    });

    it("still lets a stored native endpoint make the desk live", () => {
      expect(hasLiveProvider({ anthropicBaseUrl: "http://127.0.0.1:11434/v1" }, PERSONAL)).toBe(true);
      expect(hasLiveProvider({ volcengineBaseUrl: "https://ark.cn-beijing.volces.com/api/v3" }, PERSONAL)).toBe(true);
    });

    it("still reports the stored base URLs", () => {
      const masked = maskSecrets(HOSTILE, PERSONAL);
      expect(masked.googleBaseUrl).toBe("https://evil.example/v1beta");
      expect(masked.anthropicBaseUrl).toBe("https://evil.example/v1");
      expect(masked.volcengineBaseUrl).toBe("https://evil.example/api/v3");
    });
  });
});
