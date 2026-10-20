import { afterAll, describe, expect, it, vi } from "vitest";
import { sql } from "@agentforge/db";
import { writeWorkbook } from "@agentforge/core/tabular";
import type { HostJsonResult } from "../types";

vi.mock("../finance-figures/read-file", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../finance-figures/read-file")>();
  return {
    ...actual,
    workbookSheets: () => {
      throw new Error("reader down");
    },
  };
});

const { handlePostChatDocument } = await import("./handler");

afterAll(() => {
  sql.close();
});

describe("a figures failure", () => {
  it("never fails the attachment: the text still comes back, and the figures say unreadable", async () => {
    const book = writeWorkbook([
      {
        name: "PL",
        rows: [
          ["Label", "2024"],
          ["Pendapatan", 1250000],
        ],
      },
    ]);
    const result = (await handlePostChatDocument({
      method: "POST",
      path: "/api/v1/chat/documents",
      query: {},
      params: {},
      headers: {},
      files: [{ field: "file", filename: "pl.xlsx", mime: "application/octet-stream", bytes: book }],
    })) as HostJsonResult;
    expect(result.status).toBe(200);
    const document = (result.body as { document: Record<string, unknown> }).document;
    expect(document.text as string).toContain("1250000");
    expect(document.figures).toBeNull();
    expect(document.figuresSkipped).toBe("unreadable");
  });
});
