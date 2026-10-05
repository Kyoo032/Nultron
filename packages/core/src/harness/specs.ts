import type { ProductMode } from "../agents/product-modes";
import { chatHarnessSpec } from "./modes/chat";
import { dataHarnessSpec } from "./modes/data";
import { documentsHarnessSpec } from "./modes/documents";
import { editHarnessSpec } from "./modes/edit";
import { educationHarnessSpec } from "./modes/education";
import { financeHarnessSpec } from "./modes/finance";
import { imagesHarnessSpec } from "./modes/images";
import { legalHarnessSpec } from "./modes/legal";
import { marketHarnessSpec } from "./modes/market";
import { meetingHarnessSpec } from "./modes/meeting";
import { musicHarnessSpec } from "./modes/music";
import { presentationsHarnessSpec } from "./modes/presentations";
import { researchHarnessSpec } from "./modes/research";
import { videosHarnessSpec } from "./modes/videos";
import type { ModeHarnessSpec } from "./spec";

/** One declared harness per product mode. The `Record` type makes a missing mode a compile error. */
export const MODE_HARNESS_SPECS: Readonly<Record<ProductMode, ModeHarnessSpec>> = Object.freeze({
  chat: chatHarnessSpec,
  documents: documentsHarnessSpec,
  research: researchHarnessSpec,
  finance: financeHarnessSpec,
  data: dataHarnessSpec,
  market: marketHarnessSpec,
  legal: legalHarnessSpec,
  meeting: meetingHarnessSpec,
  images: imagesHarnessSpec,
  videos: videosHarnessSpec,
  music: musicHarnessSpec,
  edit: editHarnessSpec,
  presentations: presentationsHarnessSpec,
  education: educationHarnessSpec,
});

export function harnessSpecFor(mode: ProductMode): ModeHarnessSpec {
  return MODE_HARNESS_SPECS[mode];
}
