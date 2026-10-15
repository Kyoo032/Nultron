import type { MediaKind, MediaProposalStatus } from "@/components/tool-rows/media-result";
import type { Rec } from "@/components/tool-rows/results";
import type { MediaApi, MediaFailure } from "./media-approval-client";
import { collectToolMediaParts } from "./tool-media";

export type MediaAction = "generate" | "always" | "skip";

export type CardPhase = "checking" | "asking" | "working" | "result" | "ended" | "readonly";

export type MediaCardState = {
  readonly phase: CardPhase;
  readonly action: MediaAction | null;
  readonly status: MediaProposalStatus | null;
  readonly result: Rec | null;
  readonly failure: MediaFailure | null;
};

export const CHECKING: MediaCardState = { phase: "checking", action: null, status: null, result: null, failure: null };

const READONLY: MediaCardState = { phase: "readonly", action: null, status: null, result: null, failure: null };

function asking(failure: MediaFailure | null = null): MediaCardState {
  return { phase: "asking", action: null, status: null, result: null, failure };
}

function working(action: MediaAction): MediaCardState {
  return { phase: "working", action, status: null, result: null, failure: null };
}

function ended(status: MediaProposalStatus): MediaCardState {
  return { phase: "ended", action: null, status, result: null, failure: null };
}

function resultOf(result: Rec): MediaCardState {
  return { phase: "result", action: null, status: "generated", result, failure: null };
}

export function stateForStatus(status: MediaProposalStatus): MediaCardState {
  return status === "pending" ? asking() : ended(status);
}

async function afterRefusal(api: MediaApi, id: string, failure: MediaFailure): Promise<MediaCardState> {
  if (failure.code === "not_found") {
    return READONLY;
  }
  if (failure.code === "not_pending" || failure.code === "expired") {
    return checkProposal(api, id);
  }
  return asking(failure);
}

export async function checkProposal(api: MediaApi, id: string): Promise<MediaCardState> {
  const outcome = await api.fetchProposal(id);
  if (!outcome.ok) {
    return outcome.code === "not_found" ? READONLY : asking(outcome);
  }
  return stateForStatus(outcome.value.status);
}

export async function generateProposal(
  api: MediaApi,
  id: string,
  kind: MediaKind,
  alwaysAllow: boolean,
): Promise<MediaCardState> {
  if (alwaysAllow) {
    const allowed = await api.setAlwaysAllow(kind, true);
    if (!allowed.ok) {
      return asking(allowed);
    }
  }
  const outcome = await api.generate(id);
  if (!outcome.ok) {
    return afterRefusal(api, id, outcome);
  }
  const { proposal, result } = outcome.value;
  if (result && collectToolMediaParts(result).length > 0) {
    return resultOf(result);
  }
  return stateForStatus(proposal.status);
}

export async function skipProposal(api: MediaApi, id: string): Promise<MediaCardState> {
  const outcome = await api.skip(id);
  if (!outcome.ok) {
    return afterRefusal(api, id, outcome);
  }
  return stateForStatus(outcome.value.status);
}

export function startAction(action: MediaAction): MediaCardState {
  return working(action);
}

export function unavailable(): MediaCardState {
  return asking({ ok: false, code: "network", status: 0, message: null });
}
