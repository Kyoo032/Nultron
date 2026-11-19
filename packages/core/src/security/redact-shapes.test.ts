import { describe, expect, it } from "vitest";
import { redactCredentials, redactSecrets } from "./redact";
import { redactSecretsDeep } from "./redact-deep";

/** Secret shapes this app handles, built from parts so no real credential is in the source. */
const JWT = [
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ",
  "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
].join(".");
const TELEGRAM = `123456789:${"AAH-x_9aB3cD4eF5gH6iJ7kL8mN9oP0qR1s"}`;
const AWS_ID = `AKIA${"IOSFODNN7EXAMPLE"}`;
const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
  "VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK",
  "-----END RSA PRIVATE KEY-----",
].join("\n");
const SHA = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

describe("redactCredentials: the shapes this app handles", () => {
  it.each([
    ["Authorization: bearer abcd1234efgh-5678.ijkl_mnop", "Authorization: Bearer [REDACTED]"],
    ["authorization=Bearer+abcd1234efgh5678ijkl", "authorization=Bearer [REDACTED]"],
    ["BEARER abcd1234efgh5678", "Bearer [REDACTED]"],
  ])("masks an opaque bearer token in %s", (input, expected) => {
    expect(redactCredentials(input)).toBe(expected);
  });

  it("leaves the word bearer alone in prose", () => {
    const input = "The word bearer is not a credential.";
    expect(redactCredentials(input)).toBe(input);
  });

  it("masks a JWT", () => {
    const out = redactCredentials(`session ${JWT} ends`);
    expect(out).toBe("session [REDACTED] ends");
  });

  it("masks a JWT after a hyphen, after a long dotted prefix and after dots, and in a header line", () => {
    expect(redactCredentials(`x-${JWT}`)).toBe("x-[REDACTED]");
    expect(redactCredentials(`abcdefghijkl.${JWT}`)).toBe("abcdefghijkl.[REDACTED]");
    expect(redactCredentials(`token...${JWT}`)).toBe("token...[REDACTED]");
    expect(redactCredentials(`?token=${JWT}&x=1`)).toBe("?token=[REDACTED]&x=1");
    expect(redactCredentials(`"id_token":"${JWT}"`)).toBe(`"id_token":"[REDACTED]"`);
    expect(redactCredentials(`Bearer ${JWT}`)).toBe("Bearer [REDACTED]");
  });

  it("masks a JWT that follows a header-like prefix whose own part is too short to be one", () => {
    expect(redactCredentials(`eyJabc.${JWT}`)).toBe("eyJabc.[REDACTED]");
    expect(redactCredentials(`${JWT}.tail`)).toBe("[REDACTED].tail");
  });

  it("leaves a header that sits inside a word, or has too few parts, alone", () => {
    const kept = [`a_${JWT}`, `abc${JWT}`, "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0", "eyJabc.def.ghi"];
    for (const text of kept) {
      expect(redactCredentials(text), text).toBe(text);
    }
  });

  it("masks a Telegram bot token", () => {
    expect(redactCredentials(`bot ${TELEGRAM} here`)).toBe("bot [REDACTED] here");
    expect(redactCredentials(`https://api.telegram.org/bot${TELEGRAM}/getUpdates`)).not.toContain(TELEGRAM);
  });

  it("masks an AWS access key id", () => {
    expect(redactCredentials(`id=${AWS_ID};`)).toBe("id=[REDACTED];");
    expect(redactCredentials(`id=ASIA${"IOSFODNN7EXAMPLE"}`)).toBe("id=[REDACTED]");
  });

  it("masks a whole PEM private key block, and a block cut off before its end line", () => {
    expect(redactCredentials(`key:\n${PEM}\nafter`)).toBe("key:\n[REDACTED]\nafter");
    const cut = PEM.split("\n").slice(0, 3).join("\n");
    expect(redactCredentials(`key:\n${cut}`)).toBe("key:\n[REDACTED]");
    expect(redactCredentials("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----")).toBe("[REDACTED]");
  });

  it("leaves a public certificate alone", () => {
    const cert = "-----BEGIN CERTIFICATE-----\nMIIDdzCCAl+gAwIBAgIE\n-----END CERTIFICATE-----";
    expect(redactCredentials(cert)).toBe(cert);
  });

  it("masks the credentials in a URL and keeps the rest of it", () => {
    expect(redactCredentials("postgres://app:s3cret@db.internal:5432/main")).toBe(
      "postgres://[REDACTED]@db.internal:5432/main",
    );
    expect(redactCredentials("see https://user:pass@example.com/a?b=1 now")).toBe(
      "see https://[REDACTED]@example.com/a?b=1 now",
    );
    expect(redactCredentials("git clone https://tokenvalue123@github.com/o/r.git")).toBe(
      "git clone https://[REDACTED]@github.com/o/r.git",
    );
  });

  it("masks a cookie header value, and keeps a sentence that only says cookie", () => {
    expect(redactCredentials("Cookie: sid=abc123; theme=dark")).toBe("Cookie: [REDACTED]");
    expect(redactCredentials("Set-Cookie: sid=abc123; Path=/; HttpOnly")).toBe("Set-Cookie: [REDACTED]");
    expect(redactCredentials("cookie: chocolate chip, 12 in a box")).toBe("cookie: chocolate chip, 12 in a box");
  });

  it("is also applied by redactSecrets", () => {
    expect(redactSecrets(`t ${JWT} and ${AWS_ID}`)).toBe("t [REDACTED] and [REDACTED]");
  });
});

describe("redactCredentials: what must stay readable", () => {
  it("keeps a content hash, a signed media link, a long identifier and a URL with an @ in its query", () => {
    const kept = [
      SHA,
      `https://cdn.example.com/a.png?X-Amz-Signature=${SHA}&X-Amz-Credential=${AWS_ID}%2F20261006%2Fus-east-1%2Fs3%2Faws4_request`,
      "thisIsAVeryLongIdentifierNameForAFunctionInSomeCode0123456789",
      "123e4567-e89b-12d3-a456-426614174000",
      "https://example.com/search?email=a@b.com&page=2",
      "mailto:someone@example.com",
      "https://example.com:8080/path@x",
    ];
    for (const text of kept) {
      expect(redactCredentials(text), text).toBe(text);
    }
  });

  it("keeps figures: numbers, times, ratios and a long numeric id", () => {
    const kept = [
      "1234567.89",
      "2026-10-06T12:00:00.000Z",
      "12:30:45",
      "123456789:00",
      "3456789012:12345678901234567890123456789012345",
      "Revenue 4111111111111111 IDR, ratio 1.5:1",
      "a.b.c",
      "v1.2.3",
    ];
    for (const text of kept) {
      expect(redactCredentials(text), text).toBe(text);
    }
  });
});

describe("redactSecretsDeep: the new shapes at depth in a tool output", () => {
  it("masks each shape wherever it sits in an object and an array", () => {
    const output = {
      ok: true,
      rows: [{ note: `token ${JWT}` }, { note: `bot ${TELEGRAM}` }],
      nested: { deeper: { text: `aws ${AWS_ID} and ${PEM}` } },
      links: ["postgres://app:pw@db:5432/x"],
      headers: { "Set-Cookie": "sid=abc", Cookie: "sid=abc", Accept: "text/html" },
    };
    const text = JSON.stringify(redactSecretsDeep(output));
    for (const secret of [
      JWT,
      TELEGRAM,
      AWS_ID,
      "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
      ":pw@",
      "sid=abc",
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(text).toContain("text/html");
    expect(text).toContain("db:5432/x");
  });

  it.each([
    "telegramBotToken",
    "telegram_bot_token",
    "botToken",
    "cookie",
    "Set-Cookie",
    "privateKey",
    "private_key",
    "secretKey",
    "secret-key",
    "accessKey",
    "access_key",
    "credentials",
    "credential",
  ])("masks the value of a key named %s", (key) => {
    expect(redactSecretsDeep({ [key]: "opaque-value-123" })).toEqual({ [key]: "[REDACTED]" });
  });

  it("does not mask a key that only contains one of those words", () => {
    const input = { cookies_count: "3", access_key_id_prefix: "AKIA", private_keys_total: "2", tokens: "12" };
    expect(redactSecretsDeep(input)).toEqual(input);
  });

  it("keeps a spreadsheet row, a hash, a signed link and a long id exactly as they were", () => {
    const row = {
      sheet: "Q3",
      rows: [
        {
          account: 1234567890123456,
          amount: 1234567.89,
          ratio: "1.5:1",
          at: "2026-10-06T12:00:00Z",
          id: "A".repeat(40),
        },
        {
          account: 3456789012,
          amount: -42,
          ratio: "12:30:45",
          at: "2026-10-07",
          id: "3456789012:12345678901234567890123456789012345",
        },
      ],
      sha256: SHA,
      url: `https://cdn.example.com/a.png?sig=${SHA}`,
    };
    expect(redactSecretsDeep(row)).toEqual(row);
  });
});
