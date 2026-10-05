import { hostCapabilities, isServerMode } from "@agentforge/core";

/**
 * The folder root is a Personal feature: a path on this machine means something to this host only
 * when the host is the owner's own process. On the hosted server a path is the operator's disk, so
 * both questions are asked and both must say yes.
 *
 * Read per call, never frozen at import: the suites flip `AGENTFORGE_SERVER` after the module graph
 * has loaded, exactly as `isServerMode()` itself documents.
 */
export function folderRootAvailable(): boolean {
  return hostCapabilities().localPaths && !isServerMode();
}
