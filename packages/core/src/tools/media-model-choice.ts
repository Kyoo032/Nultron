import { availableVideoDefault } from "../models/key-models";
import { DEFAULT_GATEWAY_VIDEO_MODEL, mediaKind, pickPreferredImageModel } from "../models/media-kind";
import { imageModelForReference } from "../models/media-params";
import { getMediaModels, getSecret } from "./secret-scope";

type GenerateKind = "image" | "video";

const CONFIGURED_MODEL: Record<GenerateKind, string> = {
  image: "IMAGE_GEN_MODEL",
  video: "VIDEO_GEN_MODEL",
};

function acceptedRequest(
  requested: string | undefined,
  kind: GenerateKind,
  catalog: readonly string[] | undefined,
): string | undefined {
  const want = requested?.trim();
  if (!want) {
    return undefined;
  }
  if (catalog === undefined) {
    return want;
  }
  if (catalog.length === 0) {
    return mediaKind(want) === kind ? want : undefined;
  }
  const key = want.toLowerCase();
  return catalog.find((id) => id.toLowerCase() === key);
}

function catalogDefault(kind: GenerateKind, catalog: readonly string[] = []): string {
  if (kind === "image") {
    return pickPreferredImageModel([...catalog]);
  }
  return availableVideoDefault(catalog) || DEFAULT_GATEWAY_VIDEO_MODEL;
}

/**
 * The model a generate call runs. A model the person or the model named wins. Otherwise the configured
 * default, else the catalogue's preferred id. `withReference` says a picture comes with the request: when that
 * default takes no reference (the 2.5 image ids publish no edit route), the call goes to
 * `IMAGE_REFERENCE_MODEL` instead, so "edit this picture" keeps working on a desk whose default is 2.5.
 */
export function gatewayGenerateModel(
  kind: GenerateKind,
  requested?: string,
  options: { withReference?: boolean } = {},
): string {
  const catalog = getMediaModels()?.[kind];
  const named = acceptedRequest(requested, kind, catalog);
  if (named) {
    return named;
  }
  const chosen = getSecret(CONFIGURED_MODEL[kind]) ?? catalogDefault(kind, catalog);
  return kind === "image" && options.withReference ? imageModelForReference(chosen) : chosen;
}
