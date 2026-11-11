import type { TenantContext } from "../tenancy/types";
import type { PublishedMediaParams } from "./media-params-published";

/**
 * Where the generation tools learn what the gateway published for a model.
 *
 * The price list is read and kept by the host (`model-cache.ts`); a tool in this package has no store
 * and must not know whose key it runs under. So the host installs a source at boot and a tool asks it.
 * Same shape as `outcome-sink.ts`, in the other direction: that one carries what a call learned out to
 * the host, this one carries what the gateway published in to a call.
 *
 * With no source installed (tests, a bare core) a tool uses the built-in table alone.
 */
type PublishedMediaParamsSource = (model: string, tenant: TenantContext | undefined) => PublishedMediaParams | undefined;

let source: PublishedMediaParamsSource | null = null;

/** The host installs one at boot. `null` removes it (tests). */
export function setPublishedMediaParamsSource(next: PublishedMediaParamsSource | null): void {
  source = next;
}

/** What the gateway published for `model`, or `undefined`. A source that throws answers `undefined`. */
export function publishedMediaParamsFor(
  model: string,
  tenant: TenantContext | undefined,
): PublishedMediaParams | undefined {
  if (!source) {
    return undefined;
  }
  try {
    return source(model, tenant);
  } catch {
    return undefined;
  }
}
