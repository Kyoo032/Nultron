/**
 * `build_deck`, without the model: an outline in, a saved PowerPoint artifact out.
 *
 * The Presentation mode writes its outline with a model call and then exports it. Chat already has
 * the model in the loop, so this takes the outline the model just wrote and runs only the host's own
 * half: clean it and hold it to the limits in `deck-limits.ts`, validate it as the Presentation mode
 * does, run the same structure checks, build the file with the same exporter, and store it through the
 * artifact store so the existing download route serves it. No model is called here.
 *
 * A refusal is a value, not a throw, so the model reads it as a tool result and can fix the outline and
 * call again (the per-run cap on the tool keeps that bounded). That includes every limit: the tool's
 * schema sets none, because an argument the SDK refuses ends the whole turn. The messages are for the
 * model and are English; what the person sees is the card in the renderer, written from its own catalog.
 *
 * Limits that apply to a deck: the artifact body cap (`ARTIFACT_BODY_MAX_BYTES`, 4 MB on the base64
 * text, about 3 MB of file), `DECK_MAX_SLIDES` and the per-field ceilings in `deck-schema.ts`, and, on
 * the hosted server, the tenant storage ceiling. A saved deck counts in what the tenant holds (its
 * `size_bytes`, the base64 text, is what `tenant-storage.ts` adds up), so the ceiling is asked about
 * that number and a tenant at it is refused until it deletes something.
 */
import { ApiError, type TenantContext } from "@agentforge/core";
import { artifactFilename, PPTX_MIME } from "@agentforge/core/artifacts";
import { ARTIFACT_BODY_MAX_BYTES, artifactStore } from "../artifacts";
import { formatRepairNote, runChecked, type FailedVerdict } from "../harness/run-checked";
import { log } from "../log";
import { presentationChecks } from "../presentation-checks";
import { parsePresentationOutlineBody } from "../presentation-outline";
import { buildPresentationPptx } from "../presentation-pptx";
import { assertStorageAdmits, isStorageQuotaError } from "../tenant-storage";
import { cleanDeckInput, deckLimitProblems, formatDeckLimitProblems } from "./deck-limits";
import type { BuildDeckInput } from "./deck-schema";

export type DeckRefusal = "limits" | "invalid" | "checks" | "too_large" | "quota" | "unavailable";

export type BuildDeckResult =
  | {
      readonly ok: true;
      readonly artifactId: string;
      readonly filename: string;
      /** Slides in the file, the title slide included: the number PowerPoint shows. */
      readonly slideCount: number;
    }
  | { readonly ok: false; readonly reason: DeckRefusal; readonly message: string };

const UNAVAILABLE_MESSAGE = "The deck could not be saved right now. Tell the owner, and do not retry.";
const TOO_LARGE_MESSAGE =
  "The deck is too large to save. Shorten the speaker notes and the bullets, then call build_deck again.";
const QUOTA_MESSAGE =
  "The owner's storage is full, so the deck was not saved. Tell the owner to free space in Settings; do not retry.";

function refuse(reason: DeckRefusal, message: string): BuildDeckResult {
  return { ok: false, reason, message };
}

function isFailed(verdict: { readonly ok: boolean }): verdict is FailedVerdict {
  return !verdict.ok;
}

function toBase64(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("base64");
}

export async function buildDeckForTenant(input: BuildDeckInput, tenant: TenantContext): Promise<BuildDeckResult> {
  const deck = cleanDeckInput(input);
  const problems = deckLimitProblems(deck);
  if (problems.length > 0) {
    return refuse("limits", formatDeckLimitProblems(problems));
  }

  let outline: ReturnType<typeof parsePresentationOutlineBody>;
  try {
    outline = parsePresentationOutlineBody({ title: deck.title, slides: deck.slides });
  } catch (error) {
    return refuse("invalid", error instanceof ApiError ? error.message : "The outline is not a valid deck.");
  }

  const checked = await runChecked({
    produce: async () => outline,
    checks: presentationChecks(null),
    repairRounds: 0,
  });
  if (!checked.passed) {
    return refuse("checks", formatRepairNote(checked.verdicts.filter(isFailed)));
  }

  let base64: string;
  try {
    base64 = toBase64((await buildPresentationPptx(outline)).buffer);
  } catch (error) {
    log.warn("build_deck_export_failed", { detail: error instanceof Error ? error.message.slice(0, 120) : "error" });
    return refuse("unavailable", UNAVAILABLE_MESSAGE);
  }
  // What the artifact row will carry (`size_bytes`), and so what the tenant's use will grow by.
  const storedBytes = Buffer.byteLength(base64, "utf8");
  if (storedBytes > ARTIFACT_BODY_MAX_BYTES) {
    return refuse("too_large", TOO_LARGE_MESSAGE);
  }

  const slideCount = outline.slides.length + 1;
  try {
    await assertStorageAdmits(tenant.tenantId, storedBytes);
    const saved = artifactStore().create(tenant, {
      mode: "presentations",
      kind: "draft",
      title: outline.title,
      mime: PPTX_MIME,
      body: base64,
      meta: { source: "chat", slides: slideCount },
    });
    return { ok: true, artifactId: saved.id, filename: artifactFilename(saved.title, PPTX_MIME), slideCount };
  } catch (error) {
    if (isStorageQuotaError(error)) {
      return refuse("quota", QUOTA_MESSAGE);
    }
    if (error instanceof ApiError && error.status === 413) {
      return refuse("too_large", TOO_LARGE_MESSAGE);
    }
    log.warn("build_deck_not_saved", { code: error instanceof ApiError ? error.code : "internal_error" });
    return refuse("unavailable", UNAVAILABLE_MESSAGE);
  }
}
