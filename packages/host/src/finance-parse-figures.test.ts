import { describe, expect, it, vi } from "vitest";

/**
 * The code-only read is what `/finance/auto` runs, and it is free: it must never reach the gateway.
 * Every model entry point is replaced by one that throws, so a call anywhere fails the test loudly.
 */
vi.mock("./job-regen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./job-regen")>();
  const refuse = async () => {
    throw new Error("the code-only read must not call a model");
  };
  return { ...actual, collectJobAssistantRun: refuse, collectJobAssistantText: refuse };
});

const { readFiguresCodeOnly } = await import("./finance-parse-figures");

const SHEET = [
  "Sheet: PL",
  "Item | 2024 | 2025",
  "Revenue | 1000 | 1200",
  "COGS | 400 | 480",
  "Opex | 300 | 330",
  "Zorblax fees | 20 | 25",
].join("\n");

describe("readFiguresCodeOnly", () => {
  it("reads a table into confirmed rows without a model, and reports the labels no rule could place", () => {
    const read = readFiguresCodeOnly(SHEET, "en");
    expect(read).not.toBeNull();
    expect(read?.draft.needsConfirmation).toBe(true);
    expect(read?.draft.source).toBe("table");
    expect(read?.draft.items).toHaveLength(8);
    expect(read?.draft.items.find((item) => item.label === "Revenue" && item.period === "2025")).toMatchObject({
      amount: 1200,
      category: "revenue",
    });
    // Nothing named this one, so it stays "other" and is reported rather than guessed.
    expect(read?.draft.items.find((item) => item.label === "Zorblax fees")?.category).toBe("other");
    expect(read?.unclassified.map((entry) => entry.label)).toEqual(["Zorblax fees"]);
    expect(read?.draft.model).toBeUndefined();
  });

  it("is null for text with no table in it: that read needs the model", () => {
    expect(readFiguresCodeOnly("Revenue was strong this year and costs were stable.", "en")).toBeNull();
    expect(readFiguresCodeOnly("", "en")).toBeNull();
  });

  it("is null when part of the text did not read as a row, rather than keeping the half it understood", () => {
    expect(readFiguresCodeOnly(`${SHEET}\nthis line is not a row at all`, "en")).toBeNull();
  });

  it("expands a magnitude suffix before it reads, including after a short word", () => {
    const read = readFiguresCodeOnly("Revenue of 18.4B\nCOGS of 7.9B", "en");
    expect(read?.draft.items.map((item) => item.amount)).toEqual([18_400_000_000, 7_900_000_000]);
    const id = readFiguresCodeOnly("Pendapatan: Rp 18,4 miliar\nHPP: Rp 7,9 miliar", "id");
    expect(id?.draft.items.map((item) => item.amount)).toEqual([18_400_000_000, 7_900_000_000]);
  });

  it("names the figures a document states in a sentence from the sentence itself, with no model", () => {
    const read = readFiguresCodeOnly(SHEET, "en", {
      proseText: "The company employs 140 permanent staff across 6 branches.",
    });
    expect(read?.draft.proseFacts.length).toBeGreaterThan(0);
    for (const fact of read?.draft.proseFacts ?? []) {
      expect(fact.label.length).toBeGreaterThan(0);
    }
  });

  it("changes nothing it is given", () => {
    const options = { proseText: "Headcount was 140." };
    const before = JSON.stringify([SHEET, options]);
    readFiguresCodeOnly(SHEET, "en", options);
    expect(JSON.stringify([SHEET, options])).toBe(before);
  });
});
