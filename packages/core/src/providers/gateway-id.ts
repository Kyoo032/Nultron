/**
 * The provider id of the pinned gateway. The id is spelled only here: shared code and its tests read this
 * constant, so a white-label build that renames its gateway provider changes the id in this one place
 * (its label in `PROVIDERS` and its pinned URL are separate brand settings).
 *
 * It sits in its own file with no imports because the renderer reads the tier lists
 * (`@agentforge/core/tiers`), and the registry beside it imports the gateway and server-mode code.
 */
export const GATEWAY_PROVIDER_ID = "toko" as const;
