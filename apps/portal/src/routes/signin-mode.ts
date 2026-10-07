/**
 * `GET /auth/signin-mode`: the one way the hosted app's host learns how this portal signs people in.
 *
 * It exists **only in `PORTAL_SIGNIN_MODE=password`**. In the default mode the route is not registered,
 * so the portal's route table is exactly what it was before the password mode existed and this path is
 * the server's own 404; the host reads that 404 (and any other answer that is not the word `password`)
 * as `code`, which is also what a portal older than this change answers. So the host defaults to the
 * e-mailed code unless the portal says otherwise, and a portal that says nothing is never mistaken for
 * one that says "password".
 *
 * The answer is one word and carries nothing else: no tenant, no version, no count of accounts. It is
 * unauthenticated by design, because it is asked before anyone has signed in, and constant, so it needs
 * no limiter and touches no database.
 */
import type { PortalRuntime } from "../flows/context";
import type { PortalRoute } from "../server";
import { jsonResponse } from "./support";

export const SIGNIN_MODE_PATH = "/auth/signin-mode";

export function signInModeRoutes(runtime: PortalRuntime): readonly PortalRoute[] {
  if (runtime.config.signInMode !== "password") {
    return [];
  }
  return [{ method: "GET", path: SIGNIN_MODE_PATH, handle: () => jsonResponse(200, { mode: "password" }) }];
}
