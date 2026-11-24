"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { messageUnlessBlocked } from "@/lib/gateway-blocked";
import type { MediaPrice } from "@agentforge/core/media-pricing";
import type { MediaAdjustment, MediaParamSpec, VideoSent } from "@agentforge/core/media-params";
import { videoCapabilitiesOf } from "@agentforge/core/video-capabilities";
import type { PromptTemplate } from "@agentforge/core/edit";
import { EditPromptTemplates } from "@/components/edit-prompt-templates";
import { EnhancePromptButton } from "@/components/enhance-prompt-button";
import { ExampleGallery } from "@/components/example-gallery";
import { GalleryVideo } from "@/components/gallery-media";
import { SavedPicturePicker } from "@/components/saved-picture-picker";
import { VideoExamples } from "@/components/video-examples";
import { Confetti } from "@/components/confetti";
import { ModeHeader } from "@/components/mode-header";
import { MascotSlot } from "@/components/mascot-slot";
import { ModelSelect } from "@/components/model-select";
import { StudioEmptyDesk } from "@/components/studio-empty-desk";
import { WorkingStatus } from "@/components/working-status";
import { SettingsLinkHint } from "@/components/settings-link-hint";
import { isGatewayBlockedText } from "@/lib/gateway-blocked";
import { useHostedNeedsKey } from "@/lib/use-desk-needs-key";
import { studioPickerEmpty } from "@/lib/studio-picker-empty";
import { t } from "@/lib/i18n";
import { PROMPT_INPUT, PROMPT_ROW, PROMPT_SUBMIT } from "@/lib/prompt-row";
import { mediaPriceHints, videoEstimateView } from "@/lib/media-estimate";
import { MediaControlsNote } from "@/components/media-controls-note";
import { UnverifiedNote, VideoControls } from "@/components/media-controls";
import {
  adjustedNote,
  estimateResolution,
  fitVideoPick,
  videoRequestFields,
  videoSentNote,
  videoSpecOf,
  type VideoPick,
} from "@/lib/media-options";
import { keepModelChoice } from "@/lib/model-choice";
import { stillSource, type SavedPicture } from "@/lib/saved-picture";
import { apiFetch, mediaSrc } from "@/lib/api-client";
import { useCatalogVersion } from "@/lib/catalog-version";
import { useProductBrand } from "@/lib/product-brand";

type StudioModel = {
  id: string;
  label: string;
  provider?: string;
  inputModalities: string[];
  contextLength?: number;
  /** Provider list price per second for the cost estimate; null when nobody has transcribed one. */
  price?: MediaPrice | null;
  /** What the model accepts (the host's media parameter spec): the controls below draw from it. */
  media?: MediaParamSpec;
};

type GalleryItem = {
  id: string;
  url: string;
  mime: string;
  createdAt: string;
  prompt?: string;
  aspect?: string;
  model?: string;
  /** The host's word that the file is gone from the store: the row lists, the player does not mount. */
  fileMissing?: boolean;
};

type GalleryResponse = {
  items: GalleryItem[];
  models: StudioModel[];
  defaultModel: string;
  ready: boolean;
};

export function VideosStudio() {
  const { gatewayName } = useProductBrand();
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [models, setModels] = useState<StudioModel[]>([]);
  const [listed, setListed] = useState(false);
  const [model, setModel] = useState("");
  // What the controls hold. The model's own defaults until the person moves one; a model change moves
  // each value to the nearest one the new model takes, and `note` says so.
  const [pick, setPick] = useState<VideoPick>({ aspect: "16:9", seconds: 5, resolution: "720p", audio: false });
  const [note, setNote] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const fitted = useRef("");
  const [prompt, setPrompt] = useState("");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [stillUrl, setStillUrl] = useState("");
  const [savedPicture, setSavedPicture] = useState<SavedPicture | null>(null);
  const [ready, setReady] = useState(true);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [landed, setLanded] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch("/api/v1/videos");
      const data = (await response.json().catch(() => ({}))) as GalleryResponse & {
        error?: { message?: string };
      };
      if (seq !== loadSeq.current) {
        return;
      }
      if (!response.ok) {
        setError(data.error?.message ?? t("videos.loadError"));
        setReady(false);
        return;
      }
      setItems(data.items ?? []);
      setModels(data.models ?? []);
      setListed(true);
      // `load` runs again after every generate. Keeping the chosen model also keeps the clip length:
      // `seconds` only re-snaps when the model changes.
      setModel((current) => keepModelChoice(current, data.models ?? [], data.defaultModel));
      setReady(Boolean(data.ready));
    } catch (err) {
      if (seq !== loadSeq.current) {
        return;
      }
      setError(err instanceof Error ? err.message : t("videos.loadError"));
      setReady(false);
    } finally {
      if (seq === loadSeq.current) {
        setLoading(false);
      }
    }
  }, []);

  const catalogVersion = useCatalogVersion();
  useEffect(() => {
    void catalogVersion;
    void load();
  }, [load, catalogVersion]);

  // Nultron Enterprise: a signed-in tenant may open the desk before adding a key (hosted only; false
  // elsewhere). `ready` above is what the gallery read said at mount, so when a key is saved in Settings
  // the studio asks again instead of staying quiet until a reload.
  const keyMissing = useHostedNeedsKey();
  const wasMissing = useRef(false);
  useEffect(() => {
    if (wasMissing.current && !keyMissing) {
      void load();
    }
    wasMissing.current = keyMissing;
  }, [keyMissing, load]);
  const keyReady = ready && !keyMissing;

  const spec = useMemo(() => videoSpecOf(model, models), [model, models]);
  const caps = videoCapabilitiesOf(spec);
  const imageToVideo = caps.imageToVideo;

  // Fit the controls to the model. The first model gets its own defaults and no note; a later one keeps
  // each value it takes and moves the rest to the nearest valid one, and the note says what moved.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the fit runs when the model changes; the picks and the sentence are read, not watched
  useEffect(() => {
    if (!model) {
      return;
    }
    const first = fitted.current === "";
    const result = fitVideoPick(spec, first ? undefined : pick);
    fitted.current = model;
    setPick(result.pick);
    setNote(first ? null : adjustedNote("videos", model, result.moved));
    // `pick` is read, not watched: the fit runs when the model changes, never on every control move.
  }, [model]);

  useEffect(() => {
    if (!imageToVideo) {
      setStillUrl("");
      setSavedPicture(null);
    }
  }, [imageToVideo]);

  // List-price estimate. Recomputed whenever model, clip length or resolution changes.
  const estimate = useMemo(
    () =>
      videoEstimateView({
        model,
        models,
        seconds: pick.seconds,
        resolution: caps.resolution ? estimateResolution(pick.resolution) : undefined,
      }),
    [model, models, pick.seconds, pick.resolution, caps.resolution],
  );
  const modelOptions = useMemo(() => {
    const hints = mediaPriceHints("videos", models);
    return models.map((item) => ({ ...item, hint: hints[item.id] }));
  }, [models]);
  const noModels = studioPickerEmpty({ listed, loading, keyMissing: !keyReady, models });
  const noModelsTitle = noModels
    ? t("videos.noModels.body", { gateway: gatewayName, settings: t("rail.settings") })
    : undefined;

  function pickTemplate(template: PromptTemplate) {
    setPrompt(template.prompt);
    // A template asks for a ratio and a length; the model's own values decide what it gets.
    const result = fitVideoPick(spec, { ...pick, aspect: template.aspect, seconds: template.seconds });
    setPick(result.pick);
    setNote(adjustedNote("videos", model, result.moved));
    setTemplateId(template.id);
  }

  function changePrompt(next: string) {
    setPrompt(next);
    setTemplateId(null);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || generating || !keyReady || noModels) {
      return;
    }
    setGenerating(true);
    setError(null);
    setMade(null);
    try {
      const response = await apiFetch("/api/v1/videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt.trim(),
          model: model || undefined,
          imageUrl: stillSource(savedPicture, stillUrl, imageToVideo),
          // Only the fields this model has: its spec decides, the host checks again.
          ...videoRequestFields(spec, pick),
        }),
      });
      const data = (await response.json().catch(() => ({}))) as GalleryItem & {
        sent?: VideoSent;
        adjusted?: MediaAdjustment[];
        error?: { message?: string; code?: string; suggestModel?: string };
      };
      if (!response.ok) {
        const rejected = model;
        const suggestion = data.error?.suggestModel;
        if (data.error?.code === "model_not_on_key") {
          setModels((current) => current.filter((item) => item.id !== rejected));
          if (suggestion && suggestion !== rejected) {
            setModel(suggestion);
          }
        }
        const message =
          data.error?.code === "model_not_on_key"
            ? suggestion
              ? t("videos.modelNotOnKey", { model: rejected, suggestion })
              : t("videos.modelNotOnKeyNoAlt", { model: rejected })
            : data.error?.code === "video_clip_rejected"
              ? t("videos.clipRejected")
              : savedPicture && data.error?.code === "not_found"
                ? t("videos.savedPicture.unusable")
                : messageUnlessBlocked(data, () => data.error?.message ?? t("videos.generateError"));
        setError(message);
        return;
      }
      setLanded((count) => count + 1);
      // What the clip was made with, so a value the host had to move is never a surprise.
      setMade(data.sent ? [videoSentNote(data.sent), adjustedNote("videos", data.model ?? model, data.adjusted ?? [])].filter(Boolean).join(" ") : null);
      setPrompt("");
      setStillUrl("");
      setSavedPicture(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("videos.generateError"));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <main
      data-mode="videos"
      className="flex min-h-full w-full flex-col px-6 py-4 text-[var(--text)]"
      data-testid="videos-studio"
    >
      <ModeHeader icon="videos" title={t("videos.title")} outcome={t("videos.expectedInputs")} />

      {error && !isGatewayBlockedText(error) ? (
        <div
          className="mt-4 rounded-xl border border-[var(--line)] px-4 py-3 text-sm text-[var(--danger)]"
          role="alert"
          data-testid="videos-studio-error"
        >
          {error}
        </div>
      ) : null}

      <ExampleGallery mode="videos" onSelect={(entry) => setPrompt(entry.prompt)} />

      <VideoExamples onPick={pickTemplate} selectedId={templateId} />

      <form
        className="mt-6 space-y-3 rounded-xl border border-[var(--line)] bg-transparent p-3"
        onSubmit={onSubmit}
        data-testid="videos-studio-prompt-bar"
      >
        <div className="flex flex-wrap gap-2">
          {model ? (
            <VideoControls spec={spec} pick={pick} onChange={setPick} disabled={generating} />
          ) : null}
          {noModels ? null : (
            <ModelSelect
              models={modelOptions}
              value={model}
              onChange={setModel}
              disabled={generating || models.length === 0}
              testId="videos-studio-model"
              className="select-field min-w-[12rem] flex-1"
            />
          )}
        </div>
        {noModels ? (
          <div className="rounded-lg border border-[var(--line)] px-3 py-2" data-testid="videos-studio-no-models">
            <p className="text-sm font-medium text-[var(--text)]">{t("videos.noModels.title")}</p>
            <p className="mt-1 text-xs text-[var(--text-2)]">
              <SettingsLinkHint i18nKey="videos.noModels.body" vars={{ gateway: gatewayName }} />
            </p>
          </div>
        ) : null}
        {model ? <UnverifiedNote kind="videos" unverified={spec.unverified} /> : null}
        <MediaControlsNote kind="videos" note={note} made={made} />
        {!model || estimate.unknown ? null : (
          <div className="space-y-0.5">
            <p className="text-xs text-[var(--text-2)]" data-testid="videos-studio-estimate">
              {estimate.line}
            </p>
            {estimate.compare ? (
              <p className="text-xs text-[var(--text-3)]" data-testid="videos-studio-estimate-compare">
                {estimate.compare}
              </p>
            ) : null}
          </div>
        )}
        <details className="rounded-lg border border-[var(--line)] px-3 py-2" data-testid="videos-studio-advanced">
          <summary className="cursor-pointer select-none text-xs font-medium text-[var(--text-2)]">
            {t("videos.advanced")}
          </summary>
          <div className="mt-2 space-y-2">
            {imageToVideo ? (
              <div className="space-y-2">
                <input
                  type="text"
                  inputMode="url"
                  className="text-field w-full outline-none placeholder:text-[var(--text-3)]"
                  placeholder={t("videos.stillPlaceholder")}
                  value={stillUrl}
                  onChange={(event) => {
                    setStillUrl(event.target.value);
                    setSavedPicture(null);
                  }}
                  disabled={generating}
                  data-testid="videos-studio-still"
                />
                {savedPicture ? (
                  <div className="flex items-center gap-2" data-testid="videos-studio-saved-chosen">
                    <img
                      src={mediaSrc(savedPicture.url)}
                      alt={savedPicture.prompt || t("videos.savedPicture.optionAlt")}
                      className="h-10 w-10 shrink-0 rounded object-cover"
                    />
                    <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-2)]">
                      {t("videos.savedPicture.chosen")}
                    </span>
                    <button
                      type="button"
                      className="shrink-0 text-xs underline text-[var(--text-2)] disabled:opacity-50"
                      disabled={generating}
                      onClick={() => setSavedPicture(null)}
                      data-testid="videos-studio-saved-remove"
                    >
                      {t("videos.savedPicture.remove")}
                    </button>
                  </div>
                ) : null}
                <SavedPicturePicker
                  disabled={generating}
                  onPick={(picture) => {
                    setSavedPicture(picture);
                    setStillUrl("");
                  }}
                />
              </div>
            ) : model ? (
              <p className="text-xs text-[var(--text-3)]">{t("videos.textToVideoOnly")}</p>
            ) : null}
          </div>
        </details>
        <div className={PROMPT_ROW}>
          <EnhancePromptButton
            text={prompt}
            surface="videos"
            model={model}
            disabled={generating}
            testId="videos-enhance"
            onApply={setPrompt}
          />
          <input
            type="text"
            className={PROMPT_INPUT}
            placeholder={t("videos.promptPlaceholder")}
            value={prompt}
            onChange={(event) => changePrompt(event.target.value)}
            disabled={generating}
            data-testid="videos-studio-prompt"
          />
          {generating ? <MascotSlot mode="videos" placement="beside" busy decorative /> : null}
          <button
            type="submit"
            className={`${PROMPT_SUBMIT} ${
              keyReady
                ? "btn btn-primary h-8 shrink-0 rounded-pill px-4"
                : "inline-flex h-8 shrink-0 items-center justify-center rounded-pill bg-[var(--line)] px-4 text-sm text-[var(--text-3)]"
            }`}
            disabled={generating || !keyReady || !prompt.trim() || noModels}
            title={
              keyReady ? noModelsTitle : t("videos.needsKey", { gateway: gatewayName, settings: t("rail.settings") })
            }
            data-testid="videos-studio-submit"
          >
            {generating ? <WorkingStatus label={t("videos.generating")} /> : t("videos.generate")}
          </button>
          {keyMissing || (!ready && !loading) ? (
            <p className="basis-full text-xs text-[var(--text-3)]" data-testid="videos-studio-needs-key">
              <SettingsLinkHint i18nKey="videos.needsKey" vars={{ gateway: gatewayName }} />
            </p>
          ) : null}
        </div>
        <EditPromptTemplates onPick={pickTemplate} selectedId={templateId} />
      </form>

      <section className="relative mt-8" data-testid="videos-studio-gallery">
        {landed > 0 ? <Confetti key={landed} /> : null}
        {loading ? (
          <p className="text-sm text-[var(--text-3)]">{t("videos.loadingGallery")}</p>
        ) : items.length === 0 ? (
          generating ? null : (
            <StudioEmptyDesk mode="videos" flush />
          )
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 min-[1600px]:grid-cols-3 min-[2400px]:grid-cols-4">
            {items.map((item, index) => (
              <li
                key={item.id}
                className="card-live enter-rise overflow-hidden"
                style={{ "--i": index } as CSSProperties}
              >
                <GalleryVideo src={mediaSrc(item.url)} missing={item.fileMissing === true} index={index} />
                <div className="flex items-center justify-between gap-2 px-3 py-2">
                  {item.prompt ? (
                    <p className="min-w-0 truncate text-xs text-[var(--text-2)]">{item.prompt}</p>
                  ) : (
                    <span />
                  )}
                  {item.fileMissing ? null : (
                    <a
                      href={mediaSrc(item.url)}
                      download={`agentforge-video-${item.id}.mp4`}
                      className="shrink-0 text-xs underline text-[var(--text-2)]"
                      data-testid="videos-studio-download"
                    >
                      {t("videos.download")}
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
