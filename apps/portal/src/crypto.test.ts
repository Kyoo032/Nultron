/** The portal's secret-minting helpers. Invite codes are the newest one. */
import { describe, expect, it } from "vitest";
import { INVITE_CODE_CHARS, normaliseInviteCode, randomInviteCode } from "./crypto";

describe("invite codes", () => {
  it("are twenty characters from the unambiguous alphabet, shown in groups of five", () => {
    const code = randomInviteCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}(-[A-HJ-NP-Z2-9]{5}){3}$/);
    expect(normaliseInviteCode(code)).toHaveLength(INVITE_CODE_CHARS);
  });

  it("carry about a hundred bits, so a repeat inside a thousand draws would mean a broken source", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      seen.add(randomInviteCode());
    }
    expect(seen.size).toBe(1000);
  });

  it("normalise away case, dashes and spaces, which is what a person pasting one will add", () => {
    const code = randomInviteCode();
    const bare = code.replace(/-/g, "");
    expect(normaliseInviteCode(code.toLowerCase())).toBe(bare);
    expect(normaliseInviteCode(`  ${code.replace(/-/g, " ")}  `)).toBe(bare);
    expect(normaliseInviteCode(bare)).toBe(bare);
  });

  it("normalise junk to something that cannot match, rather than throwing", () => {
    expect(normaliseInviteCode("")).toBe("");
    expect(normaliseInviteCode("!!!")).toBe("");
    expect(normaliseInviteCode("\u0000‮")).toBe("");
  });
});
