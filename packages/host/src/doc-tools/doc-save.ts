import type { ArtifactRefusal } from "../artifact-save";

export {
  QUOTA_MESSAGE,
  TOO_LARGE_MESSAGE,
  UNAVAILABLE_MESSAGE,
  refuse,
  saveRenderedArtifact,
} from "../artifact-save";
export type { SaveInput, SaveOutcome } from "../artifact-save";

export type DocRefusal =
  | ArtifactRefusal
  | "bad_format"
  | "invalid"
  | "not_found"
  | "not_editable"
  | "unsupported"
  | "nothing_to_change"
  | "unreadable";

export type DocToolResult =
  | {
      readonly ok: true;
      readonly artifactId: string;
      readonly title: string;
      readonly format: string;
      readonly filename: string;
      readonly summary: string;
    }
  | { readonly ok: false; readonly reason: DocRefusal; readonly message: string };

export type DocImportResult =
  | {
      readonly ok: true;
      readonly artifactId: string;
      readonly title: string;
      readonly format: string;
      readonly parts: ReadonlyArray<{ readonly id: string; readonly heading: string }>;
      readonly summary: string;
    }
  | { readonly ok: false; readonly reason: DocRefusal; readonly message: string };
