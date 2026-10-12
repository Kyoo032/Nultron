import type { HostRequest, HostResult } from "../types";
import { jsonError, jsonOk } from "../errors";
import { getTenant } from "../tenant";
import { listVirtualAgents } from "../virtual-agents";

/** The desk's virtual agents (the generalist, then one per mode the desk has) and the ones it could hire. */
export async function handleGetVirtualAgents(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    return jsonOk(await listVirtualAgents(tenant));
  } catch (error) {
    return jsonError(error);
  }
}
