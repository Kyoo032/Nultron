import { availableVideoDefault } from "../models/key-models";
import { DEFAULT_GATEWAY_VIDEO_MODEL, mediaKind, pickPreferredImageModel } from "../models/media-kind";
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

export function gatewayGenerateModel(kind: GenerateKind, requested?: string): string {
  const catalog = getMediaModels()?.[kind];
  return (
    acceptedRequest(requested, kind, catalog) ?? getSecret(CONFIGURED_MODEL[kind]) ?? catalogDefault(kind, catalog)
  );
}
