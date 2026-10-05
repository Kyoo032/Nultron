"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { getGateState, resolveNeedsKey, subscribeGateState } from "@/lib/gate-state";
import { isHostedBuild } from "@/lib/hosted-build";
import { readSettings } from "@/lib/settings-read";
import { parseGatewayGate, type GatewayGatePayload } from "@/lib/gateway-gate";

/**
 * The host already decided. Quiet Send and Generate only when `allowed` is
 * false. Stub reports `allowed: true` so Cloud and Playwright still send.
 * This does not look at status or key shape.
 */
export function hostWithholdsLiveModel(gate: GatewayGatePayload | null | undefined): boolean {
  if (!gate) return false;
  return gate.allowed === false;
}

/**
 * Should this pane offer a model call, or say the key is missing?
 *
 * On the Personal app: the host's gate, read once at mount, exactly as it has always been (a closed
 * gate there is onboarding, so a mounted pane only ever reads an open one).
 *
 * On the hosted build the desk can open with no key ("Add it later") and the panes are kept alive, so
 * a read taken at mount goes stale the moment a key is saved in Settings, or the moment any call
 * answers `403 gateway_blocked`. There the answer is the shared gate store (`gate-state.ts`), which
 * the settings reads, saves and re-checks publish into. The mount-time read below still happens on
 * both and is what feeds the store.
 *
 * `hostedOnly` is for a pane that had no needs-key state before this existed: off the hosted build
 * it answers `false` and makes no request at all, so gaining the hook changes nothing there.
 *
 * Unknown (still loading, or no payload) does not block.
 */
export function useDeskNeedsKey(options: { hostedOnly?: boolean } = {}): boolean {
  const hosted = isHostedBuild();
  const active = hosted || !options.hostedOnly;
  const [own, setOwn] = useState(false);
  const shared = useSyncExternalStore(subscribeGateState, getGateState, getGateState);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    // Shared with the shell's gate read and the other Chat readers: one round trip per load. The read
    // itself publishes the gate to the shared store (hosted only), so there is nothing to forward here.
    void readSettings()
      .then((answer) => {
        if (cancelled || !answer.ok || !answer.body) return;
        setOwn(hostWithholdsLiveModel(parseGatewayGate(answer.body.gateway)));
      })
      .catch(() => {
        // Leave the controls as they are; a failed settings read is not a new decision.
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  return active && resolveNeedsKey(hosted, own, shared);
}

/**
 * A pane that already had its own needs-key state (Chat, Documents, Images) asks this to see whether
 * the *hosted* part of the story applies: the same fact as `needsKey`, but false off the hosted
 * build, so the Personal pane keeps exactly the markup and the errors it had.
 */
export function hostedKeyBlock(needsKey: boolean): boolean {
  return needsKey && isHostedBuild();
}

/** `useDeskNeedsKey` for a pane that is new to it: hosted only, silent and request-free elsewhere. */
export function useHostedNeedsKey(): boolean {
  return useDeskNeedsKey({ hostedOnly: true });
}
