import { describe, expect, it } from "vitest";
import {
  CHAT_FINANCE_FIGURES_NAME_MAX,
  CHAT_FINANCE_FIGURES_NAMES_MAX,
  CHAT_FINANCE_FIGURES_SKIPS,
  HOST_NOTE_PREFIXES,
  chatFinanceFiguresSchema,
  isHostNoteLine,
} from "./index";
import { FINANCE_FIGURES_TEXT_MAX } from "../finance/import-table/limits";

const VALID = {
  figuresText: "Sheet: PL\nPendapatan | 1000 | 1200",
  proseText: "Revenue grew.",
  sheetNames: ["PL", "Neraca"],
  skipped: ["Neraca"],
};

describe("chatFinanceFiguresSchema", () => {
  it("takes the figures the host read", () => {
    expect(chatFinanceFiguresSchema.parse(VALID)).toEqual(VALID);
  });

  it("refuses figures text over the Finance cap", () => {
    const over = { ...VALID, figuresText: "x".repeat(FINANCE_FIGURES_TEXT_MAX + 1) };
    expect(chatFinanceFiguresSchema.safeParse(over).success).toBe(false);
  });

  it("refuses prose over the Finance cap", () => {
    const over = { ...VALID, proseText: "x".repeat(FINANCE_FIGURES_TEXT_MAX + 1) };
    expect(chatFinanceFiguresSchema.safeParse(over).success).toBe(false);
  });

  it("refuses empty figures text", () => {
    expect(chatFinanceFiguresSchema.safeParse({ ...VALID, figuresText: "  " }).success).toBe(false);
  });

  it("refuses too many sheet names or a name that is too long", () => {
    const many = Array.from({ length: CHAT_FINANCE_FIGURES_NAMES_MAX + 1 }, (_, index) => `S${index}`);
    expect(chatFinanceFiguresSchema.safeParse({ ...VALID, sheetNames: many }).success).toBe(false);
    expect(chatFinanceFiguresSchema.safeParse({ ...VALID, skipped: many }).success).toBe(false);
    const long = "n".repeat(CHAT_FINANCE_FIGURES_NAME_MAX + 1);
    expect(chatFinanceFiguresSchema.safeParse({ ...VALID, sheetNames: [long] }).success).toBe(false);
  });

  it("refuses extra keys and wrong types", () => {
    expect(chatFinanceFiguresSchema.safeParse({ ...VALID, path: "uploads/x" }).success).toBe(false);
    expect(chatFinanceFiguresSchema.safeParse({ ...VALID, sheetNames: "PL" }).success).toBe(false);
    expect(chatFinanceFiguresSchema.safeParse(null).success).toBe(false);
  });

  it("names the three reasons a file has no figures", () => {
    expect([...CHAT_FINANCE_FIGURES_SKIPS]).toEqual(["no_table", "unreadable", "blocked"]);
  });
});

describe("the figures note", () => {
  it("is a host note", () => {
    expect(HOST_NOTE_PREFIXES).toContain("[Figures kept");
    expect(
      isHostNoteLine(
        "[Figures kept: uploads/~me/pl.xlsx.figures.json. To answer a question about these figures, call finance_task with this path as file.]",
      ),
    ).toBe(true);
  });
});
