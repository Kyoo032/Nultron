import { describe, expect, it } from "vitest";
import { createLogger, DROPPED_MARKER, REDACTED_MARKER, redactSecrets } from "./log";

function capture(): { lines: string[]; logger: ReturnType<typeof createLogger> } {
  const lines: string[] = [];
  const logger = createLogger({ env: { PORTAL_LOG_LEVEL: "debug" }, sink: (_level, line) => lines.push(line) });
  return { lines, logger };
}

describe("redactSecrets", () => {
  it("scrubs a JWT wherever it appears in a string", () => {
    const jwt = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1c3IifQ.c2lnbmF0dXJl";
    expect(redactSecrets(`bearer ${jwt} rejected`)).toBe(`bearer ${REDACTED_MARKER} rejected`);
  });

  it("scrubs a 32-byte base64url token", () => {
    const token = Buffer.alloc(32, 3).toString("base64url");
    expect(token.length).toBe(43);
    expect(redactSecrets(`refresh ${token}`)).toBe(`refresh ${REDACTED_MARKER}`);
  });

  it("leaves ordinary text alone", () => {
    expect(redactSecrets("seat_cap_reached for org kyo")).toBe("seat_cap_reached for org kyo");
  });
});

describe("createLogger", () => {
  it("drops any field whose name carries a credential word", () => {
    const { lines, logger } = capture();
    logger.info("login_denied", {
      refreshToken: "should-not-appear",
      otpCode: "123456",
      user_code: "K7M4-PQ9T",
      device_code: "raw",
      clientSecret: "shh",
      code: "654321",
      state: "nonce",
      inviteCode: "ABCDE-FGHJK-LMNPQ-RSTUV",
      invite_code: "ABCDE-FGHJK-LMNPQ-RSTUV",
    });
    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    for (const field of [
      "refreshToken",
      "otpCode",
      "user_code",
      "device_code",
      "clientSecret",
      "code",
      "state",
      "inviteCode",
      "invite_code",
    ]) {
      expect(record[field], field).toBe(DROPPED_MARKER);
    }
    expect(lines[0]).not.toContain("123456");
    expect(lines[0]).not.toContain("K7M4-PQ9T");
    expect(lines[0]).not.toContain("ABCDE-FGHJK");
  });

  it("keeps the reason code, which is the whole point of the line", () => {
    const { lines, logger } = capture();
    logger.warn("login_denied", { reason_code: "seat_cap_reached", reasonCode: "seat_cap_reached" });
    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(record.reason_code).toBe("seat_cap_reached");
    expect(record.reasonCode).toBe("seat_cap_reached");
    expect(record.event).toBe("login_denied");
    expect(record.level).toBe("warn");
  });

  it("reports a Buffer by length only, never by content", () => {
    const { lines, logger } = capture();
    logger.info("hashed", { digest: Buffer.alloc(32, 1) });
    expect(JSON.parse(lines[0]).digest).toBe("[bytes:32]");
  });

  it("scrubs a token that arrives inside an ordinary field", () => {
    const { lines, logger } = capture();
    logger.error("portal_failed", { reason: `upstream rejected ${Buffer.alloc(32, 5).toString("base64url")}` });
    expect(lines[0]).toContain(REDACTED_MARKER);
  });

  it("is level-gated", () => {
    const lines: string[] = [];
    const logger = createLogger({ env: { PORTAL_LOG_LEVEL: "warn" }, sink: (_l, line) => lines.push(line) });
    logger.info("ignored", {});
    logger.error("kept", {});
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).event).toBe("kept");
  });

  it("writes one line per call, so a newline in a value cannot forge an entry", () => {
    const { lines, logger } = capture();
    logger.info("odd", { note: "first\nsecond" });
    expect(lines).toHaveLength(1);
    expect(lines[0].includes("\n")).toBe(false);
  });

  it("scrubs emails, phones, NIKs, NPWPs, and cards from logged strings", () => {
    const { lines, logger } = capture();
    logger.warn("invite_failed", {
      detail:
        "alex.rivera@example.com phone 081234567890 intl +1 (415) 555-2671 NIK 3273010101900001 NPWP 09.254.294.3-407.000 card 4111 1111 1111 1111",
    });
    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(record.detail).toBe("[email] phone [phone] intl [phone] NIK [nik] NPWP [npwp] card [card]");
    expect(lines[0]).not.toContain("alex.rivera@example.com");
    expect(lines[0]).not.toContain("3273010101900001");
  });
});
