import { z } from "zod";
import { FINANCE_FIGURES_TEXT_MAX } from "../finance/import-table/limits";

export const CHAT_FINANCE_FIGURES_NAMES_MAX = 100;
export const CHAT_FINANCE_FIGURES_NAME_MAX = 200;
export const CHAT_FINANCE_FIGURES_SKIPS = ["no_table", "unreadable", "blocked"] as const;

export type ChatFinanceFiguresSkip = (typeof CHAT_FINANCE_FIGURES_SKIPS)[number];

const names = z.array(z.string().max(CHAT_FINANCE_FIGURES_NAME_MAX)).max(CHAT_FINANCE_FIGURES_NAMES_MAX);

export const chatFinanceFiguresSchema = z
  .object({
    figuresText: z
      .string()
      .max(FINANCE_FIGURES_TEXT_MAX)
      .refine((value) => value.trim() !== ""),
    proseText: z.string().max(FINANCE_FIGURES_TEXT_MAX),
    sheetNames: names,
    skipped: names,
  })
  .strict();

export type ChatFinanceFigures = z.infer<typeof chatFinanceFiguresSchema>;

export function isChatFinanceFiguresSkip(value: unknown): value is ChatFinanceFiguresSkip {
  return CHAT_FINANCE_FIGURES_SKIPS.some((skip) => skip === value);
}
