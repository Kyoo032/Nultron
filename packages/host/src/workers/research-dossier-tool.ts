import { z } from "zod";
import { ApiError, defineTool, type TenantContext } from "@agentforge/core";
import { generateResearchNotes } from "../research-generate";
import { currentWorkerChannel, runWithWorkerProgress } from "./worker-channel";

export const RESEARCH_DOSSIER_TOOL_KEY = "research_dossier";

/** The model sees this much of the dossier's summary. The whole dossier stays in the artifact. */
const SUMMARY_MAX = 1200;
const SECTIONS_MAX = 12;

const schema = z.object({
  question: z
    .string()
    .trim()
    .min(8)
    .max(2000)
    .describe("The research question, as one clear sentence or short paragraph, in the conversation's language."),
});

export type ResearchWorkerResult =
  | {
      readonly ok: true;
      readonly artifact: { readonly id: string | null; readonly kind: "research"; readonly title: string };
      readonly summary: string;
      readonly sections: readonly string[];
      readonly sourceCount: number;
      readonly checks: {
        readonly passed: boolean;
        readonly rounds: number;
        readonly failed: readonly { readonly check: string; readonly error: string }[];
      };
    }
  | { readonly ok: false; readonly reason: "failed" | "cancelled"; readonly code: string; readonly message: string };

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The Research harness as a tool of the Research agent's conversation. It calls the mode's own entry
 * function in process, so the plan, the search, the page reads, the injection scan, the citation
 * checks and the one repair round are exactly what the Research screen runs. The model gets a short
 * summary and the artifact id; the dossier itself is drawn from the saved artifact.
 */
export async function runResearchWorker(
  args: z.infer<typeof schema>,
  tenant: TenantContext,
): Promise<ResearchWorkerResult> {
  const channel = currentWorkerChannel();
  try {
    const result = await runWithWorkerProgress(RESEARCH_DOSSIER_TOOL_KEY, (emit, signal) =>
      generateResearchNotes(tenant, { prompt: args.question }, emit, signal),
    );
    const sources = new Set<string>();
    for (const note of result.notes) {
      for (const source of note.sources) {
        const key = source.url || source.title;
        if (key) {
          sources.add(key);
        }
      }
    }
    return {
      ok: true,
      artifact: { id: result.artifactId, kind: "research", title: result.dossier.title },
      summary: clip(result.summary, SUMMARY_MAX),
      sections: result.notes.slice(0, SECTIONS_MAX).map((note) => note.heading),
      sourceCount: sources.size,
      checks: {
        passed: result.checks.passed,
        rounds: result.checks.rounds,
        failed: result.checks.verdicts.flatMap((verdict) =>
          verdict.ok ? [] : [{ check: verdict.check, error: verdict.error }],
        ),
      },
    };
  } catch (error) {
    if (channel?.signal?.aborted) {
      return {
        ok: false,
        reason: "cancelled",
        code: "cancelled",
        message: "The run was stopped before the dossier was written.",
      };
    }
    const code = error instanceof ApiError ? error.code : "internal_error";
    const message = error instanceof Error ? error.message : "The dossier could not be written.";
    return { ok: false, reason: "failed", code, message };
  }
}

const DESCRIPTION = [
  "Research one question on the web and write a sourced dossier: plans the queries, searches, reads the pages, and writes findings that each cite a source.",
  "It takes a few minutes. Call it once per question; do not call it for small talk or for a question about yourself.",
  "The answer has a short summary, the section headings, how many sources were used and which checks failed. The dossier is shown to the owner as a card, so do not paste it.",
].join(" ");

export const researchDossierTool = defineTool({
  key: RESEARCH_DOSSIER_TOOL_KEY,
  name: "Research dossier",
  description: DESCRIPTION,
  schema,
  // Its summary and headings are written from web pages, so they are scanned like a search result
  // before the model reads them. The ids and counts beside them are the host's own.
  trust: "network",
  execute: (args, tenant) => runResearchWorker(args, tenant),
});
