import type { HostRequest, HostResult } from "../types";
import { jsonError, jsonOk } from "../errors";
import { getTenant } from "../tenant";
import { modelCatalogBody, refreshModelCache } from "../selectable-models";
import { probeSummary } from "../model-cache";
import { loadSettings } from "../settings-store";

export async function handleGetModels(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    return jsonOk(modelCatalogBody(tenant));
  } catch (error) {
    return jsonError(error);
  }
}

export async function handlePostModels(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    // Explicit refresh from the UI: also re-download the models.dev registry.
    const probe = await refreshModelCache(loadSettings(tenant), { forceRegistry: true, scope: tenant });
    return jsonOk({ ...modelCatalogBody(tenant), probe: probeSummary(probe, tenant) });
  } catch (error) {
    return jsonError(error);
  }
}
