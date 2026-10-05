import { describe, expect, it } from "vitest";
import { UsageError, parseHarnessArgs, runIdFor } from "./args";

const IDS = ["chat-plain", "chat-tool", "data", "documents", "presentation", "research"];
const DEFAULTS = {
  resultsDir: "/r",
  evidenceDir: "/e",
  caseIds: IDS,
  now: new Date("2026-10-03T07:12:45.123Z"),
};

describe("parseHarnessArgs", () => {
  it("runs every case against the local webdev by default", () => {
    const args = parseHarnessArgs([], DEFAULTS);
    expect(args.cases).toEqual(IDS);
    expect(args.base).toBe("http://127.0.0.1:3000");
    expect(args.runId).toBe("2026-10-03T07-12-45-123Z");
    expect(args.name).toBe("2026-10-03T07-12-45-123Z");
    expect(args.doctor).toBe(true);
    expect(args.cleanup).toBe(true);
  });

  it("selects and skips cases, in the fixed order", () => {
    expect(parseHarnessArgs(["--case", "data,chat-plain"], DEFAULTS).cases).toEqual(["chat-plain", "data"]);
    expect(parseHarnessArgs(["--case", "data", "--case", "research"], DEFAULTS).cases).toEqual(["data", "research"]);
    expect(parseHarnessArgs(["--skip", "research,data"], DEFAULTS).cases).toEqual([
      "chat-plain",
      "chat-tool",
      "documents",
      "presentation",
    ]);
  });

  it("names the result file after --name and the evidence folder after --run-id", () => {
    const args = parseHarnessArgs(["--name", "baseline", "--run-id", "h0-1"], DEFAULTS);
    expect(args.name).toBe("baseline");
    expect(args.runId).toBe("h0-1");
  });

  it("refuses an unknown case, an empty selection and a path-shaped name", () => {
    expect(() => parseHarnessArgs(["--case", "finance"], DEFAULTS)).toThrow(UsageError);
    expect(() => parseHarnessArgs(["--case", "data", "--skip", "data"], DEFAULTS)).toThrow("no case is left to run");
    expect(() => parseHarnessArgs(["--name", "../x"], DEFAULTS)).toThrow(UsageError);
    expect(() => parseHarnessArgs(["--run-id", "a/b"], DEFAULTS)).toThrow(UsageError);
  });

  it("refuses a base that is not loopback", () => {
    expect(() => parseHarnessArgs(["--base", "https://example.com"], DEFAULTS)).toThrow(
      "--base must be loopback (127.0.0.1 / localhost / ::1), got example.com",
    );
    expect(parseHarnessArgs(["--base", "http://localhost:4000/"], DEFAULTS).base).toBe("http://localhost:4000");
  });

  it("refuses a flag it does not know", () => {
    expect(() => parseHarnessArgs(["--fast"], DEFAULTS)).toThrow(UsageError);
  });
});

describe("runIdFor", () => {
  it("makes a file-safe stamp", () => {
    expect(runIdFor(new Date("2026-01-02T03:04:05.006Z"))).toBe("2026-01-02T03-04-05-006Z");
  });
});
