/**
 * Extraction, wired to the store, the gateway and the job stream (docs/internal/doc-flow-plan.md section 2).
 *
 *  - `generateLegalExtract`  the paid press: read every file, extract, check, save `extract.json`, as job events;
 *  - `readLegalExtractView`  the saved extraction with the owner's edits and comments applied (free);
 *  - `saveLegalExtractEdits` / `addLegalExtractComment`  the owner's inline changes (free), saved beside it.
 *
 * The engine (`extract-engine.ts`) never touches the store. This file does the bookkeeping around it: the file
 * roles and the side the extraction resolved go onto the matter, in code, only where the owner has not already
 * chosen; the record is saved with the model that actually answered; and nothing is changed until the run has
 * finished, so a cancelled extraction leaves the matter as it was.
 */
import { ApiError, type TenantContext } from "@agentforge/core";
import type { DocxDocument } from "@agentforge/core/docx";
import type { JobEmitter } from "@agentforge/core/jobs";
import { type LegalExtractResponse, legalOutputCopy } from "@agentforge/core/legal";
import { readModelPinned } from "../job-regen";
import { throwIfJobAborted } from "../job-stream";
import { localeForRun } from "../run-context";
import { type ExtractBody, type CommentBody, type EditsBody, assertSafeSourceTexts } from "./input";
import { runLegalExtract } from "./extract-engine";
import { addComment, applyEdits, buildExtractView } from "./extract-view";
import { emitPhase, emitStep } from "./instructions";
import { createLegalAsk, requireLegalLive, resolveLegalModel } from "./legal-model";
import type { LegalMatterRecord } from "./records";
import { legalStore, requireLegalMatter } from "./store";

/** The party of the desk's most recent other matter that had a side, for the side question's fallback. */
function deskPartyOf(tenant: TenantContext, matterId: string): string | null {
  const other = legalStore()
    .list(tenant)
    .find((matter) => matter.id !== matterId && matter.side.party.trim() !== "");
  return other ? other.side.party.trim() : null;
}

/** The saved extraction as the owner sees it, or null before the first. */
export function readLegalExtractView(tenant: TenantContext, matter: LegalMatterRecord): LegalExtractResponse {
  const store = legalStore();
  const record = store.getExtract(tenant, matter.id);
  return { extract: record ? buildExtractView(record, store.getExtractEdits(tenant, matter.id), matter) : null };
}

async function loadDocs(
  tenant: TenantContext,
  matter: LegalMatterRecord,
): Promise<{ docs: Map<string, DocxDocument>; pages: Map<string, Record<string, number> | null> }> {
  const store = legalStore();
  const docs = new Map<string, DocxDocument>();
  const pages = new Map<string, Record<string, number> | null>();
  for (const card of matter.docs) {
    const parsed = await store.readDoc(tenant, matter.id, card.id);
    if (!parsed) {
      throw new ApiError("internal_error", `Document ${card.id} could not be loaded`, 500);
    }
    docs.set(card.id, parsed);
    pages.set(card.id, store.readPages(tenant, matter.id, card.id));
  }
  return { docs, pages };
}

export async function generateLegalExtract(
  tenant: TenantContext,
  matterId: string,
  body: ExtractBody,
  rawBody: unknown,
  emit: JobEmitter,
  abortSignal?: AbortSignal,
): Promise<LegalExtractResponse> {
  requireLegalLive(tenant);
  const matter = requireLegalMatter(tenant, matterId);
  const locale = localeForRun();
  const copy = legalOutputCopy(locale);
  const store = legalStore();
  const model = resolveLegalModel(tenant, body.model);
  const { docs, pages } = await loadDocs(tenant, matter);
  const binding = createLegalAsk(tenant, {
    runId: crypto.randomUUID(),
    pinned: readModelPinned(rawBody),
    ...(abortSignal ? { abortSignal } : {}),
  });

  throwIfJobAborted(abortSignal);
  const outcome = await runLegalExtract(
    {
      matter,
      docs,
      pages,
      model,
      locale,
      prompt: body.prompt ?? "",
      deskParty: deskPartyOf(tenant, matterId),
      previous: store.getExtract(tenant, matterId),
      now: () => Date.now(),
    },
    { ask: binding.ask, emit, ...(abortSignal ? { abortSignal } : {}) },
  );

  throwIfJobAborted(abortSignal);
  emitPhase(emit, "saving", locale);
  // File roles and the side go onto the matter first, in code and only where the owner has not chosen.
  if (outcome.roles.length > 0) {
    store.setRoles(tenant, matterId, outcome.roles);
  }
  if (outcome.side) {
    store.update(tenant, matterId, { side: outcome.side });
  }
  store.saveExtract(tenant, matterId, { ...outcome.record, model: binding.answered(model) });
  emitStep(emit, "saving", copy.extractSaved);
  return readLegalExtractView(tenant, requireLegalMatter(tenant, matterId));
}

function actorOf(tenant: TenantContext): string {
  return tenant.userId;
}

function requireExtract(tenant: TenantContext, matter: LegalMatterRecord) {
  const record = legalStore().getExtract(tenant, matter.id);
  if (!record) {
    throw new ApiError("conflict", legalOutputCopy(localeForRun()).noExtract, 409);
  }
  return record;
}

/** The owner's edits: set the listed items' values, or clear one with `null`. Free, and never overwritten by a re-extraction. */
export function saveLegalExtractEdits(
  tenant: TenantContext,
  matter: LegalMatterRecord,
  body: EditsBody,
): LegalExtractResponse {
  assertSafeSourceTexts(body.edits.map((edit) => edit.value ?? ""));
  const store = legalStore();
  const record = requireExtract(tenant, matter);
  const next = applyEdits(record, store.getExtractEdits(tenant, matter.id), body.edits, Date.now(), actorOf(tenant));
  store.saveExtractEdits(tenant, matter.id, next);
  return readLegalExtractView(tenant, matter);
}

/** A comment on one fact or red flag. Free. */
export function addLegalExtractComment(
  tenant: TenantContext,
  matter: LegalMatterRecord,
  body: CommentBody,
): LegalExtractResponse {
  assertSafeSourceTexts([body.text]);
  const store = legalStore();
  const record = requireExtract(tenant, matter);
  const next = addComment(
    record,
    store.getExtractEdits(tenant, matter.id),
    body,
    Date.now(),
    actorOf(tenant),
    crypto.randomUUID(),
  );
  store.saveExtractEdits(tenant, matter.id, next);
  return readLegalExtractView(tenant, matter);
}
