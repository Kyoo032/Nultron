import { ApiError, isServerMode } from "@agentforge/core";
import type { HostRequest, HostResult } from "../types";
import { jsonError, jsonOk } from "../errors";
import { keyLaterPayload } from "../key-later";
import { saveUserKeyLater } from "../settings-store";
import { getTenant } from "../tenant";

/** Injected like `ServerModeDeps` in `settings.ts`, so a test can exercise hosted behaviour without the env flag. */
export type KeyLaterDeps = { isServerMode?: () => boolean };

/**
 * `POST /api/v1/settings/key-later` — record that this person chose to add their gateway key later.
 *
 * **Nultron Enterprise only.** On the Personal app (any process that is not in server mode) the
 * route does not exist: a closed gate there is onboarding's key step and has no way out except a key,
 * so there is nothing to record, and the answer is the 404 an unregistered path gets.
 *
 * It is a preference about what the SCREEN shows, never a decision about what the host allows. This
 * handler does not touch the gate, the key or the verdict, and no gateway-calling route reads the
 * record: choosing to wait changes nothing about the flat `403 gateway_blocked` they all answer.
 * For the same reason it is not itself gated: choosing to wait for a key must work with no key.
 *
 * Its own route rather than a field on `POST /api/v1/settings`, for the reason the guide's is: a
 * settings save revokes the knowledge model row, clears three breakers and re-probes the gateway,
 * and none of that should happen because somebody pressed "Add it later". The body is ignored; the
 * time is the host's.
 */
export async function handlePostKeyLater(request: HostRequest, deps: KeyLaterDeps = {}): Promise<HostResult> {
  try {
    const serverMode = deps.isServerMode ? deps.isServerMode() : isServerMode();
    if (!serverMode) {
      throw new ApiError("not_found", "Not found", 404);
    }
    const tenant = await getTenant(request);
    return jsonOk({ keyLater: keyLaterPayload(saveUserKeyLater(tenant)) });
  } catch (error) {
    return jsonError(error);
  }
}
