/**
 * F1: the one place that hands `@agentforge/core` the desk's allowlist — the same seam as
 * `audit/install.ts` next door in spirit: `assertAllowedDestination` and
 * `resolvePinnedDestination` live in core (they must never import host code), and importing
 * `@agentforge/db` OPENS the SQLite file, so the install happens on a module the router pulls in
 * exactly once.
 */
import { installDestinationAllowlistReader } from "./allowlist";

installDestinationAllowlistReader();
