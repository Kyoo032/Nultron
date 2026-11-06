import { describe, expect, it } from "vitest";
import { redactCredentials, redactSecrets } from "./redact";
import { redactSecretsDeep } from "./redact-deep";

const join = (...parts: string[]) => parts.join("");

const GITHUB_TOKENS = [
  join("ghp", "_", "0123456789abcdefghijABCDEFGHIJ012345"),
  join("gho", "_", "0123456789abcdefghijABCDEFGHIJ012345"),
  join("ghu", "_", "0123456789abcdefghijABCDEFGHIJ012345"),
  join("ghs", "_", "0123456789abcdefghijABCDEFGHIJ012345"),
  join("ghr", "_", "0123456789abcdefghijABCDEFGHIJ012345"),
  join("github", "_pat_", "11ABCDEFG0123456789abc", "_", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456"),
];

const SLACK_TOKENS = [
  join("xoxb", "-", "1234567890", "-", "abcdefghij"),
  join("xoxb", "-", "123456789012", "-", "1234567890123", "-", "AbCdEfGhIjKlMnOpQrStUvWx"),
  join("xoxp", "-", "123456789012", "-", "123456789012", "-", "1234567890123", "-", "0123456789abcdef0123456789abcdef"),
  join("xoxa", "-", "2", "-", "123456789012", "-", "abcdefghijklmnop"),
  join("xoxs", "-", "123456789012", "-", "abcdefghijklmnop"),
  join("xoxe", "-", "1", "-", "My0xLTEyMzQ1Njc4OTAtMTIzNDU2Nzg5MDEyMy0xMjM0"),
  join("xapp", "-", "1", "-", "A0123456789", "-", "1234567890123", "-", "abcdef0123456789abcdef0123456789"),
];

const STRIPE_KEYS = [
  join("sk", "_live_", "0123456789abcdefghijABCD"),
  join("rk", "_live_", "0123456789abcdefghijABCD"),
];

describe("redactCredentials: Stripe live keys", () => {
  it.each(STRIPE_KEYS.map((key) => [key.slice(0, 8), key]))("masks a key that starts %s", (_prefix, key) => {
    expect(redactCredentials(`charge with ${key} now`)).toBe("charge with [REDACTED] now");
    expect(redactCredentials(`STRIPE_KEY=${key}`)).not.toContain(key);
  });

  it("keeps prose that only names the prefix, and a key that is too short", () => {
    const kept = [
      "a live secret key starts with sk_live_ and a restricted one with rk_live_",
      "sk_live_short",
      "task_live_0123456789abcdefghijABCD",
    ];
    for (const text of kept) {
      expect(redactCredentials(text), text).toBe(text);
    }
  });
});

describe("redactCredentials: an X-Api-Key header in text", () => {
  it("masks the value after the header name, in a curl line, a header dump and JSON", () => {
    expect(redactCredentials("X-Api-Key: 9f8e7d6c5b4a39281706")).toBe("X-Api-Key: [REDACTED]");
    expect(redactCredentials('curl -H "x-api-key: 9f8e7d6c5b4a39281706" https://api.example.com')).toBe(
      'curl -H "x-api-key: [REDACTED]" https://api.example.com',
    );
    expect(redactCredentials('{"X-Api-Key":"9f8e7d6c5b4a39281706","Accept":"text/html"}')).toBe(
      '{"X-Api-Key":"[REDACTED]","Accept":"text/html"}',
    );
    expect(redactCredentials("X-API-KEY=9f8e7d6c5b4a39281706")).toBe("X-API-KEY=[REDACTED]");
  });

  it("keeps a sentence that names the header and a value too short to be a key", () => {
    const kept = ["the X-Api-Key header is required", "X-Api-Key: none", "send an X-Api-Key: header with every call"];
    for (const text of kept) {
      expect(redactCredentials(text), text).toBe(text);
    }
  });
});

describe("redactCredentials: GitHub and Slack tokens", () => {
  it.each(GITHUB_TOKENS.map((token) => [token.slice(0, 4), token]))(
    "masks a GitHub token that starts %s",
    (_prefix, token) => {
      expect(redactCredentials(`remote uses ${token} now`)).toBe("remote uses [REDACTED] now");
      expect(redactCredentials(`Authorization: token ${token}`)).toBe("Authorization: token [REDACTED]");
    },
  );

  it.each(SLACK_TOKENS.map((token) => [token.slice(0, 5), token]))(
    "masks a Slack token that starts %s",
    (_prefix, token) => {
      expect(redactCredentials(`bot ${token} ready`)).toBe("bot [REDACTED] ready");
      expect(redactCredentials(`{"token":"${token}"}`)).toBe(`{"token":"[REDACTED]"}`);
    },
  );

  it("goes through redactSecrets and redactSecretsDeep too", () => {
    expect(redactSecrets(`t ${GITHUB_TOKENS[0]} s ${SLACK_TOKENS[0]}`)).toBe("t [REDACTED] s [REDACTED]");
    expect(JSON.stringify(redactSecretsDeep({ log: [`clone with ${GITHUB_TOKENS[5]}`] }))).not.toContain("github_pat_");
  });

  it("keeps prose that only names the prefix", () => {
    const kept = [
      "a GitHub token starts with ghp_ and is 40 characters long",
      "Slack bot tokens look like xoxb- followed by ids",
      "ghost_writer_2026 and ghp_short",
      "the github_pat_ prefix marks a fine-grained token",
      "xoxo and xox-ray",
    ];
    for (const text of kept) {
      expect(redactCredentials(text), text).toBe(text);
    }
  });
});

describe("redactCredentials: Basic credentials in an Authorization header", () => {
  it("masks the encoded user and password, keeps the header and the scheme", () => {
    expect(redactCredentials("Authorization: Basic dXNlcjpwYXNzd29yZA==")).toBe("Authorization: Basic [REDACTED]");
    expect(redactCredentials('curl -H "Authorization: Basic dXNlcjpwYXNz" https://api.example.com')).toBe(
      'curl -H "Authorization: Basic [REDACTED]" https://api.example.com',
    );
    expect(redactCredentials('{"Authorization":"Basic dXNlcjpwYXNz"}')).toBe('{"Authorization":"Basic [REDACTED]"}');
    expect(redactCredentials("proxy-authorization: basic dXNlcjpwYXNz")).toBe("proxy-authorization: basic [REDACTED]");
  });

  it("keeps prose that starts with the word Basic, and a challenge that carries no credential", () => {
    const kept = [
      "Basic principles of accounting",
      "Basic information is required for every account",
      "Basic Authentication is described in the next section",
      'WWW-Authenticate: Basic realm="Restricted"',
      "Authorization: Basic",
      "the Basic plan costs 100000 per month",
    ];
    for (const text of kept) {
      expect(redactCredentials(text), text).toBe(text);
    }
  });
});

describe("redactCredentials: an encoded bearer token", () => {
  it("masks a token after a percent-encoded space", () => {
    expect(redactCredentials("Authorization=Bearer%20abcdefghijklmnop1234")).toBe("Authorization=Bearer [REDACTED]");
  });

  it("keeps a short word after the encoded space", () => {
    expect(redactCredentials("Bearer%20abc")).toBe("Bearer%20abc");
  });
});

describe("redactCredentials: environment lines", () => {
  const ENV = [
    "# app config",
    "NODE_ENV=production",
    "PORT=3000",
    "OPENAI_API_KEY=opaque-not-prefixed",
    "export DATABASE_PASSWORD=hunter2",
    "  AWS_SECRET_ACCESS_KEY = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    'JWT_SECRET="two words here"',
    "SECRET_KEY_BASE=abc123",
    "KEYBOARD_LAYOUT=us",
    "MAX_TOKENS=4096",
    "SECRETARY=Ann",
    "GITHUB_TOKEN=",
    "BASE_URL=https://example.com/a?b=1",
  ].join("\n");

  it("masks the value of a secret-named assignment and keeps every other line", () => {
    expect(redactCredentials(ENV)).toBe(
      [
        "# app config",
        "NODE_ENV=production",
        "PORT=3000",
        "OPENAI_API_KEY=[REDACTED]",
        "export DATABASE_PASSWORD=[REDACTED]",
        "  AWS_SECRET_ACCESS_KEY = [REDACTED]",
        "JWT_SECRET=[REDACTED]",
        "SECRET_KEY_BASE=[REDACTED]",
        "KEYBOARD_LAYOUT=us",
        "MAX_TOKENS=4096",
        "SECRETARY=Ann",
        "GITHUB_TOKEN=",
        "BASE_URL=https://example.com/a?b=1",
      ].join("\n"),
    );
  });

  it("handles Windows line endings and a file read as one string inside a tool output", () => {
    expect(redactCredentials("A=1\r\nDB_PASSWORD=hunter2\r\nZ=2")).toBe("A=1\r\nDB_PASSWORD=[REDACTED]\r\nZ=2");
    expect(redactSecretsDeep({ ok: true, content: ENV })).toEqual({ ok: true, content: redactCredentials(ENV) });
  });

  it("leaves a lowercase code line and an assignment in the middle of a sentence alone", () => {
    const kept = [
      "password = input()",
      "token = get_token()",
      "set the OPENAI_API_KEY=abc in your shell",
      "Revenue KEY=4,000 TOKEN=5",
    ];
    for (const text of kept) {
      expect(redactCredentials(text), text).toBe(text);
    }
  });

  it("keeps a number or a boolean under a secret-named setting, quoted or not", () => {
    const kept = [
      "TOKEN_TTL=3600",
      "KEY_SIZE=2048",
      "PASSWORD_MIN_LENGTH=12",
      "MAX_TOKEN=4096",
      'SECRET_ROTATION_DAYS="30"',
      "SECRET_ROTATION_ENABLED=true",
      "API_KEY_REQUIRED=False",
      "TOKEN_RATE=0.5",
    ];
    for (const text of kept) {
      expect(redactCredentials(text), text).toBe(text);
    }
  });

  it("keeps a signed number, a number with thousands separators and a trailing comment on a name that ends in a secret word", () => {
    const kept = [
      "MAX_TOKEN=2048 # bits",
      "MAX_TOKEN=1,234",
      "MAX_TOKEN=1,234,567",
      "MIN_PASSWORD=-1",
      "MIN_PASSWORD=+5",
      "ACCESS_TOKEN=true # on",
      "API_KEY=false   # disabled",
      'ROTATE_SECRET="30" # days',
    ];
    for (const text of kept) {
      expect(redactCredentials(text), text).toBe(text);
    }
  });

  it("still masks a value that is not wholly a number, however it is written", () => {
    expect(redactCredentials("API_KEY=1,23")).toBe("API_KEY=[REDACTED]");
    expect(redactCredentials("API_KEY=1,2345")).toBe("API_KEY=[REDACTED]");
    expect(redactCredentials("API_KEY=123#abc")).toBe("API_KEY=[REDACTED]");
    expect(redactCredentials("API_KEY=-")).toBe("API_KEY=[REDACTED]");
    expect(redactCredentials("API_KEY=12 34 # note")).toBe("API_KEY=[REDACTED]");
  });

  it("masks a name that ends in a secret word, including the shapes databases and mailers use", () => {
    const masked = [
      "OPENAI_APIKEY=opaque-not-prefixed",
      "APIKEY=abcdefghijkl",
      "DB_PASS=hunter2xyz",
      "SMTP_PASS=hunter2xyz",
      "PASS=hunter2xyz",
      "MYSQL_PWD=hunter2xyz",
      "PGPASSWORD=hunter2xyz",
      "STRIPE_SECRET_KEY=opaque-not-prefixed",
      "GITHUB_TOKEN_SECRET=opaque-not-prefixed",
      "SECRET_KEY_BASE=abc123",
    ];
    for (const text of masked) {
      const name = text.split("=")[0];
      expect(redactCredentials(text), text).toBe(`${name}=[REDACTED]`);
    }
  });

  it("keeps a setting whose name only contains a secret word before its last part", () => {
    const kept = [
      "TOKEN_ENDPOINT=https://oauth2.googleapis.com/token",
      'KEY_COLUMNS = ["id", "name"]',
      'PASSWORD_REGEX = r"^[a-z]+$"',
      "KEY_SIZE=2048 # bits",
      "TOKEN_COUNT=1,234",
      "PASSWORD_MIN_LENGTH=-1",
      "SECRET_ROTATION_DAYS=30",
      "TOKEN_TTL=soon",
      "KEY_FILE_PATH=/etc/app/key.pem",
    ];
    for (const text of kept) {
      expect(redactCredentials(text), text).toBe(text);
    }
  });

  it("keeps a working directory and names that only end in the letters of a secret word", () => {
    const kept = [
      "PWD=/home/rizky/app",
      "OLDPWD=/home/rizky",
      "BYPASS=1",
      "COMPASS=north",
      "TURKEY=Ankara",
      "MONKEY=see",
    ];
    for (const text of kept) {
      expect(redactCredentials(text), text).toBe(text);
    }
  });

  it("still masks a value that only starts like a number or a boolean", () => {
    expect(redactCredentials("API_KEY=0a1b2c3d4e")).toBe("API_KEY=[REDACTED]");
    expect(redactCredentials("SECRET=falsehood")).toBe("SECRET=[REDACTED]");
    expect(redactCredentials("DB_PASSWORD=12 345")).toBe("DB_PASSWORD=[REDACTED]");
  });

  it("is idempotent, so a value redacted once is the same when redacted again", () => {
    const once = redactCredentials(ENV);
    expect(redactCredentials(once)).toBe(once);
    const sample = `${ENV}\nAuthorization: Basic dXNlcjpwYXNz\n${GITHUB_TOKENS[0]}\ncookie: sid=1`;
    expect(redactSecrets(redactSecrets(sample))).toBe(redactSecrets(sample));
  });
});
