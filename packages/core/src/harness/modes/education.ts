import { DEFAULT_RUN_BUDGET } from "../defaults";
import type { ModeHarnessSpec } from "../spec";

/**
 * Lesson, exam, book and presenter are drafted locally by the university pack and never call the
 * gateway (`packages/host/src/handlers/education.ts`: "None of these call the gateway").
 */
export const educationHarnessSpec: ModeHarnessSpec = {
  mode: "education",
  loop: "none",
  tools: [],
  budget: DEFAULT_RUN_BUDGET,
  repairRounds: 0,
  skills: [
    { id: "teaching-deck", name: "Teaching deck", status: "new" },
    { id: "edit-text-and-shapes", name: "Edit text and add shapes", status: "new" },
    { id: "exam-from-knowledge", name: "Exam from the knowledge base", status: "new" },
    { id: "book-reader", name: "Book reader with local OCR", status: "new" },
    { id: "video-presenter", name: "Video presenter", status: "new" },
  ],
};
