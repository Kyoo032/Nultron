import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { parseCapabilities, type HostCapabilities } from "@agentforge/core/capabilities";
import { pingOnce } from "@/lib/host-ping";

export const EVERYTHING_OFF: HostCapabilities = Object.freeze(parseCapabilities(null));

const CapabilitiesContext = createContext<HostCapabilities>(EVERYTHING_OFF);

export function useHostCapabilities(): HostCapabilities {
  return useContext(CapabilitiesContext);
}

/**
 * True when the packaged shell is attached AND the host says this target may have one.
 *
 * Both halves are needed and neither is enough: the bridge alone would offer a relaunch on a
 * hypothetical packaged build pointed at a hosted host, and the flag alone would offer one on
 * webdev, where there is no shell to ask and the answer is `unavailable`.
 */
export function hasDesktopShell(_capabilities: HostCapabilities): boolean {
  return false;
}

export function hasNativeFilePicker(_capabilities: HostCapabilities): boolean {
  return false;
}

/**
 * Ping payload → capabilities. Exported for `lib/session.tsx`, which reads the same payload rather
 * than this context: a child provider's effect runs before its parent's, so from inside the tree
 * "sessions: false" and "ping has not answered" are the same value here and different facts.
 */
export function capabilitiesFrom(payload: unknown): HostCapabilities {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  // `apiFetch` over the desktop IPC transport answers `{ body: … }`; over HTTP it answers the body
  // itself. Same unwrapping `brandFromUnknown` does, and for the same reason.
  const nested = record.body && typeof record.body === "object" ? (record.body as Record<string, unknown>) : record;
  return parseCapabilities(nested.capabilities);
}

export function HostCapabilitiesProvider({ children }: { children: ReactNode }) {
  const [capabilities, setCapabilities] = useState<HostCapabilities>(EVERYTHING_OFF);

  useEffect(() => {
    let live = true;
    void pingOnce().then((payload) => {
      if (live) {
        setCapabilities(capabilitiesFrom(payload));
      }
    });
    return () => {
      live = false;
    };
  }, []);

  return <CapabilitiesContext.Provider value={capabilities}>{children}</CapabilitiesContext.Provider>;
}

/** Test seam: render a subtree with a known set of capabilities and no network at all. */
export function HostCapabilitiesFixture({
  capabilities,
  children,
}: {
  capabilities: HostCapabilities;
  children: ReactNode;
}) {
  return <CapabilitiesContext.Provider value={capabilities}>{children}</CapabilitiesContext.Provider>;
}
