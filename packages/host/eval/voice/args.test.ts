import { describe, expect, it } from "vitest";
import { FORBIDDEN_PORTS, UsageError, parseVoiceArgs, portOf, requireAllowedBase } from "./args";
import { CASE_IDS } from "./cases";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const parse = (argv: string[]) => parseVoiceArgs(argv, { caseIds: CASE_IDS, now: NOW });

describe("the port refusal", () => {
  it("refuses 3000 and 3200 on loopback, by every spelling", () => {
    for (const url of [
      "http://127.0.0.1:3000",
      "http://localhost:3000",
      "http://[::1]:3000",
      "http://127.0.0.1:3200",
      "http://localhost:3200/",
      "https://127.0.0.1:3000",
      "http://127.0.0.1:03000",
    ]) {
      expect(() => requireAllowedBase(url), url).toThrow(UsageError);
    }
  });

  it("refuses them on any host, not only on this machine", () => {
    for (const url of ["https://staging.example.com:3000", "http://192.168.1.20:3200", "http://desk.local:3000/api"]) {
      expect(() => requireAllowedBase(url), url).toThrow(/refusing to run against port/);
    }
  });

  it("says which port and that there is no override", () => {
    expect(() => requireAllowedBase("http://127.0.0.1:3200")).toThrow(/port 3200/);
    expect(() => requireAllowedBase("http://127.0.0.1:3000")).toThrow(/no override/);
    expect(FORBIDDEN_PORTS).toEqual([3000, 3200]);
  });

  it("has no flag to turn it off", () => {
    expect(() => parse(["--base-url", "http://127.0.0.1:3000", "--force"])).toThrow(UsageError);
    expect(() => parse(["--base-url", "http://127.0.0.1:3000", "--allow-port", "3000"])).toThrow(UsageError);
    expect(() => parse(["--base-url", "http://127.0.0.1:3200"])).toThrow(/refusing/);
  });

  it("allows other ports and the scheme defaults", () => {
    expect(requireAllowedBase("http://127.0.0.1:3300/some/path?x=1")).toBe("http://127.0.0.1:3300");
    expect(requireAllowedBase("http://localhost:3001")).toBe("http://localhost:3001");
    expect(requireAllowedBase("https://staging.example.com")).toBe("https://staging.example.com");
    expect(portOf(new URL("http://x"))).toBe(80);
    expect(portOf(new URL("https://x"))).toBe(443);
    expect(portOf(new URL("http://x:3300"))).toBe(3300);
  });

  it("refuses what is not a URL or not http", () => {
    expect(() => requireAllowedBase("not a url")).toThrow(/must be a URL/);
    expect(() => requireAllowedBase("ftp://127.0.0.1:3300")).toThrow(/http or https/);
  });
});

describe("the flags", () => {
  it("requires --base-url", () => {
    expect(() => parse([])).toThrow(/--base-url is required/);
  });

  it("reads every flag", () => {
    const args = parse([
      "--base-url",
      "http://127.0.0.1:3300",
      "--case",
      "turns-saved",
      "--case",
      "latency-fact,latency-smalltalk",
      "--repeat",
      "3",
      "--out",
      "out.json",
      "--compare",
      "before.json",
      "--locale",
      "en",
      "--show-text",
      "--no-cleanup",
    ]);
    expect(args).toMatchObject({
      baseUrl: "http://127.0.0.1:3300",
      repeat: 3,
      out: "out.json",
      compare: "before.json",
      locale: "en",
      showText: true,
      noCleanup: true,
    });
    // The cases keep their fixed order whatever order the flags named them in.
    expect(args.cases).toEqual(["latency-smalltalk", "latency-fact", "turns-saved"]);
  });

  it("defaults to every case, five runs, Indonesian, hidden text and cleanup", () => {
    const args = parse(["--base-url", "http://127.0.0.1:3300"]);
    expect(args.cases).toEqual([...CASE_IDS]);
    expect(args).toMatchObject({ repeat: 5, locale: "id", showText: false, noCleanup: false, out: null, compare: null });
    expect(args.runId).toBe("2026-11-10T12-00-00-000Z");
  });

  it("refuses an unknown case, a bad repeat and a bad locale", () => {
    expect(() => parse(["--base-url", "http://127.0.0.1:3300", "--case", "nope"])).toThrow(/unknown case "nope"/);
    for (const repeat of ["0", "-1", "2.5", "abc", "51"]) {
      expect(() => parse(["--base-url", "http://127.0.0.1:3300", "--repeat", repeat]), repeat).toThrow(/--repeat/);
    }
    expect(() => parse(["--base-url", "http://127.0.0.1:3300", "--locale", "fr"])).toThrow(/--locale/);
  });

  it("lists cases and prints help without a base url", () => {
    expect(parse(["--list"]).list).toBe(true);
    expect(parse(["--help"]).help).toBe(true);
  });

  it("knows the fourteen cases", () => {
    expect(CASE_IDS).toEqual([
      "latency-smalltalk",
      "latency-fact",
      "latency-long",
      "fact-routes-to-desk",
      "task-becomes-card",
      "unfinished-waits",
      "pause-mid-sentence",
      "barge-in-stops",
      "backchannel-resumes",
      "push-to-talk",
      "turns-saved",
      "second-session-replaces",
      "upgrade-needs-origin",
      "end-is-idempotent",
    ]);
  });
});
