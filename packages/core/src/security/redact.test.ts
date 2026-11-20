import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact";

describe("redactSecrets", () => {
  it("redacts Bearer tokens", () => {
    const input = "Authorization: Bearer sk-abc123-longerthantwentycharacters";
    const result = redactSecrets(input);
    expect(result).not.toContain("sk-abc123-longerthantwentycharacters");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts sk- style keys while preserving surrounding prompt text", () => {
    const input = "The key is sk-secret-key-value-here and the prompt says: answer me please";
    const result = redactSecrets(input);
    expect(result).not.toContain("sk-secret-key-value-here");
    expect(result).toContain("answer me please");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts sk-ant- Anthropic keys", () => {
    const input = "key=sk-ant-api03-verylongkeyvalue-AA";
    const result = redactSecrets(input);
    expect(result).not.toContain("sk-ant-api03-verylongkeyvalue-AA");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts tvly- Tavily API keys", () => {
    const input = "tvly-abc123xyz987-search-key";
    const result = redactSecrets(input);
    expect(result).not.toContain("tvly-abc123xyz987-search-key");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts AIza Google API keys", () => {
    const input = "google key: AIzaSyDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const result = redactSecrets(input);
    expect(result).not.toContain("AIzaSyDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts long base64-looking blobs (32+ chars)", () => {
    const blob = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";
    const input = `token=${blob} and normal text here`;
    const result = redactSecrets(input);
    expect(result).toContain("normal text here");
  });

  it.each([
    "abcdefghijklmnop-qrstuvwxyz123456",
    "abcdefghijklmnop.qrstuvwxyz123456",
    "abcdefghijklmnop_qrstuvwxyz123456",
    "abcdefghi-jklmnopq.rstuvwxy_z1234567",
  ])("redacts the whole standalone opaque token %s", (token) => {
    expect(redactSecrets(`Value: ...${token}. Next sentence.`)).toBe("Value: ...[REDACTED]. Next sentence.");
  });

  it.each([
    ["token my_secret_access_token_value_here", "token [REDACTED]"],
    ["random_words_may_also_form_a_token", "[REDACTED]"],
    ["event file_extract_native_converter_unavailable_copy", "event [REDACTED]"],
    [
      "event file_extract_native_converter_unavailable: token my_secret_access_token_value_here",
      "event file_extract_native_converter_unavailable: token [REDACTED]",
    ],
  ])("masks long snake_case values that are not known diagnostic labels: %s", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it.each([
    "failed at packages/core/src/security/redact-shapes.test.ts line 20",
    "GET https://example.com/some/fairly/long/path/segment/here 404",
    "GET /api/v1/recordings/archive/segment 404",
    "failed at C:\\project\\core\\file-with-an-extra-long-filename.test.ts line 20",
    "session 9f86d081-884c-7d65-9a2f-eaa0c55ad015 done",
    "event file_extract_native_converter_unavailable",
    "event knowledge_extract_document_conversion_failed",
    "version 1.2.3-alpha.4+build56789abcdef",
  ])("keeps ordinary diagnostic text: %s", (input) => {
    expect(redactSecrets(input)).toBe(input);
  });

  it("keeps punctuation dividers and short opaque strings", () => {
    const input = `${"-._".repeat(40)} short-value.before_end.`;
    expect(redactSecrets(input)).toBe(input);
  });

  it.each([
    [
      "POST https://hooks.slack.com/services/T01ABCDEFGH/B02ABCDEFGH/xm9pQrStUvWxYzAbCdEfGh12 200",
      "POST https://hooks.slack.com/services/T01ABCDEFGH/B02ABCDEFGH/[REDACTED] 200",
    ],
    [
      "POST https://discord.com/api/webhooks/1234567890123456789/dQw4w9WgXcQ.YWxHbG_iLjK.mNoPqRsTuVwXyZ0123456789abc 204",
      "POST https://discord.com/api/webhooks/1234567890123456789/[REDACTED] 204",
    ],
    [
      'body {"payload":"YWJjZGVmZ2hpamtsbW5vcHFy\\/c3R1dnd4eXo="}',
      'body {"payload":"[REDACTED]"}',
    ],
    ["token abc\\def\\YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4", "token [REDACTED]"],
  ])("masks a secret inside a URL path or a stray backslash run: %s", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it.each([
    "GET https://example.com/some/fairly/long/path/segment/here 404",
    "GET https://docs.example.com/guides/gettingstartedwithinstallation 404",
    "failed at C:\\project\\core\\file-with-an-extra-long-filename.test.ts line 20",
    "dir \\\\server\\share\\with-a-fairly-long-file-name.txt",
  ])("keeps ordinary URLs and Windows paths: %s", (input) => {
    expect(redactSecrets(input)).toBe(input);
  });

  it("masks a URL path segment including its dot-tilde tail", () => {
    const input = `https://h.example/a/b/${"a".repeat(30)}.~`;
    expect(redactSecrets(input)).toBe("https://h.example/a/b/[REDACTED]");
  });

  it("masks a short token segment ending in a tilde tail", () => {
    expect(redactSecrets("POST https://hooks.slack.com/services/T01ABCDEFGH/B02ABCDEFGH/xm9pQrStUvWxYzAbCdEfGh12~ 200")).toBe(
      "POST https://hooks.slack.com/services/T01ABCDEFGH/B02ABCDEFGH/[REDACTED] 200",
    );
  });

  it("masks a URL path segment ending in '=' padding", () => {
    expect(redactSecrets("GET https://hooks.slack.com/services/T01ABCDEFGH/B02ABCDEFGH/xm9pQrStUvWxYzAbCdEfGh12= 200")).toBe(
      "GET https://hooks.slack.com/services/T01ABCDEFGH/B02ABCDEFGH/[REDACTED] 200",
    );
    expect(redactSecrets("GET https://hooks.slack.com/services/T01ABCDEFGH/B02ABCDEFGH/xm9pQrStUvWxYzAbCdEfGh12=~ 200")).toBe(
      "GET https://hooks.slack.com/services/T01ABCDEFGH/B02ABCDEFGH/[REDACTED] 200",
    );
  });

  it("keeps a UUID segment ending in a tilde tail", () => {
    const input = "session https://h.example/a/9f86d081-884c-7d65-9a2f-eaa0c55ad015~ done";
    expect(redactSecrets(input)).toBe(input);
  });

  it.each([
    ["Value: abcdefghijklmnop.qrstuvwxyz123456.~", "Value: [REDACTED]"],
    [`Value: ${"x".repeat(40)}~`, "Value: [REDACTED]"],
  ])("masks a standalone opaque token ending in a tilde tail: %s", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it.each([
    ["YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=.~", "key: [REDACTED]"],
    ["YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=~", "key: [REDACTED]"],
    ["YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo==~", "key: [REDACTED]"],
    ["YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo==.~", "key: [REDACTED]"],
    ["YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=", "key: [REDACTED]"],
    ["YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo==", "key: [REDACTED]"],
  ])("masks an opaque token whose '=' padding precedes a tilde tail: %s", (token, expected) => {
    expect(redactSecrets(`key: ${token}`)).toBe(expected);
  });

  it.each([
    ["key: YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo==", "key: [REDACTED]"],
    ["key: YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=", "key: [REDACTED]"],
    ["key: YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo==~", "key: [REDACTED]"],
    ["key: YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo==.~", "key: [REDACTED]"],
    ["key: YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo===", "key: [REDACTED]"],
    ["key: YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo===~", "key: [REDACTED]"],
  ])("masks an opaque token with '=' padding and leaves no residue: %s", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it.each([
    ["GET https://h.com/cb?sig=AbCdEfGhIjKlMnOpQrStUvWx 200", "GET https://h.com/cb?sig=[REDACTED] 200"],
    ["GET https://h.com/cb?sig=AbCdEfGhIjKlMnOpQrStUvWx&ok=1 200", "GET https://h.com/cb?sig=[REDACTED]&ok=1 200"],
    ["token https://h.com/cb?sig=AbCdEfGhIjKlMnOpQrStUvWx== 200", "token https://h.com/cb?sig=[REDACTED] 200"],
    ["list [https://h.com/cb?sig=AbCdEfGhIjKlMnOpQrStUvWx] ok", "list [https://h.com/cb?sig=[REDACTED]] ok"],
    ["opts {https://h.com/cb?sig=AbCdEfGhIjKlMnOpQrStUvWx} ok", "opts {https://h.com/cb?sig=[REDACTED]} ok"],
    ["see https://h.com/cb?sig=AbCdEfGhIjKlMnOpQrStUvWx. done", "see https://h.com/cb?sig=[REDACTED]. done"],
    ["open https://app/#/cb?sig=AbCdEfGhIjKlMnOpQrStUvWx 200", "open https://app/#/cb?sig=[REDACTED] 200"],
    ["GET https://h.com/cb?a=1#sig=AbCdEfGhIjKlMnOpQrStUvWx 200", "GET https://h.com/cb?a=1#sig=[REDACTED] 200"],
    ["GET https://app.com/cb#access_token=AbCdEfGhIjKlMnOpQrStUvWx 200", "GET https://app.com/cb#access_token=[REDACTED] 200"],
    ["GET https://h.com/cb?sig=QXV0aFRva2VuMTIzNDU2Nzg5MGFiY2RlZg=.~ 200", "GET https://h.com/cb?sig=[REDACTED] 200"],
    [
      'body {"url":"https:\\/\\/h.com\\/cb?sig=AbCdEfGhIjKlMnOpQrStUvWx"}',
      'body {"url":"https:\\/\\/h.com\\/cb?sig=[REDACTED]"}',
    ],
    [
      'body {"url":"https:\\\\/\\\\/h.com\\\\/cb?sig=AbCdEfGhIjKlMnOpQrStUvWx"}',
      'body {"url":"https:\\\\/\\\\/h.com\\\\/cb?sig=[REDACTED]"}',
    ],
    [
      "GET https://h.com/cb?sig=AbCdEfGhIjKlMnOpQrStUvWx\\/sfxYzAbCdEf 200",
      "GET https://h.com/cb?sig=[REDACTED] 200",
    ],
    ["GET https://h.com/cb?sig=qrstuvwxyzabcdfghjklmnpq 200", "GET https://h.com/cb?sig=[REDACTED] 200"],
    ["GET https://h.com/cb?sig=dGhpc2lzdG9rZW4xMjM0NTY3ODk 200", "GET https://h.com/cb?sig=[REDACTED] 200"],
  ])("masks an opaque secret in a URL query or fragment value: %s", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it.each([
    "GET https://h.com/cb?sig=AbCdEfGhIjKlMnOpQrStUvW 200",
    "GET https://h.com/cb?sig=AbCdEfGhIjKlMnOpQrStU. 200",
    "GET https://h.com/cb?name=alice&sort=desc 200",
    "GET https://app.com/cb#/dashboard 200",
    "GET https://app.com/cb#section-2 200",
    "GET https://h.com/cb?callback=onCompleteHandlerFunction 200",
    "GET https://h.com/search?q=gettingstartedwithinstallation 200",
    "next ?sig=AbCdEfGhIjKlMnOpQrStUvWx end",
  ])("keeps ordinary query strings and non-URL text: %s", (input) => {
    expect(redactSecrets(input)).toBe(input);
  });

  it("masks a long hyphenated query phrase as a documented exception", () => {
    // A 38-char mixed run (`-` and alnum) reads as an opaque run, not as a word; the query rule's
    // word-like check only governs values the opaque rule would not take on its own.
    expect(redactSecrets("GET https://h.com/search?q=a-very-long-natural-language-query-here 200")).toBe(
      "GET https://h.com/search?q=[REDACTED] 200",
    );
  });

  it.each([
    ["abcdefghijklmnop+/qrst/uvwxyz12345", "[REDACTED]"],
    ["ABcDEfGHiJKlMnOP/qrSTu/vwXYZ123456", "[REDACTED]"],
    ["//fcDEfGHiJKlMnOPqrSTuvwXYZ123456789", "//[REDACTED]"],
  ])("still masks a standalone base64 run with slashes: %s", (token, masked) => {
    expect(redactSecrets(`Value: ${token}.`)).toBe(`Value: ${masked}.`);
  });

  it("keeps long punctuation runs without retrying the matcher at every character", () => {
    const input = `${"-._".repeat(20_000)} a${".".repeat(40_000)}`;
    const start = performance.now();
    expect(redactSecrets(input)).toBe(input);
    expect(performance.now() - start).toBeLessThan(250);
  });

  it("leaves normal text untouched", () => {
    const input = "Hello, world! This is a normal message without secrets.";
    const result = redactSecrets(input);
    expect(result).toBe(input);
  });

  it("handles empty string", () => {
    expect(redactSecrets("")).toBe("");
  });

  it("handles multiple secrets in one string", () => {
    const input = "openai=sk-key1-longvalue anthropic=sk-ant-key2-longvalue";
    const result = redactSecrets(input);
    expect(result).not.toContain("sk-key1-longvalue");
    expect(result).not.toContain("sk-ant-key2-longvalue");
  });
});
