/**
 * The provider id of the pinned gateway. Shared code reads this constant and never spells the id, so a
 * white-label build that renames its gateway provider changes this one literal and nothing else.
 *
 * It sits in its own file with no imports because the renderer reads the tier lists
 * (`@agentforge/core/tiers`), and the registry beside it imports the gateway and server-mode code.
 */
export const GATEWAY_PROVIDER_ID = "toko" as const;
