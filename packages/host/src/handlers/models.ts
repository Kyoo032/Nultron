import type { HostRequest, HostResult } from "../types";
import { jsonError, jsonOk } from "../errors";
import { getTenant } from "../tenant";
import { modelCatalogBody, refreshModelCache } from "../selectable-models";
import { modelAvailabilityBody } from "../model-availability-payload";
import { probeSummary } from "../model-cache";
import { loadSettings } from "../settings-store";
import { withTierFields } from "../tier-resolve";

export async function handleGetModels(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    return jsonOk({
      ...withTierFields(modelCatalogBody(tenant), tenant),
      availability: modelAvailabilityBody(tenant),
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function handlePostModels(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    // Explicit refresh from the UI: also re-download the models.dev registry.
    // Refresh also forgets what real calls taught about this key, so a model that was refused is offered
    // and tried afresh (`model-availability.ts`).
    const probe = await refreshModelCache(loadSettings(tenant), {
      forceRegistry: true,
      scope: tenant,
      forgetLessons: true,
    });
    return jsonOk({
      ...withTierFields(modelCatalogBody(tenant), tenant),
      probe: probeSummary(probe, tenant),
      availability: modelAvailabilityBody(tenant),
    });
  } catch (error) {
    return jsonError(error);
  }
}
