import { mediaKind } from "./media-kind";
import { bareModelId } from "./request-constraints";

/**
 * Whether a Chat model reads images.
 *
 * `yes`: the app knows it does. `no`: the app knows it does not, so an image is never sent to it.
 * `unknown`: a model this table has no line for. The gateway's catalogue moves faster than any list
 * kept here, so an unknown model is tried rather than refused, and the person is told before they
 * send that nobody has confirmed it.
 *
 * Pure, with no Node imports: the host (to refuse and to build the request) and the renderer (to tell
 * the person before they press Send) both read it, so the two cannot disagree.
 *
 * The evidence is the "Modality" column of `docs/internal/gateway-model-selection.md` (section 6, the
 * full index) and its text-only list (section 1.8). A `no` is only ever written from that evidence: a wrong `no` blocks
 * a person from a model that works, while a wrong `yes` or `unknown` costs one clear gateway error.
 */
export type ImageInputSupport = "yes" | "no" | "unknown";

/** Models the gateway doc lists as text-only. A dated snapshot of the same model is the same answer. */
const TEXT_ONLY: readonly RegExp[] = [
  /^gpt-oss/,
  /^o1(?:-|$)/,
  /^glm-5\.[23](?:-fast-preview)?(?:-\d{8})?$/,
  /^deepseek-v4-pro(?:-\d{8})?$/,
  /^minimax-m2\.\d$/,
  /^qwen3-max(?:-\d{8})?$/,
  /^qwen3\.6-max-preview$/,
  /^qwen-flash/,
  /^qwen3-coder/,
];

/** Models, and families, the gateway doc lists as reading images (its "text+vision" and "omni" rows). */
const READS_IMAGES: readonly RegExp[] = [
  /^claude-/,
  /^gpt-[456]/,
  /^chatgpt-4o/,
  /^o[34](?:-|$)/,
  /^gemini/,
  /^gemma/,
  // The gateway's own alias for its recommended model. The app has always treated it as multimodal.
  /^default$/,
  // Doc section 4.5: `deepseek-v4-flash` and the dated `-1-flash` both resolve to V4.1-Flash, which has
  // native vision. (The doc's index row for `deepseek-v4-flash` still says text; its body says vision.)
  /^deepseek-v4(?:-1)?-flash/,
  /^deepseek-v4\.1/,
  /^deepseek-flash/,
  /^glm-5\.3-flash/,
  // K2.6, K2.7 and K3 read images (doc section 4.7); the app has always said yes to the whole family.
  /^kimi-/,
  /^minimax-m3/,
  /^qwen3\.[5-8](?:-|$)/,
  /^qwen3-omni/,
  /^qwen3-vl-(?!embedding|rerank)/,
  /^doubao-seed-/,
  /^seed-[12]\./,
];

/** A model that reads pictures and gets them wrong, with the measurement that says so. */
export type PictureMisread = Readonly<{
  /** The bare id, as `bareModelId` spells it: lower case, no vendor prefix. Exact: a dated snapshot is a different model. */
  id: string;
  /** The day the measurement was made, `YYYY-MM-DD`. */
  measured: string;
  evidence: string;
}>;

const LUNA_PICTURE_TEST =
  "A 128x128 picture, left half red and right half blue, asked for the colour of each half through the Chat run path on :3000";

/**
 * Models that receive a picture, read it, and still misreport it. They stay in `READS_IMAGES`: an explicit
 * choice of one with a picture is accepted, and nothing here refuses it. All the mark does is move the model
 * to the end of a tier's walk for a turn that carries a picture (`tiers.ts`, `resolveTier`), so Daily and
 * Fastest answer such a turn from a model that read it correctly while one is live.
 *
 * This is a measurement, not a rule about a family. Add an id only with the date and the test that showed it,
 * and remove it when the model is measured right. `gpt-6-sol`, `deepseek-v4-1-flash`, `claude-opus-5-5` and
 * `gemini-3.5-flash` answered the same request correctly on 2026-11-13, so neither the family nor the wire is
 * the cause: the request's `input_image` part is byte-identical to what AI SDK 4 sent
 * (`runtime-recording-golden.json`), and the models name one of the picture's two colours.
 */
export const PICTURE_MISREADS: readonly PictureMisread[] = Object.freeze([
  Object.freeze({
    id: "gpt-6-luna",
    measured: "2026-11-13",
    evidence: `${LUNA_PICTURE_TEST}: wrong in 4 of 4 tries ("Both halves are blue", "Both halves are red").`,
  }),
  Object.freeze({
    id: "gpt-5.6-luna",
    measured: "2026-11-13",
    evidence: `${LUNA_PICTURE_TEST}: wrong in 1 of 1 tries.`,
  }),
]);

const MISREADING_IDS: ReadonlySet<string> = new Set(PICTURE_MISREADS.map((entry) => entry.id));

/** Whether a measurement in `PICTURE_MISREADS` says this model misreads a picture it was given. */
export function modelMisreadsPictures(modelId: string): boolean {
  return MISREADING_IDS.has(bareModelId(modelId));
}

export function modelImageInput(modelId: string): ImageInputSupport {
  const id = bareModelId(modelId);
  if (!id) {
    return "unknown";
  }
  // A generator, an embedder or a speech model is not a Chat model that reads what you attach.
  if (mediaKind(id) !== "chat") {
    return "no";
  }
  if (TEXT_ONLY.some((rule) => rule.test(id))) {
    return "no";
  }
  if (READS_IMAGES.some((rule) => rule.test(id))) {
    return "yes";
  }
  return "unknown";
}
