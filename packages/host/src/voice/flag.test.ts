/**
 * Who gets the mic. Voice is off unless `AGENTFORGE_VOICE` is on, and on a hosted server it also needs the
 * person on `AGENTFORGE_VOICE_OWNERS`. The first test is the Personal parity one: with nothing set, both
 * products answer `enabled: false`.
 */
import { LOCAL_TENANT_ID, type TenantContext } from "@agentforge/core";
import { describe, expect, it } from "vitest";
import { VOICE_DEFAULT_MODEL, VOICE_DEFAULT_VOICE, voiceSettingsFor } from "./flag";

const OFF = { enabled: false, model: null };

function tenant(userId: string): TenantContext {
  return { tenantId: LOCAL_TENANT_ID, organizationId: "org-1", workspaceId: "ws-1", userId, role: "owner" };
}

describe("voiceSettingsFor", () => {
  it("is off by default, on Personal and on the hosted server", () => {
    expect(voiceSettingsFor(tenant("user-a"), {}, false)).toEqual(OFF);
    expect(voiceSettingsFor(tenant("user-a"), {}, true)).toEqual(OFF);
    // The owner list and the model alone never turn it on.
    const noFlag = { AGENTFORGE_VOICE_OWNERS: "user-a", AGENTFORGE_VOICE_MODEL: "some-model" };
    expect(voiceSettingsFor(tenant("user-a"), noFlag, false)).toEqual(OFF);
    expect(voiceSettingsFor(tenant("user-a"), noFlag, true)).toEqual(OFF);
  });

  it("reads server mode from the env it is given when the caller does not say", () => {
    expect(voiceSettingsFor(tenant("user-a"), { AGENTFORGE_VOICE: "on" })).toEqual({
      enabled: true,
      model: VOICE_DEFAULT_MODEL,
    });
    expect(voiceSettingsFor(tenant("user-a"), { AGENTFORGE_VOICE: "on", AGENTFORGE_SERVER: "1" })).toEqual(OFF);
  });

  it("is on with the flag alone off server mode, with the default model", () => {
    expect(voiceSettingsFor(tenant("user-a"), { AGENTFORGE_VOICE: "on" }, false)).toEqual({
      enabled: true,
      model: VOICE_DEFAULT_MODEL,
    });
    expect(VOICE_DEFAULT_MODEL).toBe("qwen3.5-omni-flash");
    expect(VOICE_DEFAULT_VOICE).toBe("Tina");
  });

  it.each(["on", "ON", " On ", "1", "true", "TRUE"])("reads %j as on", (value) => {
    expect(voiceSettingsFor(tenant("user-a"), { AGENTFORGE_VOICE: value }, false).enabled).toBe(true);
  });

  it.each(["", "   ", "off", "0", "false", "yes", "onn"])("reads %j as off, a typo included", (value) => {
    expect(voiceSettingsFor(tenant("user-a"), { AGENTFORGE_VOICE: value }, false)).toEqual(OFF);
  });

  it("server mode with the flag but no owner list is off", () => {
    expect(voiceSettingsFor(tenant("user-a"), { AGENTFORGE_VOICE: "on" }, true)).toEqual(OFF);
    expect(voiceSettingsFor(tenant("user-a"), { AGENTFORGE_VOICE: "on", AGENTFORGE_VOICE_OWNERS: "  " }, true)).toEqual(OFF);
    expect(voiceSettingsFor(tenant("user-a"), { AGENTFORGE_VOICE: "on", AGENTFORGE_VOICE_OWNERS: ",," }, true)).toEqual(OFF);
  });

  it("server mode with a listed person is on, trimmed and case-insensitive", () => {
    const env = { AGENTFORGE_VOICE: "on", AGENTFORGE_VOICE_OWNERS: "user-z,  User-A ,user-q" };
    expect(voiceSettingsFor(tenant("user-a"), env, true)).toEqual({ enabled: true, model: VOICE_DEFAULT_MODEL });
    expect(voiceSettingsFor(tenant("USER-Z"), env, true).enabled).toBe(true);
  });

  it("server mode with another person is off", () => {
    const env = { AGENTFORGE_VOICE: "on", AGENTFORGE_VOICE_OWNERS: "user-a" };
    expect(voiceSettingsFor(tenant("user-b"), env, true)).toEqual(OFF);
    // A longer id that merely starts with a listed one is another person.
    expect(voiceSettingsFor(tenant("user-ab"), env, true)).toEqual(OFF);
    expect(voiceSettingsFor(tenant(""), env, true)).toEqual(OFF);
  });

  it("the owner list is ignored off server mode", () => {
    const env = { AGENTFORGE_VOICE: "on", AGENTFORGE_VOICE_OWNERS: "someone-else" };
    expect(voiceSettingsFor(tenant("user-a"), env, false).enabled).toBe(true);
  });

  it("AGENTFORGE_VOICE_MODEL overrides the model, trimmed, and only when enabled", () => {
    const on = { AGENTFORGE_VOICE: "on", AGENTFORGE_VOICE_MODEL: "  qwen-test  " };
    expect(voiceSettingsFor(tenant("user-a"), on, false)).toEqual({ enabled: true, model: "qwen-test" });
    expect(voiceSettingsFor(tenant("user-a"), { ...on, AGENTFORGE_VOICE_MODEL: "   " }, false).model).toBe(VOICE_DEFAULT_MODEL);
    expect(voiceSettingsFor(tenant("user-a"), { AGENTFORGE_VOICE_MODEL: "qwen-test" }, false)).toEqual(OFF);
  });
});
