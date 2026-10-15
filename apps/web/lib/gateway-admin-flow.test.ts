import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayAdminInput, GatewayAdminResult, GatewayAdminState } from "./gateway-admin-client";
import { accountIdFrom, runRemove, runSave, statusKey, type GatewayAdminClient } from "./gateway-admin-flow";
import { applyLocale, resetLocaleForTests, t } from "./i18n";

const SENTINEL = "gw-mgmt-SENTINEL-7f3a9c";
const OK: GatewayAdminState = { configured: true, accountIdSet: false, checkedAt: null, status: "ok" };

function fakeClient(result: GatewayAdminResult = { ok: true, state: OK }) {
  const read = vi.fn<() => Promise<GatewayAdminResult>>(async () => result);
  const save = vi.fn<(input: GatewayAdminInput) => Promise<GatewayAdminResult>>(async () => result);
  const remove = vi.fn<() => Promise<GatewayAdminResult>>(async () => result);
  return { client: { read, save, remove } satisfies GatewayAdminClient, read, save, remove };
}

beforeEach(() => {
  applyLocale("en");
});

afterEach(() => {
  resetLocaleForTests();
});

describe("accountIdFrom", () => {
  it("leaves the account id out when the field is blank", () => {
    expect(accountIdFrom("")).toEqual({ ok: true });
    expect(accountIdFrom("   ")).toEqual({ ok: true });
  });

  it("reads a whole number above zero, trimmed", () => {
    expect(accountIdFrom("42")).toEqual({ ok: true, accountId: 42 });
    expect(accountIdFrom(" 7 ")).toEqual({ ok: true, accountId: 7 });
  });

  it("refuses zero, negatives, fractions, exponents, words and numbers past the safe range", () => {
    for (const text of ["0", "-3", "1.5", "1e3", "abc", "9007199254740993"]) {
      expect(accountIdFrom(text), text).toEqual({ ok: false });
    }
  });
});

describe("statusKey and its words", () => {
  it("maps each host status to its catalog sentence in English", () => {
    const expected: Array<[GatewayAdminState["status"], string]> = [
      ["ok", "Connected"],
      ["invalid", "Not accepted by the gateway"],
      ["unreachable", "Gateway not reachable"],
      ["unchecked", "Not checked"],
    ];
    for (const [status, words] of expected) {
      const state = { ...OK, status };
      expect(t(statusKey(state))).toBe(words);
    }
  });

  it("says no token is saved when the company has none, whatever the status", () => {
    expect(t(statusKey({ ...OK, configured: false, status: "ok" }))).toBe("No token saved");
  });

  it("speaks Indonesian when the desk does", () => {
    applyLocale("id");
    expect(t(statusKey({ ...OK, status: "ok" }))).toBe("Terhubung");
    expect(t(statusKey({ ...OK, status: "invalid" }))).toBe("Tidak diterima oleh gateway");
  });
});

describe("runSave", () => {
  it("refuses an empty token without calling the gateway", async () => {
    const { client, save } = fakeClient();
    await expect(runSave({ token: "   ", accountIdText: "" }, client)).resolves.toEqual({
      ok: false,
      error: "Paste the management token first.",
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses an account id that is not a whole number, without calling the gateway", async () => {
    const { client, save } = fakeClient();
    await expect(runSave({ token: SENTINEL, accountIdText: "abc" }, client)).resolves.toEqual({
      ok: false,
      error: "The account ID must be a whole number above zero.",
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("sends the trimmed token and the account id as a number", async () => {
    const { client, save } = fakeClient();
    await runSave({ token: `  ${SENTINEL}  `, accountIdText: "42" }, client);
    expect(save).toHaveBeenCalledWith({ token: SENTINEL, accountId: 42 });
  });

  it("sends no accountId key when the field is blank", async () => {
    const { client, save } = fakeClient();
    await runSave({ token: SENTINEL, accountIdText: "" }, client);
    expect(Object.keys(save.mock.calls[0]?.[0] ?? {})).toEqual(["token"]);
  });

  it("answers Saved with the state, and the token appears nowhere in the outcome", async () => {
    const { client } = fakeClient({ ok: true, state: OK });
    const outcome = await runSave({ token: SENTINEL, accountIdText: "" }, client);
    expect(outcome).toEqual({ ok: true, state: OK, message: "Saved" });
    expect(JSON.stringify(outcome)).not.toContain(SENTINEL);
  });

  it("shows the owner-or-admin sentence on a refusal", async () => {
    const { client } = fakeClient({ ok: false, reason: "forbidden" });
    await expect(runSave({ token: SENTINEL, accountIdText: "" }, client)).resolves.toEqual({
      ok: false,
      error: "Only an owner or admin can change the gateway management token.",
    });
  });

  it("shows the save sentence on any other failure", async () => {
    const { client } = fakeClient({ ok: false, reason: "failed" });
    await expect(runSave({ token: SENTINEL, accountIdText: "" }, client)).resolves.toEqual({
      ok: false,
      error: "Could not save the gateway management token. Try again in a moment.",
    });
  });
});

describe("runRemove", () => {
  it("answers Removed with the state the host reports", async () => {
    const empty: GatewayAdminState = { configured: false, accountIdSet: false, checkedAt: null, status: "unchecked" };
    const { client, remove } = fakeClient({ ok: true, state: empty });
    await expect(runRemove(client)).resolves.toEqual({ ok: true, state: empty, message: "Removed" });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("shows the owner-or-admin sentence on a refusal, and the remove sentence otherwise", async () => {
    await expect(runRemove(fakeClient({ ok: false, reason: "forbidden" }).client)).resolves.toEqual({
      ok: false,
      error: "Only an owner or admin can change the gateway management token.",
    });
    await expect(runRemove(fakeClient({ ok: false, reason: "failed" }).client)).resolves.toEqual({
      ok: false,
      error: "Could not remove the gateway management token. Try again in a moment.",
    });
  });
});
