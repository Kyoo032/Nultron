import { describe, expect, it } from "vitest";
import {
  callbackUrl,
  contactLabel,
  deliveryKey,
  formatPhone,
  initialsOf,
  replyTime,
  startOfLocalDay,
  windowState,
} from "./customers-format";

const HOUR = 60 * 60 * 1000;
const NOW = new Date(2026, 10, 2, 15, 30, 0).getTime();

describe("customers format rules", () => {
  it("starts the day at local midnight", () => {
    const start = startOfLocalDay(NOW);
    expect(new Date(start).getHours()).toBe(0);
    expect(new Date(start).getMinutes()).toBe(0);
    expect(NOW - start).toBe(15.5 * HOUR);
  });

  it("counts the reply window down in hours and minutes, rounding minutes up", () => {
    expect(windowState({ open: true, closesAt: NOW + 3 * HOUR + 20 * 60 * 1000 }, NOW)).toEqual({
      kind: "open",
      hours: 3,
      minutes: 20,
    });
    expect(windowState({ open: true, closesAt: NOW + 30 * 1000 }, NOW)).toEqual({ kind: "open", hours: 0, minutes: 1 });
  });

  it("calls a window closed once the host says so or the clock has passed it", () => {
    expect(windowState({ open: false, closesAt: NOW - HOUR }, NOW)).toEqual({ kind: "closed" });
    // The host's answer may be a poll old: the clock settles it.
    expect(windowState({ open: true, closesAt: NOW - 1 }, NOW)).toEqual({ kind: "closed" });
  });

  it("says 'never' for a customer who has not written", () => {
    expect(windowState({ open: false, closesAt: null }, NOW)).toEqual({ kind: "never" });
  });

  it("names a customer by the name they chose, else by their number", () => {
    expect(contactLabel({ contactName: " Dewi ", contactId: "6281200000001" })).toBe("Dewi");
    expect(contactLabel({ contactName: "", contactId: "6281200000001" })).toBe("+6281200000001");
    expect(formatPhone("not-digits")).toBe("not-digits");
  });

  it("takes initials from the first and last word of the name", () => {
    expect(initialsOf({ contactName: "Dewi Lestari Putri" })).toBe("DP");
    expect(initialsOf({ contactName: "dewi" })).toBe("D");
    expect(initialsOf({ contactName: "  " })).toBe("·");
  });

  it("states the median first reply in a unit a person reads at a glance", () => {
    expect(replyTime(null)).toBeNull();
    expect(replyTime(-5)).toBeNull();
    expect(replyTime(0.2)).toEqual({ unit: "seconds", value: 1 });
    expect(replyTime(45)).toEqual({ unit: "seconds", value: 45 });
    expect(replyTime(300)).toEqual({ unit: "minutes", value: 5 });
    expect(replyTime(3 * 3600)).toEqual({ unit: "hours", value: 3 });
  });

  it("gives only the owner's replies a delivery word", () => {
    expect(deliveryKey({ direction: "in", delivery: null })).toBeNull();
    expect(deliveryKey({ direction: "out", delivery: "read" })).toBe("customers.delivery.read");
    expect(deliveryKey({ direction: "out", delivery: null })).toBe("customers.delivery.queued");
  });

  it("builds the callback URL without doubling a slash", () => {
    expect(callbackUrl("https://app.example.com/", "/api/v1/channels/whatsapp/webhook")).toBe(
      "https://app.example.com/api/v1/channels/whatsapp/webhook",
    );
  });
});
