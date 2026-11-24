import { estimateJobUsd, routeEditModel, type PromptTemplate } from "@agentforge/core/edit";
import { formatUsd } from "@agentforge/core/gateway";
import type { MediaParamSpec } from "@agentforge/core/media-params";
import { videoCapabilitiesOf } from "@agentforge/core/video-capabilities";
import { ImageControls, UnverifiedNote, VideoControls } from "@/components/media-controls";
import { MediaControlsNote } from "@/components/media-controls-note";
import {
  adjustedNote,
  fitImagePick,
  fitVideoPick,
  imageRequestFields,
  imageSpecOf,
  videoRequestFields,
  videoSpecOf,
  type ImagePick,
  type VideoPick,
} from "@/lib/media-options";
import { EditPromptTemplates } from "@/components/edit-prompt-templates";
import { ModelSelect } from "@/components/model-select";
import { SettingsLinkHint } from "@/components/settings-link-hint";
import { apiFetch } from "@/lib/api-client";
import { EDIT_GENERATE_NEEDS_KEY_NOTE_ID, editKeyGuard, editKeyHint } from "@/lib/edit-key-guard";
import { hostedKeyBlock } from "@/lib/use-desk-needs-key";
import type { StillClip } from "@/lib/edit-preview-media";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

type StudioModel = {
  id: string;
  label: string;
  provider?: string;
  inputModalities: string[];
  contextLength?: number;
  /** What the model accepts (the host's media parameter spec): the controls below draw from it. */
  media?: MediaParamSpec;
};

/** The narrow rail's select. */
const RAIL_SELECT = "min-w-0 w-full rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1 text-xs";

const STUB_VIDEO: StudioModel[] = [
  { id: "grok-imagine-video", label: "grok-imagine-video", inputModalities: ["text", "image"] },
  { id: "omni-fast-v2v", label: "omni-fast-v2v", inputModalities: ["text"] },
];

const STUB_IMAGE: StudioModel[] = [
  { id: "gpt-image-2", label: "gpt-image-2", inputModalities: ["text", "image"] },
];

const TIERS = ["draft", "standard", "cinematic"] as const;

type Props = {
  project: { id: string; fps?: number } | null;
  playhead?: number;
  /** Image clip under the playhead; offered as the still for "Video from image". */
  stillClip?: StillClip | null;
  models: StudioModel[];
  imageModels?: StudioModel[];
  needsKey: boolean;
  gatewayName: string;
  tier?: string;
  onTierChange?: (tier: string) => void;
  onSubmitted?: () => void;
  onAgentPrompt?: (text: string) => void;
};

/** Edit's price table has three tiers; a bigger one (2k, 4k) is priced as the top tier it has. */
function editPriceTier(resolution: string): "480p" | "720p" | "1080p" {
  if (resolution === "480p" || resolution === "720p" || resolution === "1080p") {
    return resolution;
  }
  return resolution ? "1080p" : "720p";
}

/** The ratio or size is the project's frame in Edit, so the tab never sends one. */
function withoutShape<T extends { aspect?: unknown; size?: unknown; aspectRatio?: unknown }>(
  fields: T,
): Omit<T, "aspect" | "size" | "aspectRatio"> {
  const { aspect: _aspect, size: _size, aspectRatio: _aspectRatio, ...rest } = fields;
  void _aspect;
  void _size;
  void _aspectRatio;
  return rest;
}

/**
 * What an image job carries beside the prompt. The resolution tier goes as `imageResolution`, because
 * `tier` is already the job's draft / standard / cinematic choice.
 */
function imageEditFields(spec: Parameters<typeof imageRequestFields>[0], pick: ImagePick) {
  const { tier: imageResolution, ...rest } = withoutShape(imageRequestFields(spec, pick, "square")) as ReturnType<
    typeof imageRequestFields
  >;
  return { ...rest, ...(imageResolution ? { imageResolution } : {}) };
}

export function EditGenerateTab({
  project,
  playhead = 0,
  stillClip = null,
  models,
  imageModels,
  needsKey,
  gatewayName,
  tier: tierProp = "standard",
  onTierChange,
  onSubmitted,
}: Props) {
  const projectId = project?.id;
  // Hosted only: the tab's own button was already quiet for a missing key (on both products), so the
  // addition is the reason, said so a screen reader and a pointer can read it. Off the hosted build this
  // is false and every helper below returns `{}`, so the Personal markup is what it was.
  const hostedKeyMissing = hostedKeyBlock(needsKey);
  const [useClipStill, setUseClipStill] = useState(true);
  const clipStill = useClipStill ? stillClip : null;
  const [sub, setSub] = useState<"image" | "video" | "storyboard">("video");
  const [tier, setTier] = useState<(typeof TIERS)[number]>(
    tierProp === "draft" || tierProp === "cinematic" ? tierProp : "standard",
  );
  // The stub lists are a no-key desk's demo, nothing more. With a key in place an empty list means
  // this key can run no model of that kind (`GET /api/v1/videos` and `/images` already drop what a
  // real call refused), and the tab says so instead of offering an id that would fail on click.
  const videoCatalog = models.length > 0 ? models : needsKey ? STUB_VIDEO : [];
  const imageCatalog = imageModels && imageModels.length > 0 ? imageModels : needsKey ? STUB_IMAGE : [];
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [stillUrl, setStillUrl] = useState("");
  // What the controls hold. The model's own defaults until the person moves one; a model change moves
  // each value to the nearest one the new model takes, and `note` says so.
  const [videoPick, setVideoPick] = useState<VideoPick>({ aspect: "", seconds: 5, resolution: "720p", audio: false });
  const [imagePick, setImagePick] = useState<ImagePick>({
    shape: "",
    shapeTouched: false,
    quality: "",
    tier: "",
    count: 1,
    format: "",
  });
  const [note, setNote] = useState<string | null>(null);
  const fitted = useRef("");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (tierProp === "draft" || tierProp === "standard" || tierProp === "cinematic") {
      setTier(tierProp);
    }
  }, [tierProp]);

  const liveIds = useMemo(
    () => (sub === "image" ? imageCatalog : videoCatalog).map((item) => item.id),
    [imageCatalog, sub, videoCatalog],
  );
  /** Nothing to generate with: no model of this kind on the key (the stub lists only count with no key). */
  const noModel = liveIds.length === 0;
  const routed = routeEditModel({
    kind: sub === "image" ? "image" : "video",
    tier,
    liveModelIds: liveIds,
    requireImageToVideo: sub === "video" && (Boolean(clipStill) || Boolean(stillUrl.trim())),
  });
  const chosenModel = model && liveIds.includes(model) ? model : "";
  const activeModel = chosenModel || routed || liveIds[0] || "";
  const videoSpec = useMemo(() => videoSpecOf(activeModel, videoCatalog), [activeModel, videoCatalog]);
  const imageSpec = useMemo(() => imageSpecOf(activeModel, imageCatalog), [activeModel, imageCatalog]);
  const imageToVideo = videoCapabilitiesOf(videoSpec).imageToVideo;
  const activeSpec = sub === "image" ? imageSpec : videoSpec;
  const seconds = videoPick.seconds;

  useEffect(() => {
    if (model && !liveIds.includes(model)) {
      setModel("");
    }
  }, [liveIds, model]);

  useEffect(() => {
    if (!imageToVideo) {
      setStillUrl("");
    }
  }, [imageToVideo]);

  // Fit the controls to the model. The first model gets its own defaults and no note; a later one keeps
  // each value it takes and moves the rest to the nearest valid one, and the note says what moved.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the fit runs when the model changes; the picks and the sentence are read, not watched
  useEffect(() => {
    if (!activeModel) {
      return;
    }
    const key = `${sub}:${activeModel}`;
    const first = fitted.current === "";
    if (sub === "video") {
      const result = fitVideoPick(videoSpec, first ? undefined : videoPick);
      setVideoPick(result.pick);
      setNote(first ? null : adjustedNote("videos", activeModel, result.moved));
    } else if (sub === "image") {
      const result = fitImagePick(imageSpec, first ? undefined : imagePick, "square");
      setImagePick(result.pick);
      setNote(first ? null : adjustedNote("images", activeModel, result.moved));
    }
    fitted.current = key;
    // The picks are read, not watched: the fit runs when the model or the kind changes.
  }, [activeModel, sub]);

  const estimate = estimateJobUsd(activeModel, {
    seconds: sub === "video" ? seconds : undefined,
    count: 1,
    resolution: editPriceTier(videoSpec.resolution ? videoPick.resolution : ""),
  });

  function pickTemplate(template: PromptTemplate) {
    setPrompt(template.prompt);
    // A template asks for a length; the model's own values decide what it gets.
    const result = fitVideoPick(videoSpec, { ...videoPick, seconds: template.seconds });
    setVideoPick(result.pick);
    setNote(adjustedNote("videos", activeModel, result.moved));
    setTemplateId(template.id);
  }

  function changePrompt(next: string) {
    setPrompt(next);
    setTemplateId(null);
  }

  function changeTier(next: (typeof TIERS)[number]) {
    setTier(next);
    onTierChange?.(next);
    setModel("");
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!projectId || !prompt.trim() || submitting || noModel) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/v1/edit/projects/${projectId}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: sub === "image" ? "image" : "video",
          prompt: prompt.trim(),
          tier,
          model: activeModel || undefined,
          // Only the fields this model has: its spec decides, the host checks again. The ratio is the
          // project's, so it is not sent from here.
          ...(sub === "video" ? withoutShape(videoRequestFields(videoSpec, videoPick)) : {}),
          ...(sub === "image" ? imageEditFields(imageSpec, imagePick) : {}),
          imageAssetId: sub === "video" && imageToVideo && clipStill ? clipStill.assetId : undefined,
          imageUrl: sub === "video" && imageToVideo && !clipStill ? stillUrl.trim() || undefined : undefined,
          placeAt: { trackId: "v1", timelineStartFrame: playhead },
        }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: { message?: string; code?: string } };
      if (!response.ok) {
        setError(data.error?.message ?? data.error?.code ?? "Generation failed");
        return;
      }
      setPrompt("");
      setStillUrl("");
      setTemplateId(null);
      onSubmitted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-y-auto p-3 text-sm" onSubmit={onSubmit} data-testid="edit-generate">
      <div className="flex min-w-0 flex-col gap-1">
        <button
          type="button"
          className={`btn w-full whitespace-nowrap px-2 py-1.5 text-xs ${sub === "image" ? "btn-primary" : "btn-secondary"}`}
          data-testid="edit-generate-image"
          onClick={() => setSub("image")}
        >
          Image
        </button>
        <button
          type="button"
          className={`btn w-full whitespace-nowrap px-2 py-1.5 text-xs ${sub === "video" ? "btn-primary" : "btn-secondary"}`}
          data-testid="edit-generate-video"
          onClick={() => setSub("video")}
        >
          Video from image
        </button>
        <button
          type="button"
          className={`btn w-full whitespace-nowrap px-2 py-1.5 text-xs ${sub === "storyboard" ? "btn-primary" : "btn-secondary"}`}
          data-testid="edit-generate-storyboard"
          onClick={() => setSub("storyboard")}
        >
          Storyboard
        </button>
      </div>
      {needsKey ? (
        <p
          className="rounded-md border border-[var(--line)] bg-[var(--line)]/30 px-2 py-2 text-xs text-[var(--text-2)]"
          data-testid="edit-needs-key"
          id={hostedKeyMissing ? EDIT_GENERATE_NEEDS_KEY_NOTE_ID : undefined}
        >
          <SettingsLinkHint i18nKey="edit.generate.needsKey" vars={{ gateway: gatewayName }} />
        </p>
      ) : null}
      {!needsKey && sub !== "storyboard" && noModel ? (
        <p
          className="rounded-md border border-[var(--line)] bg-[var(--line)]/30 px-2 py-2 text-xs text-[var(--text-2)]"
          data-testid="edit-generate-no-model"
        >
          <SettingsLinkHint i18nKey="edit.generate.noModel" />
        </p>
      ) : null}
      {sub === "storyboard" ? (
        <p className="text-xs text-[var(--text-3)]">Storyboard lands in Phase 3.</p>
      ) : (
        <>
          <div className="flex min-w-0 flex-col gap-1" data-testid="edit-generate-tier">
            {TIERS.map((id) => (
              <button
                key={id}
                type="button"
                className={`btn w-full px-2 py-1.5 text-xs capitalize ${tier === id ? "btn-primary" : "btn-secondary"}`}
                onClick={() => changeTier(id)}
              >
                {id}
              </button>
            ))}
          </div>
          <span className="text-xs text-[var(--text-2)]" data-testid="edit-estimate">
            {estimate == null ? "price unknown" : formatUsd(estimate)}
          </span>
          <ModelSelect
            models={sub === "image" ? imageCatalog : videoCatalog}
            value={activeModel}
            onChange={setModel}
            testId="edit-generate-model"
            className="min-w-0 w-full rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1 text-xs"
          />
          {sub === "video" ? (
            <VideoControls
              spec={videoSpec}
              pick={videoPick}
              onChange={setVideoPick}
              testIdPrefix="edit-generate"
              selectClassName={RAIL_SELECT}
              showAspect={false}
            />
          ) : null}
          {sub === "image" ? (
            <ImageControls
              spec={imageSpec}
              pick={imagePick}
              shape={imagePick.shape}
              onChange={setImagePick}
              testIdPrefix="edit-generate"
              selectClassName={RAIL_SELECT}
              showShape={false}
            />
          ) : null}
          {activeModel ? <UnverifiedNote kind={sub === "image" ? "images" : "videos"} unverified={activeSpec.unverified} /> : null}
          <MediaControlsNote kind={sub === "image" ? "images" : "videos"} note={note} made={null} />
          {sub === "video" && imageToVideo && stillClip ? (
            <label className="flex items-center gap-2 text-xs" data-testid="edit-generate-still-clip">
              <input type="checkbox" checked={useClipStill} onChange={(event) => setUseClipStill(event.target.checked)} />
              Animate the image clip under the playhead
            </label>
          ) : null}
          {sub === "video" && imageToVideo && !clipStill ? (
            <input
              type="text"
              className="min-w-0 w-full rounded-md border border-[var(--line)] bg-transparent px-2 py-1 text-xs"
              placeholder={stillClip ? "…or paste a still image URL" : "Still image URL, or move the playhead onto an image clip"}
              value={stillUrl}
              onChange={(event) => setStillUrl(event.target.value)}
              data-testid="edit-generate-still"
            />
          ) : sub === "video" && !imageToVideo ? (
            <p className="text-xs text-[var(--text-3)]">This model is text-to-video only</p>
          ) : null}
          <textarea
            className="min-h-[72px] min-w-0 w-full rounded-md border border-[var(--line)] bg-transparent px-2 py-1 text-xs"
            placeholder={sub === "image" ? "Describe an image…" : "Describe a video…"}
            value={prompt}
            onChange={(event) => changePrompt(event.target.value)}
            data-testid="edit-generate-prompt"
            {...editKeyHint(hostedKeyMissing, EDIT_GENERATE_NEEDS_KEY_NOTE_ID)}
          />
          {error ? (
            <p className="text-xs text-red-700" role="alert">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            className="btn btn-primary w-full px-2 py-1.5 text-xs"
            {...editKeyGuard(hostedKeyMissing, EDIT_GENERATE_NEEDS_KEY_NOTE_ID)}
            disabled={needsKey || submitting || noModel || !prompt.trim() || !projectId}
            data-testid="edit-generate-submit"
          >
            {submitting ? "Generating…" : "Generate"}
          </button>
          {sub === "video" ? <EditPromptTemplates onPick={pickTemplate} selectedId={templateId} /> : null}
        </>
      )}
    </form>
  );
}
