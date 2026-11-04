/**
 * Legal mode — request body validation for the matter routes.
 *
 * Every body is parsed with zod at the boundary; the first issue becomes a 400 `invalid_request`
 * with the field path so the studio can show it next to the input.
 */

import { z } from "zod";
import { ApiError } from "@agentforge/core";
import {
  DELIVERABLE_KINDS,
  DOC_ROLES,
  LEGAL_ASK_QUESTION_MAX,
  LEGAL_CAPS,
  LEGAL_COMMENT_MAX_CHARS,
  LEGAL_EDIT_MAX_CHARS,
  LEGAL_PROMPT_MAX,
  LEGAL_WORK_TYPES,
} from "@agentforge/core/legal";
import { assertSafeSourceText } from "../job-source";

export const LEGAL_TEXT_MAX = 200;
const ID_MAX = 80;
const MODEL_ID_MAX = 200;
const DOC_ID_PATTERN = /^S\d+$/;

const shortText = z
  .string()
  .trim()
  .min(1, "is required")
  .max(LEGAL_TEXT_MAX, `must be ${LEGAL_TEXT_MAX} characters or fewer`);
const optionalText = z.string().trim().max(LEGAL_TEXT_MAX, `must be ${LEGAL_TEXT_MAX} characters or fewer`);
const optionalId = z.string().trim().min(1, "is required").max(ID_MAX, "is malformed").nullable().optional();

/** A new matter may have no parties yet: the documents say who they are, and the owner can answer later. */
const createSideSchema = z
  .object({ role: optionalText.default(""), party: optionalText.default(""), counterparty: optionalText.default("") })
  .prefault({ role: "", party: "", counterparty: "" });

/** Setting the side (the answer to the side question) needs at least a party; the others may stay empty. */
const sideSchema = z.object({ role: optionalText.default(""), party: shortText, counterparty: optionalText.default("") });

const deliverablesSchema = z
  .array(z.enum(DELIVERABLE_KINDS))
  .min(1, "must list at least one deliverable")
  .transform((list) => Array.from(new Set(list)));

const instructionsSchema = z
  .string()
  .max(
    LEGAL_CAPS.maxInstructionChars,
    `must be ${LEGAL_CAPS.maxInstructionChars.toLocaleString()} characters or fewer`,
  );

export const createMatterBodySchema = z.object({
  title: shortText,
  side: createSideSchema,
  workType: z.enum(LEGAL_WORK_TYPES),
  deliverables: deliverablesSchema,
  instructions: instructionsSchema.default(""),
  playbookId: optionalId,
  author: optionalText.default(""),
  addressee: optionalText.default(""),
  firm: optionalText.default(""),
  priorMatterId: optionalId,
});

export const rolesSchema = z
  .array(z.object({ id: z.string().regex(DOC_ID_PATTERN, "is not a document id"), role: z.enum(DOC_ROLES) }))
  .max(LEGAL_CAPS.maxFiles, `must list at most ${LEGAL_CAPS.maxFiles} documents`);

export const patchMatterBodySchema = z
  .object({
    title: shortText.optional(),
    side: sideSchema.optional(),
    /** True: the owner answered "Neither / just reading" to the side question, so it is not asked again. */
    sideDeclined: z.boolean().optional(),
    workType: z.enum(LEGAL_WORK_TYPES).optional(),
    deliverables: deliverablesSchema.optional(),
    instructions: instructionsSchema.optional(),
    playbookId: optionalId,
    author: optionalText.optional(),
    addressee: optionalText.optional(),
    firm: optionalText.optional(),
    roles: rolesSchema.optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), { message: "nothing to update" });

export const runBodySchema = z.object({
  model: z.string().trim().max(MODEL_ID_MAX, "is malformed").optional(),
  verifierModel: z.string().trim().max(MODEL_ID_MAX, "is malformed").optional(),
});

/** `POST .../extract/stream`. `prompt` is the owner's optional steer; it never relaxes a check. */
export const extractBodySchema = z.object({
  model: z.string().trim().max(MODEL_ID_MAX, "is malformed").optional(),
  prompt: z.string().trim().max(LEGAL_PROMPT_MAX, `must be ${LEGAL_PROMPT_MAX} characters or fewer`).optional(),
});

/** `POST .../ask/stream`. */
export const askBodySchema = z.object({
  question: z
    .string()
    .trim()
    .min(1, "is required")
    .max(LEGAL_ASK_QUESTION_MAX, `must be ${LEGAL_ASK_QUESTION_MAX} characters or fewer`),
  model: z.string().trim().max(MODEL_ID_MAX, "is malformed").optional(),
});

const ITEM_ID_MAX = 120;
const EDITS_PER_REQUEST_MAX = 50;

/** `PUT .../extract/edits`: set the listed items' values; `value: null` removes an edit (back to what the documents say). */
export const editsBodySchema = z.object({
  edits: z
    .array(
      z.object({
        itemId: z.string().trim().min(1, "is required").max(ITEM_ID_MAX, "is malformed"),
        value: z
          .string()
          .max(LEGAL_EDIT_MAX_CHARS, `must be ${LEGAL_EDIT_MAX_CHARS} characters or fewer`)
          .nullable(),
      }),
    )
    .min(1, "must list at least one edit")
    .max(EDITS_PER_REQUEST_MAX, `must list at most ${EDITS_PER_REQUEST_MAX} edits`),
});

/** `POST .../extract/comments`. */
export const commentBodySchema = z.object({
  itemId: z.string().trim().min(1, "is required").max(ITEM_ID_MAX, "is malformed"),
  text: z
    .string()
    .trim()
    .min(1, "is required")
    .max(LEGAL_COMMENT_MAX_CHARS, `must be ${LEGAL_COMMENT_MAX_CHARS} characters or fewer`),
});

export type CreateMatterBody = z.output<typeof createMatterBodySchema>;
export type ExtractBody = z.output<typeof extractBodySchema>;
export type AskBody = z.output<typeof askBodySchema>;
export type EditsBody = z.output<typeof editsBodySchema>;
export type CommentBody = z.output<typeof commentBodySchema>;
export type PatchMatterBody = z.output<typeof patchMatterBodySchema>;
export type LegalRunBody = z.output<typeof runBodySchema>;

/** Parse a JSON body; the first zod issue becomes a user-facing 400 with its field path. */
export function parseLegalBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body ?? {});
  if (result.success) {
    return result.data;
  }
  const issue = result.error.issues[0];
  const field = issue?.path.length ? issue.path.join(".") : "body";
  throw new ApiError("invalid_request", `${field} ${issue?.message ?? "is invalid"}`, 400);
}

/** Text the owner types that reaches a prompt or is read back into one (a steer, a question, an edit, a comment). */
export function assertSafeSourceTexts(texts: readonly string[]): void {
  for (const text of texts) {
    assertSafeSourceText(text);
  }
}

/** Instructions go straight into the prompt, so they pass the same guard as pasted source material. */
export function assertSafeInstructions(instructions: string | undefined): void {
  if (instructions) {
    assertSafeSourceText(instructions);
  }
}
