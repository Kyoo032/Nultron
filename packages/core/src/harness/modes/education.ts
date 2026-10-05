import { DEFAULT_RUN_BUDGET } from "../defaults";
import type { ModeHarnessSpec } from "../spec";

/**
 * Lesson, exam, book and presenter are drafted locally by the university pack and never ask a model
 * for text (`packages/host/src/handlers/education.ts`: "None of these call the gateway"), so there
 * is no model loop and no tool. The drafts are still checked (`packages/host/src/education/harness.ts`,
 * `packages/university/src/education/checks.ts`): a lesson, a quiz or a show that fails its check is
 * drafted once more and then rebuilt in code, which is the one repair round. It does not go through
 * `runChecked`, because there is no model to hand an ERROR / WHY / FIX note to. Changing a slide and
 * reading a page check once and never retry.
 */
export const educationHarnessSpec: ModeHarnessSpec = {
  mode: "education",
  loop: "none",
  tools: [],
  budget: DEFAULT_RUN_BUDGET,
  repairRounds: 1,
  skills: [
    { id: "teaching-deck", name: "Teaching deck", status: "new" },
    { id: "edit-text-and-shapes", name: "Edit text and add shapes", status: "new" },
    { id: "exam-from-knowledge", name: "Exam from the knowledge base", status: "new" },
    { id: "book-reader", name: "Book reader with local OCR", status: "new" },
    { id: "video-presenter", name: "Video presenter", status: "new" },
  ],
};
