import { describe, expect, it } from "vitest";
import { redactCredentials, redactSecrets } from "./redact";
import { redactSecretsDeep } from "./redact-deep";

const BUDGET_MS = 250;

function timed<T>(run: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = run();
  return { value, ms: performance.now() - start };
}

const HOSTILE: ReadonlyArray<readonly [string, string]> = [
  ["a cookie header followed by 100k spaces", `cookie:${" ".repeat(100_000)}`],
  ["a set-cookie header followed by tabs and spaces", `Set-Cookie:${"\t ".repeat(50_000)}x`],
  ["a cookie header followed by spaces and a word with no equals sign", `cookie:${" ".repeat(100_000)}x`],
  ["the word cookie and a colon repeated 15k times on one line", "cookie:".repeat(15_000)],
  ["a spaced cookie header repeated on one line", "cookie : ".repeat(11_000)],
];

describe("redactCredentials: a cookie header cannot be turned into a slow input", () => {
  it.each(HOSTILE)("%s", (_name, input) => {
    const { value, ms } = timed(() => redactCredentials(input));
    expect(value).toBe(input);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("is as fast through redactSecrets and redactSecretsDeep", () => {
    const input = `cookie:${" ".repeat(100_000)}`;
    const shallow = timed(() => redactSecrets(input));
    const deep = timed(() => redactSecretsDeep({ output: { page: input } }));
    expect(shallow.ms).toBeLessThan(BUDGET_MS);
    expect(deep.ms).toBeLessThan(BUDGET_MS);
    expect(deep.value).toEqual({ output: { page: input } });
  });

  it("still masks a long cookie header that holds a name=value pair", () => {
    const padding = " ".repeat(100_000);
    const { value, ms } = timed(() => redactCredentials(`Cookie:${padding}sid=abc123; theme=dark\nnext line`));
    expect(value).toBe(`Cookie:${padding}[REDACTED]\nnext line`);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("masks the header on its own line and leaves a cookie sentence on the line before it", () => {
    expect(redactCredentials("a cookie: is a biscuit\nCookie: sid=abc")).toBe(
      "a cookie: is a biscuit\nCookie: [REDACTED]",
    );
  });
});
