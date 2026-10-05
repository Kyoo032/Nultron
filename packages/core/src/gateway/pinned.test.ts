import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { assertPinnedGatewayIntegrity } from "./pinned-integrity";
import {
  gatewayUrlOverride,
  gatewayUrlOverrideAllowed,
  isPackagedRuntime,
  PINNED_GATEWAY_BASE_URL,
  PINNED_GATEWAY_BASE_URL_SHA256,
  pinnedGatewayBaseUrl,
  pinnedGatewayOrigin,
} from "./pinned";
import { isGatewayBaseUrl, resolvedGatewayBaseUrl } from "../gateway";
import { resolvedTelegramApiOrigin, PINNED_TELEGRAM_API_ORIGIN } from "../channels/pinned";

const ENV_KEYS = [
  "AGENTFORGE_GATEWAY_URL",
  "AGENTFORGE_BRAND_GATEWAY_URL",
  "AGENTFORGE_TELEGRAM_API_URL",
  "AGENTFORGE_PACKAGED",
  "NODE_ENV",
] as const;

const AIHUB = "https://aihub.metranet.co.id/v1";

function snapshotEnv(): Record<string, string | undefined> {
  const previous: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    previous[key] = process.env[key];
  }
  return previous;
}

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = previous[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("pinned gateway endpoint", () => {
  const previous = snapshotEnv();

  afterEach(() => {
    restoreEnv(previous);
  });

  it("hardcodes the Toko Token endpoint", () => {
    expect(PINNED_GATEWAY_BASE_URL).toBe("https://api.tokotokenai.com/v1");
    expect(pinnedGatewayBaseUrl()).toBe(PINNED_GATEWAY_BASE_URL);
    expect(pinnedGatewayOrigin()).toBe("https://api.tokotokenai.com");
  });

  it("matches the recomputed SHA-256 of the pinned string", () => {
    const recomputed = createHash("sha256").update(PINNED_GATEWAY_BASE_URL, "utf8").digest("hex");
    expect(recomputed).toBe(PINNED_GATEWAY_BASE_URL_SHA256);
  });

  it("passes the boot integrity check", () => {
    expect(() => assertPinnedGatewayIntegrity()).not.toThrow();
  });

  it("reads AGENTFORGE_PACKAGED for the packaged flag", () => {
    delete process.env.AGENTFORGE_PACKAGED;
    expect(isPackagedRuntime()).toBe(false);
    process.env.AGENTFORGE_PACKAGED = "1";
    expect(isPackagedRuntime()).toBe(true);
    process.env.AGENTFORGE_PACKAGED = "0";
    expect(isPackagedRuntime()).toBe(false);
  });

  it("honours AGENTFORGE_GATEWAY_URL only in a dev/test runtime", () => {
    process.env.NODE_ENV = "test";
    delete process.env.AGENTFORGE_PACKAGED;
    process.env.AGENTFORGE_GATEWAY_URL = "https://aihub.metranet.co.id/v1/";
    expect(resolvedGatewayBaseUrl()).toBe("https://aihub.metranet.co.id/v1");
  });

  it("ignores AGENTFORGE_GATEWAY_URL when packaged", () => {
    process.env.NODE_ENV = "test";
    process.env.AGENTFORGE_PACKAGED = "1";
    process.env.AGENTFORGE_GATEWAY_URL = "https://evil.example/v1";
    expect(resolvedGatewayBaseUrl()).toBe(PINNED_GATEWAY_BASE_URL);
  });

  it("ignores AGENTFORGE_GATEWAY_URL in production", () => {
    process.env.NODE_ENV = "production";
    delete process.env.AGENTFORGE_PACKAGED;
    process.env.AGENTFORGE_GATEWAY_URL = "https://evil.example/v1";
    expect(resolvedGatewayBaseUrl()).toBe(PINNED_GATEWAY_BASE_URL);
  });
});

/**
 * The two channels that can move the gateway, and the runtime each one belongs to. `main.cjs` sets
 * AGENTFORGE_PACKAGED=1 and AGENTFORGE_BRAND_GATEWAY_URL (a flavor only) before host.cjs loads; the
 * dev hook AGENTFORGE_GATEWAY_URL belongs to a developer machine. A shipped build must not honour
 * the second, and a flavor must still honour the first.
 */
describe("gateway override channels", () => {
  const previous = snapshotEnv();

  afterEach(() => {
    restoreEnv(previous);
  });

  function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
    for (const key of ENV_KEYS) {
      const value = values[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  describe("dev / test runtime", () => {
    it("honours the dev hook and strips a trailing slash", () => {
      setEnv({ NODE_ENV: "development", AGENTFORGE_GATEWAY_URL: `${AIHUB}/` });
      expect(gatewayUrlOverrideAllowed()).toBe(true);
      expect(gatewayUrlOverride()).toBe(AIHUB);
      expect(resolvedGatewayBaseUrl()).toBe(AIHUB);
    });

    it("is the pinned gateway when nothing is set", () => {
      setEnv({ NODE_ENV: "test" });
      expect(gatewayUrlOverride()).toBeNull();
      expect(resolvedGatewayBaseUrl()).toBe(PINNED_GATEWAY_BASE_URL);
    });

    it("ignores a blank dev hook", () => {
      setEnv({ NODE_ENV: "test", AGENTFORGE_GATEWAY_URL: "   " });
      expect(gatewayUrlOverride()).toBeNull();
    });

    it("ignores the brand channel, which only a packaged build reads", () => {
      setEnv({ NODE_ENV: "test", AGENTFORGE_BRAND_GATEWAY_URL: AIHUB });
      expect(gatewayUrlOverride()).toBeNull();
      expect(resolvedGatewayBaseUrl()).toBe(PINNED_GATEWAY_BASE_URL);
    });
  });

  describe("production runtime (the hosted app)", () => {
    it("ignores the dev hook and the brand channel", () => {
      setEnv({
        NODE_ENV: "production",
        AGENTFORGE_GATEWAY_URL: "https://evil.example/v1",
        AGENTFORGE_BRAND_GATEWAY_URL: "https://evil.example/v1",
      });
      expect(gatewayUrlOverrideAllowed()).toBe(false);
      expect(gatewayUrlOverride()).toBeNull();
      expect(resolvedGatewayBaseUrl()).toBe(PINNED_GATEWAY_BASE_URL);
    });
  });

  describe("packaged runtime (AGENTFORGE_PACKAGED=1, set by main.cjs)", () => {
    it("ignores the dev hook whatever NODE_ENV says", () => {
      // The packaged host.cjs bundle does not define NODE_ENV, so it is normally unset here.
      for (const nodeEnv of [undefined, "development", "test"]) {
        setEnv({
          ...(nodeEnv ? { NODE_ENV: nodeEnv } : {}),
          AGENTFORGE_PACKAGED: "1",
          AGENTFORGE_GATEWAY_URL: "https://evil.example/v1",
        });
        expect(gatewayUrlOverrideAllowed()).toBe(false);
        expect(gatewayUrlOverride()).toBeNull();
        expect(resolvedGatewayBaseUrl()).toBe(PINNED_GATEWAY_BASE_URL);
      }
    });

    it("is the pinned gateway when main.cjs set no brand gateway (the public build)", () => {
      setEnv({ AGENTFORGE_PACKAGED: "1" });
      expect(gatewayUrlOverride()).toBeNull();
      expect(resolvedGatewayBaseUrl()).toBe(PINNED_GATEWAY_BASE_URL);
    });

    it("honours the brand gateway, so Kemenkeu AI and AIHub Metranet keep their gateway", () => {
      setEnv({ AGENTFORGE_PACKAGED: "1", AGENTFORGE_BRAND_GATEWAY_URL: `${AIHUB}/` });
      expect(gatewayUrlOverride()).toBe(AIHUB);
      expect(resolvedGatewayBaseUrl()).toBe(AIHUB);
      expect(isGatewayBaseUrl(AIHUB)).toBe(true);
      expect(isGatewayBaseUrl(PINNED_GATEWAY_BASE_URL)).toBe(true);
    });

    it("prefers the brand gateway over a dev hook that is also set", () => {
      setEnv({
        AGENTFORGE_PACKAGED: "1",
        AGENTFORGE_BRAND_GATEWAY_URL: AIHUB,
        AGENTFORGE_GATEWAY_URL: "https://evil.example/v1",
      });
      expect(resolvedGatewayBaseUrl()).toBe(AIHUB);
    });

    it("honours the brand gateway even when the user's environment says NODE_ENV=production", () => {
      setEnv({ AGENTFORGE_PACKAGED: "1", AGENTFORGE_BRAND_GATEWAY_URL: AIHUB, NODE_ENV: "production" });
      expect(resolvedGatewayBaseUrl()).toBe(AIHUB);
    });

    it.each([
      ["plain http", "http://aihub.metranet.co.id/v1"],
      ["a loopback http URL", "http://127.0.0.1:8080/v1"],
      ["credentials in the URL", "https://user:secret@aihub.metranet.co.id/v1"],
      ["a non-URL", "not a url"],
      ["another scheme", "file:///etc/passwd"],
    ])("falls back to the pinned gateway for a brand gateway that is %s", (_label, value) => {
      setEnv({ AGENTFORGE_PACKAGED: "1", AGENTFORGE_BRAND_GATEWAY_URL: value });
      expect(gatewayUrlOverride()).toBeNull();
      expect(resolvedGatewayBaseUrl()).toBe(PINNED_GATEWAY_BASE_URL);
    });

    it("only AGENTFORGE_PACKAGED=1 counts as packaged", () => {
      for (const value of ["0", "true", "", " "]) {
        setEnv({ AGENTFORGE_PACKAGED: value, NODE_ENV: "test", AGENTFORGE_GATEWAY_URL: AIHUB });
        expect(isPackagedRuntime()).toBe(false);
        expect(resolvedGatewayBaseUrl()).toBe(AIHUB);
      }
    });

    it("keeps the Telegram origin pinned too, because it shares the dev-hook rule", () => {
      setEnv({ AGENTFORGE_PACKAGED: "1", AGENTFORGE_TELEGRAM_API_URL: "http://127.0.0.1:3399" });
      expect(resolvedTelegramApiOrigin()).toBe(PINNED_TELEGRAM_API_ORIGIN);
      setEnv({ NODE_ENV: "test", AGENTFORGE_TELEGRAM_API_URL: "http://127.0.0.1:3399" });
      expect(resolvedTelegramApiOrigin()).toBe("http://127.0.0.1:3399");
    });
  });
});
