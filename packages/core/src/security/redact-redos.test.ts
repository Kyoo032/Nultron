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
  ["a long dotted run that is not a URL scheme", "a.".repeat(20_000)],
  ["a long hyphenated run that is not a URL scheme", "a-".repeat(20_000)],
  ["a scheme separator repeated with no address after it", "a://".repeat(25_000)],
  ["an Authorization header name followed by spaces", `Authorization${" ".repeat(100_000)}`],
  ["an Authorization header name repeated on one line", "authorization:".repeat(7_000)],
  ["an Authorization Basic header followed by spaces", `Authorization: Basic${" ".repeat(100_000)}`],
  ["a GitHub token prefix repeated", "ghp_".repeat(25_000)],
  ["a long upper-case name with no equals sign", "A".repeat(100_000)],
  ["a long upper-case name followed by spaces", `TOKEN${" ".repeat(100_000)}`],
  ["export followed by spaces", `export${" ".repeat(100_000)}`],
  ["a secret-named assignment with a blank value, repeated", "API_KEY=\n".repeat(11_000)],
  ["a secret-named assignment followed by spaces", `API_KEY=${" ".repeat(100_000)}`],
  ["a Stripe key prefix repeated", "sk_live_".repeat(12_500)],
  ["a Slack token prefix repeated", "xoxb-".repeat(20_000)],
  ["a Slack app token prefix repeated", "xapp-".repeat(20_000)],
  ["a Slack rotating token prefix repeated", "xoxe-".repeat(20_000)],
  ["an X-Api-Key header name followed by spaces", `X-Api-Key${" ".repeat(100_000)}`],
  ["an X-Api-Key header name and colon followed by spaces", `X-Api-Key:${" ".repeat(100_000)}`],
  ["an X-Api-Key header name and colon followed by a quote and spaces", `x-api-key:"${" ".repeat(100_000)}`],
  ["a JWT header prefix and a hyphen repeated", "eyJ-".repeat(25_000)],
  ["a JWT header prefix and a hyphen repeated, then two short dotted parts", `${"eyJ-".repeat(25_000)}.aaaaaaaa.`],
  ["a JWT header prefix and an underscore repeated", "eyJ_".repeat(25_000)],
  ["a long dotted run that ends in a JWT header prefix", `${"a.".repeat(50_000)}eyJ`],
  ["a JWT header and a first part repeated with no third part", "eyJaaaaaaaa.bbbbbbbb ".repeat(5_000)],
];

const HOSTILE_AND_MASKED: ReadonlyArray<readonly [string, string]> = [
  ["a long run after a GitHub token prefix", `ghp_${"a".repeat(100_000)}`],
  ["a Slack bot token shape repeated", "xoxb-1-".repeat(15_000)],
  ["a Slack app token shape repeated", "xapp-1-".repeat(15_000)],
  ["a Slack rotating token shape repeated", "xoxe-1-".repeat(15_000)],
  ["an encoded bearer prefix repeated", "Bearer%20".repeat(11_000)],
  ["a case-varied form-encoded bearer prefix repeated", "bEaReR+".repeat(14_000)],
  ["a long run after a Stripe key prefix", `sk_live_${"a".repeat(100_000)}`],
  ["an X-Api-Key header name and colon repeated", "x-api-key:".repeat(10_000)],
  ["a JWT header prefix and a hyphen repeated, then a whole dotted tail", `${"eyJ-".repeat(25_000)}.aaaaaaaa.aaaaaaaa`],
  ["a three-part JWT repeated", "eyJaaaaaaaa.eyJaaaaaaaa.eyJaaaaaaaa.".repeat(2_700)],
];

describe("redactCredentials: hostile input stays fast", () => {
  it.each(HOSTILE)("%s", (_name, input) => {
    const { value, ms } = timed(() => redactCredentials(input));
    expect(value).toBe(input);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it.each(HOSTILE_AND_MASKED)("%s", (_name, input) => {
    const { value, ms } = timed(() => redactCredentials(input));
    expect(value).toContain("[REDACTED]");
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

  it("is as fast on a long opaque run ending in dot-tilde tails through redactSecrets", () => {
    const input = `${"a".repeat(50_000)}${".~".repeat(25_000)}`;
    const { ms } = timed(() => redactSecrets(input));
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("is as fast on a repeated JWT header prefix through redactSecrets and redactSecretsDeep", () => {
    const input = `${"eyJ-".repeat(25_000)}.aaaaaaaa.`;
    const shallow = timed(() => redactSecrets(input));
    const deep = timed(() => redactSecretsDeep({ output: { page: input } }));
    expect(shallow.ms).toBeLessThan(BUDGET_MS);
    expect(deep.ms).toBeLessThan(BUDGET_MS);
  });

  it("still masks a long cookie header that holds a name=value pair", () => {
    const padding = " ".repeat(100_000);
    const { value, ms } = timed(() => redactCredentials(`Cookie:${padding}sid=abc123; theme=dark\nnext line`));
    expect(value).toBe(`Cookie:${padding}[REDACTED]\nnext line`);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("still masks the user and password of a URL that follows a long hyphenated run", () => {
    const run = "a-".repeat(50_000);
    const { value, ms } = timed(() => redactCredentials(`${run}http://user:pw@host/x`));
    expect(value).toBe(`${run}http://[REDACTED]@host/x`);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("masks the header on its own line and leaves a cookie sentence on the line before it", () => {
    expect(redactCredentials("a cookie: is a biscuit\nCookie: sid=abc")).toBe(
      "a cookie: is a biscuit\nCookie: [REDACTED]",
    );
  });
});
