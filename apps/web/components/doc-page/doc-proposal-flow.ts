import {
  askDocSection,
  discardDocProposal,
  DocsError,
  keepDocProposal,
  restoreDocVersion,
  type AskSectionInput,
  type DocChange,
  type DocProposal,
} from "@/lib/docs-client";
import { agentLabel } from "./doc-format";

export const GENERALIST_AGENT_ID = "chat";

export type ProposalFailure =
  | "gateway_blocked"
  | "agent_not_in_workspace"
  | "section_changed"
  | "gone"
  | "conflict"
  | "failed";

export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ProposalFailure };

export type AskAgent = { readonly id: string; readonly label: string };

function failureOf(error: unknown, goneOnNotFound: boolean): ProposalFailure {
  if (!(error instanceof DocsError)) {
    return "failed";
  }
  switch (error.code) {
    case "gateway_blocked":
      return "gateway_blocked";
    case "agent_not_in_workspace":
      return "agent_not_in_workspace";
    case "section_changed":
      return "section_changed";
    case "not_found":
      return goneOnNotFound ? "gone" : "failed";
    default:
      return "failed";
  }
}

function restoreFailureOf(error: unknown): ProposalFailure {
  if (error instanceof DocsError && error.status === 409) {
    return "conflict";
  }
  return "failed";
}

async function attempt<T>(work: () => Promise<T>, classify: (error: unknown) => ProposalFailure): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, failure: classify(error) };
  }
}

export function askSection(
  artifactId: string,
  sectionId: string,
  input: AskSectionInput,
): Promise<Outcome<DocProposal>> {
  return attempt(
    () => askDocSection(artifactId, sectionId, input),
    (error) => failureOf(error, false),
  );
}

export function keepProposal(proposal: DocProposal): Promise<Outcome<DocProposal>> {
  return attempt(
    () => keepDocProposal(proposal.id),
    (error) => failureOf(error, true),
  );
}

export function discardProposal(proposal: DocProposal): Promise<Outcome<DocProposal>> {
  return attempt(
    () => discardDocProposal(proposal.id),
    (error) => failureOf(error, true),
  );
}

export function restoreVersion(artifactId: string, version: number, baseVersion: number): Promise<Outcome<DocChange>> {
  return attempt(() => restoreDocVersion(artifactId, version, baseVersion), restoreFailureOf);
}

export function withPendingProposal(proposals: readonly DocProposal[], proposal: DocProposal): DocProposal[] {
  return [...proposals.filter((candidate) => candidate.sectionId !== proposal.sectionId), proposal];
}

export function withoutProposal(proposals: readonly DocProposal[], proposalId: string): DocProposal[] {
  return proposals.filter((candidate) => candidate.id !== proposalId);
}

export function pendingProposalFor(proposals: readonly DocProposal[], sectionId: string): DocProposal | undefined {
  return proposals.find((candidate) => candidate.sectionId === sectionId);
}

export function agentNameOf(agentId: string, assistantName: string): string {
  return agentId === GENERALIST_AGENT_ID ? assistantName : agentLabel(agentId);
}

export function askAgentOptions(assistantName: string, broughtIn: readonly string[]): AskAgent[] {
  const seen = new Set<string>([GENERALIST_AGENT_ID]);
  const others = broughtIn.flatMap((agentId): AskAgent[] => {
    if (seen.has(agentId)) {
      return [];
    }
    seen.add(agentId);
    return [{ id: agentId, label: agentLabel(agentId) }];
  });
  return [{ id: GENERALIST_AGENT_ID, label: assistantName }, ...others];
}

export function chosenSectionId(sectionIds: readonly string[], wanted: string): string {
  if (sectionIds.includes(wanted)) {
    return wanted;
  }
  return sectionIds[0] ?? "";
}
