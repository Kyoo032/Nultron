import { z } from "zod";
import { apiFetch } from "./api-client";
import { GATEWAY_BLOCKED_ERROR } from "./gateway-gate";

export type DocFormat = "docx" | "pdf" | "xlsx";
export type DocKind = "document" | "workbook";

export class DocsError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "DocsError";
    this.code = code;
    this.status = status;
  }
}

const cellValue = z.union([z.string(), z.number(), z.null()]);

const authorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person"), userId: z.string() }),
  z.object({ kind: z.literal("agent"), agentId: z.string(), askedByUserId: z.string() }),
]);

export type DocAuthor = z.infer<typeof authorSchema>;

const blockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("paragraph"), text: z.string() }),
  z.object({ type: z.literal("bullets"), items: z.array(z.string()) }),
  z.object({ type: z.literal("numbered"), items: z.array(z.string()) }),
  z.object({ type: z.literal("quote"), text: z.string() }),
  z.object({ type: z.literal("pageBreak") }),
  z.object({ type: z.literal("table"), columns: z.array(z.string()), rows: z.array(z.array(cellValue)) }),
]);

export type DocBlock = z.infer<typeof blockSchema>;

const knownBlocks = z.array(z.unknown()).transform((items) =>
  items.flatMap((item) => {
    const parsed = blockSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  }),
);

const sectionSchema = z.object({
  id: z.string(),
  heading: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  blocks: knownBlocks,
});

export type DocSection = z.infer<typeof sectionSchema>;

const documentSpecSchema = z.object({
  kind: z.literal("document"),
  title: z.string(),
  theme: z.string(),
  titlePage: z.boolean(),
  sections: z.array(sectionSchema),
});

export type DocumentSpec = z.infer<typeof documentSpecSchema>;

const columnSchema = z.object({
  key: z.string(),
  header: z.string(),
  type: z.enum(["text", "number", "currency", "percent", "date"]),
  width: z.number().nullish(),
});

const sheetSchema = z.object({
  id: z.string(),
  name: z.string(),
  columns: z.array(columnSchema),
  rows: z.array(z.record(z.string(), cellValue)),
  totals: z.boolean(),
  freezeHeader: z.boolean(),
});

export type DocSheet = z.infer<typeof sheetSchema>;

const workbookSpecSchema = z.object({
  kind: z.literal("workbook"),
  title: z.string(),
  theme: z.string(),
  sheets: z.array(sheetSchema),
});

export type WorkbookSpec = z.infer<typeof workbookSpecSchema>;

const specSchema = z.discriminatedUnion("kind", [documentSpecSchema, workbookSpecSchema]);

export type DocSpec = z.infer<typeof specSchema>;

const sectionAuthorsSchema = z.record(z.string(), z.object({ version: z.number().int(), author: authorSchema }));

export type SectionAuthors = z.infer<typeof sectionAuthorsSchema>;

const proposalSchema = z.object({
  id: z.string(),
  artifactId: z.string(),
  sectionId: z.string(),
  section: sectionSchema,
  baseVersion: z.number().int(),
  agentId: z.string(),
  askedByUserId: z.string(),
  status: z.enum(["pending", "kept", "discarded"]),
  keptVersion: z.number().int().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type DocProposal = z.infer<typeof proposalSchema>;

const docPageSchema = z.object({
  artifactId: z.string(),
  title: z.string(),
  kind: z.enum(["document", "workbook"]),
  headVersion: z.number().int(),
  spec: specSchema,
  sectionAuthors: sectionAuthorsSchema,
  proposals: z.array(proposalSchema),
});

export type DocPage = z.infer<typeof docPageSchema>;

const versionSchema = z.object({
  version: z.number().int(),
  kind: z.enum(["document", "workbook"]),
  changedSectionIds: z.array(z.string()),
  baseVersion: z.number().int().nullable(),
  note: z.string().nullable(),
  author: authorSchema,
  createdAt: z.number(),
});

export type DocVersion = z.infer<typeof versionSchema>;

const versionsSchema = z.object({ items: z.array(versionSchema) });

const MALFORMED_CODE = "docs_malformed";
const GENERIC_CODE = "docs_error";
const MALFORMED_MESSAGE = "The document answer could not be read.";
const FAILED_MESSAGE = "The document request failed.";

export function errorFromPayload(payload: unknown, status: number): DocsError {
  if (payload && typeof payload === "object" && (payload as { error?: unknown }).error === GATEWAY_BLOCKED_ERROR) {
    return new DocsError(GATEWAY_BLOCKED_ERROR, FAILED_MESSAGE, status);
  }
  const envelope = payload && typeof payload === "object" ? (payload as { error?: unknown }).error : undefined;
  const error = envelope && typeof envelope === "object" ? (envelope as Record<string, unknown>) : null;
  const code = error && typeof error.code === "string" ? error.code : GENERIC_CODE;
  const message = error && typeof error.message === "string" ? error.message : FAILED_MESSAGE;
  return new DocsError(code, message, status);
}

function parseWith<S extends z.ZodTypeAny>(schema: S, payload: unknown): z.infer<S> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new DocsError(MALFORMED_CODE, MALFORMED_MESSAGE, 502);
  }
  return parsed.data;
}

export function parseDocPage(payload: unknown): DocPage {
  return parseWith(docPageSchema, payload);
}

export function parseDocVersions(payload: unknown): DocVersion[] {
  return parseWith(versionsSchema, payload).items;
}

const docPath = (artifactId: string) => `/api/v1/docs/${encodeURIComponent(artifactId)}`;

export function docVersionFilePath(artifactId: string, version: number, format: DocFormat): string {
  return `${docPath(artifactId)}/versions/${version}/file?format=${format}`;
}

async function getJson(path: string): Promise<unknown> {
  const res = await apiFetch(path);
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw errorFromPayload(data, res.status);
  }
  return data;
}

const proposalEnvelopeSchema = z.object({ proposal: proposalSchema });

const changeSchema = z.object({
  headVersion: z.number().int(),
  version: versionSchema.nullable(),
  sectionAuthors: sectionAuthorsSchema,
  bodyRefreshed: z.boolean(),
});

export type DocChange = z.infer<typeof changeSchema>;

export type AskSectionInput = {
  readonly agentId: string;
  readonly instruction: string;
  readonly baseVersion: number;
};

async function postJson(path: string, body: unknown = {}): Promise<unknown> {
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw errorFromPayload(data, res.status);
  }
  return data;
}

const proposalPath = (proposalId: string) => `/api/v1/docs/proposals/${encodeURIComponent(proposalId)}`;

export async function askDocSection(
  artifactId: string,
  sectionId: string,
  input: AskSectionInput,
): Promise<DocProposal> {
  const path = `${docPath(artifactId)}/sections/${encodeURIComponent(sectionId)}/proposals`;
  return parseWith(proposalEnvelopeSchema, await postJson(path, input)).proposal;
}

export async function keepDocProposal(proposalId: string): Promise<DocProposal> {
  return parseWith(proposalEnvelopeSchema, await postJson(`${proposalPath(proposalId)}/keep`)).proposal;
}

export async function discardDocProposal(proposalId: string): Promise<DocProposal> {
  return parseWith(proposalEnvelopeSchema, await postJson(`${proposalPath(proposalId)}/discard`)).proposal;
}

export async function restoreDocVersion(artifactId: string, version: number, baseVersion: number): Promise<DocChange> {
  return parseWith(changeSchema, await postJson(`${docPath(artifactId)}/versions/${version}/restore`, { baseVersion }));
}

export async function fetchDocPage(artifactId: string): Promise<DocPage> {
  return parseDocPage(await getJson(docPath(artifactId)));
}

export async function fetchDocVersions(artifactId: string): Promise<DocVersion[]> {
  return parseDocVersions(await getJson(`${docPath(artifactId)}/versions`));
}

export type DocSectionInput = { readonly heading?: string; readonly blocks: readonly DocBlock[] };

const sectionsPath = (artifactId: string) => `${docPath(artifactId)}/sections`;

async function sendDocJson(method: "PUT" | "POST" | "DELETE", path: string, body: unknown): Promise<DocChange> {
  const res = await apiFetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw errorFromPayload(data, res.status);
  }
  return parseWith(changeSchema, data);
}

export function putDocSection(
  artifactId: string,
  sectionId: string,
  input: { readonly baseVersion: number; readonly section: DocSectionInput },
): Promise<DocChange> {
  return sendDocJson("PUT", `${sectionsPath(artifactId)}/${encodeURIComponent(sectionId)}`, input);
}

export function postDocSection(
  artifactId: string,
  input: { readonly baseVersion: number; readonly afterSectionId?: string; readonly section: DocSectionInput },
): Promise<DocChange> {
  return sendDocJson("POST", sectionsPath(artifactId), input);
}

export function deleteDocSection(
  artifactId: string,
  sectionId: string,
  input: { readonly baseVersion: number },
): Promise<DocChange> {
  return sendDocJson("DELETE", `${sectionsPath(artifactId)}/${encodeURIComponent(sectionId)}`, input);
}

const importedSchema = z.object({ artifactId: z.string() });

export async function importDocPage(artifactId: string): Promise<string> {
  const res = await apiFetch("/api/v1/docs/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ artifactId }),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw errorFromPayload(data, res.status);
  }
  return parseWith(importedSchema, data).artifactId;
}
