/**
 * Reading a `research_dossier` call for the Chat card. Pure data in, plain data out, like `deck-result.ts`.
 *
 * The worker's answer (`ResearchWorkerResult` in the host) is `{ ok: true, artifact: { id, title },
 * summary, sections, sourceCount, checks: { passed, failed } }` or a refusal `{ ok: false, ... }`. The
 * dossier itself is not in the answer: it is the saved artifact, which the card loads when a person opens
 * it. So a thread reopened tomorrow draws the same card from the saved call alone.
 */
import { asRecord, readList, readNumber, readString } from "./results";

export const DOSSIER_TOOL_KEY = "research_dossier";

export type DossierCardModel = {
  /** Null when the dossier was written but could not be saved: there is nothing to open. */
  readonly artifactId: string | null;
  readonly title: string;
  readonly summary: string;
  readonly sections: readonly string[];
  readonly sourceCount: number;
  readonly checksPassed: boolean;
  /** How many checks did not pass. Zero only when `checksPassed` is true. */
  readonly failedChecks: number;
};

/**
 * The dossier as a person reads it. The saved file opens with a front-matter block (the question, the
 * queries, the models) that the Research screen reads as data; shown as text it is noise above the title.
 * Only a block that starts on the first line and closes with its own `---` line is removed, so a dossier
 * without one, or a rule drawn further down, is left exactly as it is.
 */
export function dossierBodyForView(markdown: string): string {
  const text = markdown.replace(/^﻿/, "");
  if (!/^---[ \t]*\r?\n/.test(text)) {
    return markdown;
  }
  const close = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(text.slice(3));
  if (!close) {
    return markdown;
  }
  return text.slice(3 + close.index + close[0].length).replace(/^\s+/, "");
}

/**
 * The card for one finished call, or null when it made no dossier. Never throws. A call whose answer
 * says nothing about its checks is not shown as passed: a failed check is never hidden.
 */
export function readDossierResult(_input: unknown, output: unknown): DossierCardModel | null {
  const result = asRecord(output);
  if (result?.ok !== true) {
    return null;
  }
  const artifact = asRecord(result.artifact);
  const title = readString(artifact, "title");
  if (!artifact || !title) {
    return null;
  }
  const checks = asRecord(result.checks);
  const failed = readList(checks, "failed")?.length ?? 0;
  const checksPassed = checks?.passed === true && failed === 0;
  return {
    artifactId: readString(artifact, "id") ?? null,
    title,
    summary: readString(result, "summary") ?? "",
    sections: (readList(result, "sections") ?? []).filter(
      (heading): heading is string => typeof heading === "string" && heading.trim().length > 0,
    ),
    sourceCount: Math.max(0, Math.floor(readNumber(result, "sourceCount") ?? 0)),
    checksPassed,
    failedChecks: failed > 0 ? failed : checksPassed ? 0 : 1,
  };
}
