/**
 * The route table, registered onto the server `src/server.ts` builds.
 *
 * `createPortalServer(...).register(route)` is the seam (`apps/portal/AGENTS.md`), so the portal's
 * whole surface is a list of route objects rather than a rewrite of that file. One call in
 * `src/main.ts` turns a health-check-only process into the login service.
 */
import type { PortalRuntime } from "../flows/context";
import type { PortalRoute, PortalServer } from "../server";
import { activateRoutes } from "./activate";
import { assetRoutes } from "./assets";
import { authorizeRoutes } from "./authorize";
import { logoutRoutes } from "./logout";
import { oidcRoutes, type OidcSeams } from "./oidc";
import { signInModeRoutes } from "./signin-mode";
import { tokenRoutes } from "./tokens";

export interface PortalRouteOptions {
  /** Test seams for `routes/oidc.ts` (a stub IdP's `fetch`, a minted-token verifier). */
  readonly oidcSeams?: OidcSeams;
}

export function portalRoutes(runtime: PortalRuntime, options: PortalRouteOptions = {}): readonly PortalRoute[] {
  return Object.freeze([
    ...authorizeRoutes(runtime),
    ...activateRoutes(runtime),
    ...logoutRoutes(runtime),
    ...tokenRoutes(runtime),
    // Empty unless PORTAL_SIGNIN_MODE=password: the default mode's route table is unchanged.
    ...signInModeRoutes(runtime),
    // Empty unless a `PORTAL_OIDC_*` provider is configured (F8b): four literal paths per
    // provider (start + callback for google and/or microsoft).
    ...oidcRoutes(runtime, options.oidcSeams),
    // The brand mark the page shell references. Static, unauthenticated, and the only non-text
    // response the portal sends.
    ...assetRoutes(),
  ]);
}

export function registerPortalRoutes(
  server: PortalServer,
  runtime: PortalRuntime,
  options: PortalRouteOptions = {},
): void {
  for (const route of portalRoutes(runtime, options)) {
    server.register(route);
  }
}

export { requestContext, type RequestContext } from "./support";
