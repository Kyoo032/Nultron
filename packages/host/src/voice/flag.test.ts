/**
 * Who gets the mic. Voice is on by default unless explicitly disabled via `AGENTFORGE_VOICE=off|0|false`.
 * In server mode, an unset or blank `AGENTFORGE_VOICE_OWNERS` allows any authenticated user; when set,
 * access is restricted to the listed userIds.
 */
import { LOCAL_TENANT_ID, type TenantContext } from "@agentforge/core";
import { describe, expect, it } from "vitest";
import { VOICE_DEFAULT_MODEL, VOICE_DEFAULT_VOICE, voiceSettingsFor } from "./flag";

const OFF = { enabled: false, model: null };
const ON_DEFAULT = { enabled: true, model: VOICE_DEFAULT_MODEL };

function tenant(userId: string): TenantContext {
  return { tenantId: LOCAL_TENANT_ID, organizationId: "org-1", workspaceId: "ws-1", userId, role: "owner" };
}

describe("voiceSettingsFor", () => {
  it("is on by default, on desk and on the hosted server", () => {
    expect(voiceSettingsFor(tenant("user-a"), {}, false)).toEqual(ON_DEFAULT);
    expect(voiceSettingsFor(tenant("user-a"), {}, true)).toEqual(ON_DEFAULT);
    expect(VOICE_DEFAULT_MODEL).toBe("qwen3.5-omni-flash");
    expect(VOICE_DEFAULT_VOICE).toBe("Tina");
  });

  it("reads server mode from the env it is given when the caller does not say", () => {
    expect(voiceSettingsFor(tenant("user-a"), {})).toEqual(ON_DEFAULT);
    expect(voiceSettingsFor(tenant("user-a"), { AGENTFORGE_SERVER: "1" })).toEqual(ON_DEFAULT);
    expect(voiceSettingsFor(tenant("user-a"), { AGENTFORGE_SERVER: "1", AGENTFORGE_VOICE: "off" })).toEqual(OFF);
  });

  it.each(["off", "OFF", " Off ", "0", "false", "FALSE"])("honors explicit kill-switch %j", (value) => {
    expect(voiceSettingsFor(tenant("user-a"), { AGENTFORGE_VOICE: value }, false)).toEqual(OFF);
    expect(voiceSettingsFor(tenant("user-a"), { AGENTFORGE_VOICE: value }, true)).toEqual(OFF);
  });

  it.each(["on", "ON", " On ", "1", "true", "TRUE", "", "   "])("treats %j as enabled", (value) => {
    expect(voiceSettingsFor(tenant("user-a"), { AGENTFORGE_VOICE: value }, false).enabled).toBe(true);
    expect(voiceSettingsFor(tenant("user-a"), { AGENTFORGE_VOICE: value }, true).enabled).toBe(true);
  });

  it("server mode with unset or blank owner list allows all authenticated users", () => {
    expect(voiceSettingsFor(tenant("user-a"), {}, true)).toEqual(ON_DEFAULT);
    expect(voiceSettingsFor(tenant("user-b"), { AGENTFORGE_VOICE_OWNERS: "  " }, true)).toEqual(ON_DEFAULT);
    expect(voiceSettingsFor(tenant("user-c"), { AGENTFORGE_VOICE_OWNERS: ",," }, true)).toEqual(ON_DEFAULT);
  });

  it("server mode with an explicit owner list allows listed users, trimmed and case-insensitive", () => {
    const env = { AGENTFORGE_VOICE_OWNERS: "user-z,  User-A ,user-q" };
    expect(voiceSettingsFor(tenant("user-a"), env, true)).toEqual(ON_DEFAULT);
    expect(voiceSettingsFor(tenant("USER-Z"), env, true).enabled).toBe(true);
  });

  it("server mode with an explicit owner list excludes unlisted users", () => {
    const env = { AGENTFORGE_VOICE_OWNERS: "user-a" };
    expect(voiceSettingsFor(tenant("user-b"), env, true)).toEqual(OFF);
    // A longer id that merely starts with a listed one is another person.
    expect(voiceSettingsFor(tenant("user-ab"), env, true)).toEqual(OFF);
    expect(voiceSettingsFor(tenant(""), env, true)).toEqual(OFF);
  });

  it("the owner list is ignored off server mode", () => {
    const env = { AGENTFORGE_VOICE_OWNERS: "someone-else" };
    expect(voiceSettingsFor(tenant("user-a"), env, false).enabled).toBe(true);
  });

  it("AGENTFORGE_VOICE_MODEL overrides the model, trimmed, and respects kill-switch", () => {
    expect(voiceSettingsFor(tenant("user-a"), { AGENTFORGE_VOICE_MODEL: "  qwen-test  " }, false)).toEqual({
      enabled: true,
      model: "qwen-test",
    });
    expect(voiceSettingsFor(tenant("user-a"), { AGENTFORGE_VOICE_MODEL: "   " }, false).model).toBe(
      VOICE_DEFAULT_MODEL,
    );
    expect(
      voiceSettingsFor(tenant("user-a"), { AGENTFORGE_VOICE: "off", AGENTFORGE_VOICE_MODEL: "qwen-test" }, false),
    ).toEqual(OFF);
  });
});
