/** Sample specs for the tests and for the sample files. Test data only: no real names or figures. */
import { parseDocSpec, parseSheetSpec, type DocSpec, type SheetSpec } from "./types";

export const ODD_TEXT = "Laporan Q3 — Rp 1.250.000 😀 café “kutip” ünïcode ✓";

export function sampleDoc(theme: "plain" | "corporate" | "modern" = "corporate"): DocSpec {
  return parseDocSpec({
    kind: "document",
    title: "Quarterly operations review",
    theme,
    titlePage: true,
    sections: [
      {
        id: "summary",
        heading: "Summary",
        blocks: [
          { type: "paragraph", text: "This review covers **three** months of *steady* work." },
          { type: "bullets", items: ["Revenue rose 12%", "Costs held flat"] },
        ],
      },
      {
        id: "plan",
        heading: "Plan",
        blocks: [
          { type: "numbered", items: ["Hire two analysts", "Close the Jakarta office review"] },
          { type: "quote", text: "Small, steady steps beat big promises." },
        ],
      },
      {
        id: "figures",
        heading: "Figures",
        blocks: [
          {
            type: "table",
            columns: ["Region", "Revenue", "Share"],
            rows: [
              ["Jakarta", 120000, "45%"],
              ["Surabaya", 98000, "37%"],
              ["Bandung", 48000, "18%"],
            ],
          },
          { type: "pageBreak" },
        ],
      },
      {
        id: "notes",
        heading: "Notes",
        blocks: [{ type: "paragraph", text: ODD_TEXT }],
      },
    ],
  });
}

export function longDoc(sectionCount: number): DocSpec {
  const sections = Array.from({ length: sectionCount }, (_, index) => ({
    id: `s${index + 1}`,
    heading: `Section ${index + 1}`,
    blocks: [
      {
        type: "paragraph" as const,
        text: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(12),
      },
      { type: "bullets" as const, items: ["First point of the section", "Second point with more words"] },
    ],
  }));
  return parseDocSpec({ kind: "document", title: "Long report", theme: "plain", sections });
}

export function sampleBook(theme: "plain" | "corporate" | "modern" = "modern"): SheetSpec {
  return parseSheetSpec({
    kind: "workbook",
    title: "Budget",
    theme,
    sheets: [
      {
        id: "budget",
        name: "Budget Q3",
        columns: [
          { key: "item", header: "Item", type: "text", width: 28 },
          { key: "amount", header: "Amount", type: "currency" },
          { key: "share", header: "Share", type: "percent" },
          { key: "due", header: "Due", type: "date" },
        ],
        rows: [
          { item: "Office rent", amount: 12000000, share: 0.4, due: "2026-10-01" },
          { item: "Software", amount: 3500000, share: 0.12, due: "2026-10-15" },
          { item: "=1+1 injected label", amount: 800000, share: 0.03, due: "2026-11-01" },
        ],
        totals: true,
        freezeHeader: true,
      },
      {
        id: "headcount",
        name: "Headcount",
        columns: [
          { key: "team", header: "Team", type: "text" },
          { key: "people", header: "People", type: "number" },
        ],
        rows: [
          { team: "Sales", people: 4 },
          { team: "Operations", people: 3 },
        ],
        totals: true,
      },
    ],
  });
}
