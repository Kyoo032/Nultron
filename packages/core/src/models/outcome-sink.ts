import type { TenantContext } from "../tenancy/types";
import type { ModelKind } from "./gateway-catalog";

/**
 * What one real gateway call to one model came to. The generation tools report it; the host decides
 * what to remember (`packages/host/src/model-availability.ts`). Core holds no store, and a tool must
 * not know whose key it ran under, which is why this is a sink and not a write.
 */
export type ModelOutcomeReport = {
  tenant: TenantContext | undefined;
  model: string;
  kind: ModelKind;
} & ({ ok: true } | { ok: false; error: unknown });

type ModelOutcomeSink = (report: ModelOutcomeReport) => void;

let sink: ModelOutcomeSink | null = null;

/** The host installs one at boot. `null` removes it (tests). */
export function setModelOutcomeSink(next: ModelOutcomeSink | null): void {
  sink = next;
}

/** Learning is a by-product of a call and must never break it, so a sink that throws is ignored. */
export function reportModelOutcome(report: ModelOutcomeReport): void {
  if (!sink) {
    return;
  }
  try {
    sink(report);
  } catch {
    // Not the call's problem.
  }
}
