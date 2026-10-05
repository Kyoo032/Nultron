import { describe, expect, it } from "vitest";
import { parseDoctorOutput } from "./doctor";

const OK_OUTPUT = `{
  "ok": true,
  "url": "http://127.0.0.1:3000",
  "runtime": "ai",
  "hasOpenai": true
}

verify-agentforge doctor: OK — live runtime (a provider key is saved).
`;

describe("parseDoctorOutput", () => {
  it("keeps the JSON object and the verdict line", () => {
    const report = parseDoctorOutput(OK_OUTPUT, 0);
    expect(report.ok).toBe(true);
    expect(report.json).toEqual({ ok: true, url: "http://127.0.0.1:3000", runtime: "ai", hasOpenai: true });
    expect(report.verdict).toBe("verify-agentforge doctor: OK — live runtime (a provider key is saved).");
  });

  it("is not ok when the doctor exited non-zero, even with JSON on stdout", () => {
    expect(parseDoctorOutput(OK_OUTPUT, 1).ok).toBe(false);
  });

  it("is not ok when there is no JSON", () => {
    const report = parseDoctorOutput("verify-agentforge doctor: FAIL — nothing listening\n", 1);
    expect(report.ok).toBe(false);
    expect(report.json).toBeNull();
    expect(report.verdict).toBe("verify-agentforge doctor: FAIL — nothing listening");
  });

  it("is not ok when the JSON says ok is false", () => {
    expect(parseDoctorOutput('{"ok": false}\nverdict', 0).ok).toBe(false);
  });
});
