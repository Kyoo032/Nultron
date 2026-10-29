/**
 * What a Chat send says to the host, and what the host's refusal says back (tester code, chat-first plan
 * track M1, model tiers spec section 4).
 *
 * A run names a tier. It never names a model, and it carries no Thinking flag or reasoning level: the
 * host reads Thinking off the tier, and a `thinking` or `reasoningEffort` in the body would be ignored
 * at best. A body with `tier` and `model` together is a 400 (`tier_and_model`), so the helper has no way
 * to build one.
 */
import type { MediaRequest } from "@agentforge/core/media-permission";
import type { ModelTierId } from "@agentforge/core/tiers";
import { t } from "./i18n";

/**
 * The JSON body of `POST /api/v1/threads/:id/runs/{text,image,video}`: the content and the tier, `retry` only on a
 * Try again, and `paidMedia` only on a turn that follows a Run press (SR-167).
 */
export type ChatRunBody = Readonly<{
  content: unknown;
  tier: ModelTierId;
  retry?: true;
  paidMedia?: Readonly<{ grants: readonly MediaRequest[] }>;
}>;

export function buildChatRunBody(
  content: unknown,
  tier: ModelTierId,
  retry = false,
  grants: readonly MediaRequest[] = [],
): ChatRunBody {
  return Object.freeze({
    content,
    tier,
    ...(retry ? { retry: true as const } : {}),
    ...(grants.length > 0 ? { paidMedia: Object.freeze({ grants }) } : {}),
  });
}

/**
 * The sentence for a refusal about the tier, in the desk's language, or `null` when the body is about
 * something else (so the caller keeps the path it already had: the hosted no-key sentence, then the host's
 * own `error.message`, then the generic one).
 *
 * `tier_unavailable` (503) means no model of the chosen tier is live right now. The host's own sentence
 * is for the log and can name a model, so it is never shown for this code. `unknown_tier` and
 * `tier_and_model` (both 400) cannot come from this renderer: it only sends an id the registry lists, and
 * never a model. They fall through to the caller's path if a stale tab ever triggers one.
 */
export function tierErrorMessage(body: unknown): string | null {
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return code === "tier_unavailable" ? t("chat.errors.tierUnavailable") : null;
}
