import { describe, expect, it } from "vitest";
import { ApiError } from "../errors";
import {
  INBOX_CAPS,
  WHATSAPP_WINDOW_MS,
  assertAccessToken,
  assertPhoneNumberId,
  assertReplyText,
  inboxDisplayText,
  nextDeliveryStatus,
  parseWaId,
  previewOf,
  replyWindowFor,
  whatsappReplyWindow,
} from "./index";
import { PINNED_WHATSAPP_API_ORIGIN, WHATSAPP_API_URL_ENV, isPinnedWhatsAppOrigin, resolvedWhatsAppApiOrigin } from "./pinned";

const T = 1_800_000_000_000;

describe("whatsappReplyWindow", () => {
  it("is open for the 24 hours after the customer wrote, and closes at the boundary itself", () => {
    expect(whatsappReplyWindow(T, T)).toEqual({ open: true, closesAt: T + WHATSAPP_WINDOW_MS });
    expect(whatsappReplyWindow(T, T + WHATSAPP_WINDOW_MS - 1).open).toBe(true);
    // At the boundary a reply would reach Meta late and be refused, so it is closed here first.
    expect(whatsappReplyWindow(T, T + WHATSAPP_WINDOW_MS).open).toBe(false);
    expect(whatsappReplyWindow(T, T + WHATSAPP_WINDOW_MS + 1).open).toBe(false);
  });

  it("is closed, with no closing time, for a customer who has never written", () => {
    expect(whatsappReplyWindow(null, T)).toEqual({ open: false, closesAt: null });
    expect(whatsappReplyWindow(Number.NaN, T)).toEqual({ open: false, closesAt: null });
  });

  it("is the rule replyWindowFor applies to a WhatsApp conversation", () => {
    expect(replyWindowFor("whatsapp", T, T + 1)).toEqual(whatsappReplyWindow(T, T + 1));
  });
});

describe("parseWaId", () => {
  it("takes digits in international form, as a string or a number", () => {
    expect(parseWaId("6281200000001")).toBe("6281200000001");
    expect(parseWaId(" 6281200000001 ")).toBe("6281200000001");
    expect(parseWaId(6281200000001)).toBe("6281200000001");
  });

  it("refuses anything else, so a payload cannot smuggle a path or a plus", () => {
    for (const bad of ["", "+6281200000001", "62 812", "1234", "../etc", "6281200000001/messages", "1".repeat(21), null, {}]) {
      expect(parseWaId(bad)).toBeNull();
    }
  });
});

describe("what the owner may paste", () => {
  it("checks a phone number id before it reaches a URL", () => {
    expect(assertPhoneNumberId(" 105550000000001 ")).toBe("105550000000001");
    for (const bad of ["", "abc", "1234", "105550000000001/../x", "105550000000001?x=1", null, 105550000000001]) {
      expect(() => assertPhoneNumberId(bad)).toThrow(ApiError);
    }
  });

  it("checks only the shape of an access token", () => {
    expect(assertAccessToken(` ${"E".repeat(40)} `)).toBe("E".repeat(40));
    for (const bad of ["", "short", "has a space in it........", "x".repeat(1025), null]) {
      expect(() => assertAccessToken(bad)).toThrow(ApiError);
    }
  });

  it("trims a reply, refuses an empty one and refuses one past WhatsApp's limit", () => {
    expect(assertReplyText("  On our way  ")).toBe("On our way");
    expect(() => assertReplyText("   ")).toThrow(ApiError);
    expect(() => assertReplyText(undefined)).toThrow(ApiError);
    expect(assertReplyText("a".repeat(INBOX_CAPS.maxTextChars))).toHaveLength(INBOX_CAPS.maxTextChars);
    expect(() => assertReplyText("a".repeat(INBOX_CAPS.maxTextChars + 1))).toThrow(ApiError);
  });
});

describe("display text from outside", () => {
  it("collapses a name to one capped line, with a fallback", () => {
    expect(inboxDisplayText("  Dewi\n\n  Lestari ", "")).toBe("Dewi Lestari");
    expect(inboxDisplayText("   ", "Customer")).toBe("Customer");
    expect(inboxDisplayText(42, "")).toBe("");
    expect(inboxDisplayText("x".repeat(500), "")).toHaveLength(INBOX_CAPS.maxNameChars);
  });

  it("flattens a preview and ends a long one with an ellipsis", () => {
    expect(previewOf("Ada\nkopi?")).toBe("Ada kopi?");
    const long = previewOf("y".repeat(300));
    expect(long).toHaveLength(INBOX_CAPS.maxPreviewChars);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("nextDeliveryStatus", () => {
  it("moves forward and never back", () => {
    expect(nextDeliveryStatus("queued", "sent")).toBe("sent");
    expect(nextDeliveryStatus("sent", "delivered")).toBe("delivered");
    expect(nextDeliveryStatus("delivered", "read")).toBe("read");
    expect(nextDeliveryStatus("read", "sent")).toBe("read");
    expect(nextDeliveryStatus("read", "delivered")).toBe("read");
    expect(nextDeliveryStatus("sent", "sent")).toBe("sent");
  });

  it("lets a failure stand only for a message the customer never got", () => {
    expect(nextDeliveryStatus("queued", "failed")).toBe("failed");
    expect(nextDeliveryStatus("sent", "failed")).toBe("failed");
    expect(nextDeliveryStatus("delivered", "failed")).toBe("delivered");
    expect(nextDeliveryStatus("read", "failed")).toBe("read");
  });

  it("lets a late proof of delivery overrule an earlier failure, and a late 'sent' not", () => {
    expect(nextDeliveryStatus("failed", "delivered")).toBe("delivered");
    expect(nextDeliveryStatus("failed", "read")).toBe("read");
    expect(nextDeliveryStatus("failed", "sent")).toBe("failed");
  });
});

describe("the pinned Graph origin", () => {
  function withEnv(vars: Record<string, string | undefined>, run: () => void): void {
    const keys = [WHATSAPP_API_URL_ENV, "AGENTFORGE_PACKAGED", "NODE_ENV"];
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      for (const key of keys) {
        delete process.env[key];
      }
      for (const [key, value] of Object.entries(vars)) {
        if (value !== undefined) {
          process.env[key] = value;
        }
      }
      run();
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
    }
  }

  it("is graph.facebook.com unless a developer machine or a test says otherwise", () => {
    withEnv({}, () => expect(resolvedWhatsAppApiOrigin()).toBe(PINNED_WHATSAPP_API_ORIGIN));
    withEnv({ [WHATSAPP_API_URL_ENV]: "http://127.0.0.1:3398/" }, () =>
      expect(resolvedWhatsAppApiOrigin()).toBe("http://127.0.0.1:3398"),
    );
  });

  it("ignores the override in a packaged build and in production", () => {
    withEnv({ [WHATSAPP_API_URL_ENV]: "http://127.0.0.1:3398", AGENTFORGE_PACKAGED: "1" }, () =>
      expect(resolvedWhatsAppApiOrigin()).toBe(PINNED_WHATSAPP_API_ORIGIN),
    );
    withEnv({ [WHATSAPP_API_URL_ENV]: "http://127.0.0.1:3398", NODE_ENV: "production" }, () =>
      expect(resolvedWhatsAppApiOrigin()).toBe(PINNED_WHATSAPP_API_ORIGIN),
    );
  });

  it("ignores a malformed or non-http override rather than throwing", () => {
    for (const bad of ["not a url", "ftp://example.com", "javascript:alert(1)", "   "]) {
      withEnv({ [WHATSAPP_API_URL_ENV]: bad }, () => expect(resolvedWhatsAppApiOrigin()).toBe(PINNED_WHATSAPP_API_ORIGIN));
    }
  });

  it("knows the real origin from a mock", () => {
    expect(isPinnedWhatsAppOrigin("https://graph.facebook.com/")).toBe(true);
    expect(isPinnedWhatsAppOrigin("http://127.0.0.1:3398")).toBe(false);
  });
});
