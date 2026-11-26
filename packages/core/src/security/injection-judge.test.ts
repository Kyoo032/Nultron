import { afterEach, describe, expect, it } from "vitest";
import {
  installJudgeUsageSink,
  injectionJudgeMinChars,
  INJECTION_JUDGE_MIN_CHARS_DEFAULT,
  judgeUntrusted,
  setJudgeCallForTests,
} from "./injection-judge";
import type { TenantContext } from "../tenancy/types";

const tenant: TenantContext = {
  tenantId: "t1",
  organizationId: "o1",
  workspaceId: "w1",
  userId: "u1",
  role: "builder",
};

afterEach(() => {
  setJudgeCallForTests(null);
  installJudgeUsageSink(null);
});

describe("judgeUntrusted", () => {
  it("skips payloads under the size threshold without calling the judge", async () => {
    let called = 0;
    setJudgeCallForTests(async () => {
      called += 1;
      return { malicious: true, category: "x", inputTokens: 1, outputTokens: 1 };
    });
    expect(await judgeUntrusted("short", tenant)).toBeNull();
    expect(called).toBe(0);
  });

  it("asks the judge on masked text only and meters the call", async () => {
    let body = "";
    const ledger: { model: string; inputTokens: number; outputTokens: number }[] = [];
    // A shape the masker definitely rewrites — the judge must never see it.
    const piiText = `${"data ".repeat(120)}rina.wijaya@example.com ${"more ".repeat(60)}`;
    setJudgeCallForTests(async (masked) => {
      body = masked;
      return { malicious: true, category: "exfil", inputTokens: 100, outputTokens: 5 };
    });
    installJudgeUsageSink((t, usage) => {
      expect(t.tenantId).toBe("t1");
      ledger.push(usage);
    });
    const verdict = await judgeUntrusted(piiText, tenant);
    expect(verdict).toEqual({ malicious: true, category: "exfil" });
    // S1: whatever the judge was shown, the raw PII digits are not in it.
    expect(body).not.toContain("rina.wijaya@example.com");
    // The ledger row under the judge's own mode.
    expect(ledger).toHaveLength(1);
    expect(ledger[0].inputTokens).toBe(100);
  });

  it("fails open when the judge itself fails", async () => {
    setJudgeCallForTests(async () => {
      throw new Error("gateway down");
    });
    expect(await judgeUntrusted("x".repeat(INJECTION_JUDGE_MIN_CHARS_DEFAULT + 10), tenant)).toBeNull();
  });

  it("honours AGENTFORGE_INJECTION_JUDGE_MIN_CHARS", async () => {
    const prev = process.env.AGENTFORGE_INJECTION_JUDGE_MIN_CHARS;
    try {
      process.env.AGENTFORGE_INJECTION_JUDGE_MIN_CHARS = "10";
      expect(injectionJudgeMinChars()).toBe(10);
      let called = 0;
      setJudgeCallForTests(async () => {
        called += 1;
        return { malicious: false, category: "benign", inputTokens: 0, outputTokens: 0 };
      });
      expect(await judgeUntrusted("twenty characters here", tenant)).toEqual({ malicious: false, category: "benign" });
      expect(called).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.AGENTFORGE_INJECTION_JUDGE_MIN_CHARS;
      else process.env.AGENTFORGE_INJECTION_JUDGE_MIN_CHARS = prev;
    }
  });
});
