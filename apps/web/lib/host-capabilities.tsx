import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { parseCapabilities, type HostCapabilities } from "@agentforge/core/capabilities";
import { pingOnce } from "@/lib/host-ping";

export const EVERYTHING_OFF: HostCapabilities = Object.freeze(parseCapabilities(null));

const CapabilitiesContext = createContext<HostCapabilities>(EVERYTHING_OFF);

export function useHostCapabilities(): HostCapabilities {
  return useContext(CapabilitiesContext);
}

export function capabilitiesFrom(payload: unknown): HostCapabilities {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  return parseCapabilities(record.capabilities);
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
