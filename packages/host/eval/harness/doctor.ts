/**
 * The verify skill's doctor (`.cursor/skills/verify-agentforge/scripts/doctor.mjs`) as a step of the
 * run: a billed drive never starts on an instance nobody checked. The doctor prints one JSON object and
 * then a verdict line; the JSON is what the evidence folder keeps.
 */
import { spawnSync } from "node:child_process";

export type DoctorReport = {
  ok: boolean;
  json: Record<string, unknown> | null;
  verdict: string;
  exitCode: number | null;
};

/** The JSON object in the doctor's stdout, and the last line after it. */
export function parseDoctorOutput(stdout: string, exitCode: number | null): DoctorReport {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  let json: Record<string, unknown> | null = null;
  if (start !== -1 && end > start) {
    try {
      const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
      json =
        parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      json = null;
    }
  }
  const verdict = stdout.trim().split(/\r?\n/).pop()?.trim() ?? "";
  return { ok: exitCode === 0 && json !== null && json.ok === true, json, verdict, exitCode };
}

export function runDoctor(doctorPath: string, base: string): DoctorReport {
  const result = spawnSync(process.execPath, [doctorPath, "--base", base], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  const stdout = `${result.stdout ?? ""}`;
  const report = parseDoctorOutput(stdout, result.status);
  return report.ok || report.json ? report : { ...report, verdict: report.verdict || `${result.stderr ?? ""}`.trim() };
}
