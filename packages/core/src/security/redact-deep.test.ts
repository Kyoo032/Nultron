import { describe, expect, it } from "vitest";
import { redactCredentials } from "./redact";
import { redactSecretsDeep } from "./redact-deep";

const GATEWAY_KEY = "sk-live-0123456789abcdefABCDEF";
const BEARER = "Bearer abcdefghijklmnop1234567890";

describe("redactCredentials", () => {
  it("masks key prefixes and bearer tokens", () => {
    expect(redactCredentials(`use ${GATEWAY_KEY} please`)).toBe("use [REDACTED] please");
    expect(redactCredentials(`Authorization: ${BEARER}`)).toBe("Authorization: Bearer [REDACTED]");
    expect(redactCredentials("tvly-abcdefghijkl and AIzaSyA1234567890abcdef")).toBe("[REDACTED] and [REDACTED]");
  });

  it("does not apply the opaque-token rule: a hash or a signed link stays readable", () => {
    const sha = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    const url = `https://cdn.example.com/a.png?sig=${sha}`;
    expect(redactCredentials(sha)).toBe(sha);
    expect(redactCredentials(url)).toBe(url);
  });

  it("returns an empty string unchanged", () => {
    expect(redactCredentials("")).toBe("");
  });
});

describe("redactSecretsDeep", () => {
  it("redacts credential-shaped text at any depth of an object or array", () => {
    const input = {
      path: "notes/plan.md",
      content: `key=${GATEWAY_KEY}`,
      nested: { list: ["fine", `h: ${BEARER}`, { deeper: GATEWAY_KEY }] },
    };
    expect(redactSecretsDeep(input)).toEqual({
      path: "notes/plan.md",
      content: "key=[REDACTED]",
      nested: { list: ["fine", "h: Bearer [REDACTED]", { deeper: "[REDACTED]" }] },
    });
  });

  it("redacts the value of a secret-named key even when it has no known shape", () => {
    const input = {
      headers: { Authorization: "opaque-value-with-no-prefix", "x-api-key": "abc", Accept: "text/html" },
      apiKey: "xyz",
      api_key: "xyz",
      password: "hunter2",
      token: "t0k3n",
      refresh_token: "r",
      note: "the word token in text is fine",
    };
    expect(redactSecretsDeep(input)).toEqual({
      headers: { Authorization: "[REDACTED]", "x-api-key": "[REDACTED]", Accept: "text/html" },
      apiKey: "[REDACTED]",
      api_key: "[REDACTED]",
      password: "[REDACTED]",
      token: "[REDACTED]",
      refresh_token: "[REDACTED]",
      note: "the word token in text is fine",
    });
  });

  it.each([
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "DB_PASSWORD",
    "DATABASE_PASSWD",
    "aws_secret_access_key",
    "AWS_SECRET_ACCESS_KEY",
    "STRIPE_SECRET_KEY",
    "JWT_SECRET",
    "GITHUB_TOKEN",
    "github-token",
    "x-slack-bot-token",
    "dbPassword",
    "githubToken",
    "openaiApiKey",
    "awsSecretAccessKey",
  ])("masks the value of a key that ends in a secret name: %s", (key) => {
    expect(redactSecretsDeep({ [key]: "opaque-not-prefixed" })).toEqual({ [key]: "[REDACTED]" });
  });

  it.each([
    "max_tokens",
    "maxTokens",
    "total_tokens",
    "tokenizer",
    "cache_key",
    "sortKey",
    "primary_key",
    "password_hint",
    "passwords_checked",
    "secretary",
    "keyboard",
    "author",
  ])("leaves a key that only contains a secret word alone: %s", (key) => {
    expect(redactSecretsDeep({ [key]: "plain value" })).toEqual({ [key]: "plain value" });
  });

  it("leaves a number or a nested object under a secret-named key to the normal walk", () => {
    expect(redactSecretsDeep({ token: 5, secret: { value: GATEWAY_KEY, count: 2 } })).toEqual({
      token: 5,
      secret: { value: "[REDACTED]", count: 2 },
    });
  });

  it("keeps what is not a secret: numbers, booleans, null, hashes, links, normal text", () => {
    const sha = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    const input = { n: 3, ok: true, none: null, sha256: sha, url: `https://x.test/${sha}.png`, text: "hello" };
    expect(redactSecretsDeep(input)).toEqual(input);
  });

  it("returns a new value and never mutates the input", () => {
    const input = Object.freeze({ a: Object.freeze({ k: GATEWAY_KEY }), list: Object.freeze([GATEWAY_KEY]) });
    const out = redactSecretsDeep(input) as { a: { k: string }; list: string[] };
    expect(out).not.toBe(input);
    expect(out.a).not.toBe(input.a);
    expect(out.a.k).toBe("[REDACTED]");
    expect(input.a.k).toBe(GATEWAY_KEY);
    expect(input.list[0]).toBe(GATEWAY_KEY);
  });

  it("passes primitives and undefined through", () => {
    expect(redactSecretsDeep(undefined)).toBeUndefined();
    expect(redactSecretsDeep(null)).toBeNull();
    expect(redactSecretsDeep(4)).toBe(4);
    expect(redactSecretsDeep(`x ${GATEWAY_KEY}`)).toBe("x [REDACTED]");
  });

  it("survives a cycle without throwing and without leaking through it", () => {
    const loop: Record<string, unknown> = { key: GATEWAY_KEY };
    loop.self = loop;
    const out = redactSecretsDeep(loop) as Record<string, unknown>;
    expect(out.key).toBe("[REDACTED]");
    expect(out.self).toBe("[circular]");
  });

  it("replaces a subtree past the depth limit instead of walking it or passing it on", () => {
    let deep: unknown = { leak: GATEWAY_KEY };
    for (let i = 0; i < 80; i += 1) {
      deep = { next: deep };
    }
    const text = JSON.stringify(redactSecretsDeep(deep));
    expect(text).not.toContain(GATEWAY_KEY);
    expect(text).toContain("[too deep]");
  });

  it("leaves a Date as it is", () => {
    const when = new Date("2026-10-06T00:00:00Z");
    expect(redactSecretsDeep({ when })).toEqual({ when });
  });

  it("handles a multi-megabyte string in one pass", () => {
    const big = `${"x ".repeat(1_000_000)}${GATEWAY_KEY}`;
    const out = redactSecretsDeep({ text: big }) as { text: string };
    expect(out.text.endsWith("[REDACTED]")).toBe(true);
    expect(out.text).not.toContain(GATEWAY_KEY);
  });
});
