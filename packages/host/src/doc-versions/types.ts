import type { EditableSpec } from "../doc-tools/doc-meta";

export const DOC_VERSION_CAP = { keepNewest: 50, keepDays: 30 } as const;

export type DocVersionCap = { readonly keepNewest: number; readonly keepDays: number };

export type DocVersionAuthor =
  | { readonly kind: "person"; readonly userId: string }
  | { readonly kind: "agent"; readonly agentId: string; readonly askedByUserId: string };

export type DocVersionInfo = {
  readonly version: number;
  readonly kind: EditableSpec["kind"];
  readonly changedSectionIds: readonly string[];
  readonly baseVersion: number | null;
  readonly note: string | null;
  readonly author: DocVersionAuthor;
  readonly createdAt: number;
};

export type DocVersion = DocVersionInfo & { readonly spec: EditableSpec };

export type SectionAuthor = { readonly version: number; readonly author: DocVersionAuthor };

export type SectionAuthors = Readonly<Record<string, SectionAuthor>>;

export type AppendAuthor =
  | { readonly kind: "person" }
  | { readonly kind: "agent"; readonly agentId: string; readonly askedByUserId?: string };

export type AppendVersionInput = {
  readonly baseVersion: number;
  readonly edit: (head: EditableSpec) => EditableSpec;
  readonly author: AppendAuthor;
  readonly note?: string;
};

export type AppendRefusal = "not_found" | "not_editable" | "bad_base" | "kind_changed" | "section_changed" | "quota";

export type AppendResult =
  | { readonly ok: true; readonly head: DocVersionInfo; readonly created: boolean }
  | { readonly ok: false; readonly reason: AppendRefusal; readonly sectionIds?: readonly string[] };

export type EnsureFirstRefusal = "not_found" | "not_editable" | "quota";

export type EnsureFirstResult =
  | { readonly ok: true; readonly head: DocVersionInfo }
  | { readonly ok: false; readonly reason: EnsureFirstRefusal };

export type ProtectedVersions = (artifactId: string) => ReadonlySet<number>;
