/**
 * Voice rows on the tenant ledger. Audio has no list price, so seconds take the existing
 * `no_list_price` path. Token rows go through `recordTokenUsage` and whatever the catalog can say.
 * `askNultron` records its own model calls; nothing here records them again. An aborted reply has
 * no usage event and records nothing.
 */
import type { TenantContext } from "@agentforge/core";
import { recordUsage } from "../tenant-usage";
import { priceSecondsUsage, recordTokenUsage } from "../usage-record";
import type { TalkerUsage } from "./talker";

export function recordVoiceReplyUsage(tenant: TenantContext, model: string, usage: TalkerUsage): void {
  recordTokenUsage(
    tenant,
    { model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
    { mode: "voice" },
  );
}

/**
 * Transcriber seconds, or the seconds a session was open. Skips a zero.
 * The ledger stores `quantity` as a whole number (`nonNegativeInt`), so a fraction is rounded up.
 * A 0.4 s transcript would otherwise be stored as 0.
 */
export function recordVoiceSeconds(tenant: TenantContext, model: string, seconds: number): void {
  if (!(seconds > 0) || !Number.isFinite(seconds)) return;
  const quantity = Math.ceil(seconds);
  recordUsage(tenant, {
    mode: "voice",
    model,
    unit: "seconds",
    quantity,
    inputTokens: 0,
    outputTokens: 0,
    ...priceSecondsUsage(model, quantity),
  });
}
