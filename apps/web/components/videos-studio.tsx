"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import type { PromptTemplate } from "@agentforge/core/edit";
import type { MediaAdjustment, MediaParamSpec, VideoSent } from "@agentforge/core/media-params";
import type { MediaPrice } from "@agentforge/core/media-pricing";
import { videoCapabilitiesOf } from "@agentforge/core/video-capabilities";
import { Confetti } from "@/components/confetti";
import { EditPromptTemplates } from "@/components/edit-prompt-templates";
import { EnhancePromptButton } from "@/components/enhance-prompt-button";
import { GalleryVideo } from "@/components/gallery-media";
import { MascotSlot } from "@/components/mascot-slot";
import { UnverifiedNote, VideoControls } from "@/components/media-controls";
import { MediaControlsNote } from "@/components/media-controls-note";
import { ModeIcon } from "@/components/mode-icons";
import { ModelSelect } from "@/components/model-select";
import { SavedPicturePicker } from "@/components/saved-picture-picker";
import { SettingsLinkHint } from "@/components/settings-link-hint";
import { StudioEmptyDesk } from "@/components/studio-empty-desk";
import { VideoExamples } from "@/components/video-examples";
import { WorkingStatus } from "@/components/working-status";
import { apiFetch, mediaSrc } from "@/lib/api-client";
import { isGatewayBlockedText, messageUnlessBlocked } from "@/lib/gateway-blocked";
import { t } from "@/lib/i18n";
import { useLocale } from "@/lib/locale-context";
import { mediaPriceHints, videoEstimateView } from "@/lib/media-estimate";
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
import { useCatalogVersion } from "@/lib/catalog-version";
import { useProductBrand } from "@/lib/product-brand";
import { stillSource, type SavedPicture } from "@/lib/saved-picture";
import { studioPickerEmpty } from "@/lib/studio-picker-empty";
import { localizedLibrary } from "@/lib/ui-copy";
import { useHostedNeedsKey } from "@/lib/use-desk-needs-key";
import "@/components/studio-minimal.css";

type StudioModel = {
  id: string;
  label: string;
  provider?: string;
  inputModalities: string[];
  contextLength?: number;
  price?: MediaPrice | null;
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
  const [pick, setPick] = useState<VideoPick>({ aspect: "16:9", seconds: 5, resolution: "720p", audio: false });
  const [note, setNote] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const fitted = useRef("");
  const [prompt, setPrompt] = useState("");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [stillUrl, setStillUrl] = useState("");
  const [savedPicture, setSavedPicture] = useState<SavedPicture | null>(null);
  const [showReference, setShowReference] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [ready, setReady] = useState(true);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [landed, setLanded] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const locale = useLocale();
  const starters = useMemo(() => localizedLibrary("videos", locale), [locale]);
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
  }, [model]);

  useEffect(() => {
    if (!imageToVideo) {
      setStillUrl("");
      setSavedPicture(null);
    }
  }, [imageToVideo]);

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
    const result = fitVideoPick(spec, { ...pick, aspect: template.aspect, seconds: template.seconds });
    setPick(result.pick);
    setNote(adjustedNote("videos", model, result.moved));
    setTemplateId(template.id);
    setShowTemplates(false);
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
      setMade(
        data.sent
          ? [videoSentNote(data.sent), adjustedNote("videos", data.model ?? model, data.adjusted ?? [])]
              .filter(Boolean)
              .join(" ")
          : null,
      );
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

  const hasReference = Boolean(savedPicture || stillUrl.trim());
  const hasNotes = Boolean(
    noModels || (model && spec.unverified.length > 0) || note || made || keyMissing || (!ready && !loading),
  );

  return (
    <main data-mode="videos" className="studio-shell" data-testid="videos-studio">
      <header className="studio-head">
        <div className="studio-head-main">
          <span className="studio-head-icon" aria-hidden="true">
            <ModeIcon name="videos" size={18} strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <h1 className="studio-head-title">{t("videos.title")}</h1>
            <p className="studio-head-sub">{t("videos.expectedInputs")}</p>
          </div>
        </div>
        <button
          type="button"
          className={`studio-pill-toggle ${showTemplates ? "studio-pill-toggle-active" : ""}`}
          aria-expanded={showTemplates}
          data-testid="videos-studio-templates-toggle"
          onClick={() => setShowTemplates((open) => !open)}
        >
          <span>{t("videos.templatesToggle")}</span>
        </button>
      </header>

      {error && !isGatewayBlockedText(error) ? (
        <div
          className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--danger)]"
          role="alert"
          data-testid="videos-studio-error"
        >
          {error}
        </div>
      ) : null}

      <form className="studio-composer" onSubmit={onSubmit} data-testid="videos-studio-prompt-bar">
        <div className="studio-composer-top">
          <input
            type="text"
            className="studio-composer-input"
            placeholder={t("videos.promptPlaceholder")}
            value={prompt}
            onChange={(event) => changePrompt(event.target.value)}
            disabled={generating}
            data-testid="videos-studio-prompt"
          />
          <EnhancePromptButton
            text={prompt}
            surface="videos"
            disabled={generating}
            testId="videos-enhance"
            onApply={setPrompt}
          />
          {generating ? <MascotSlot mode="videos" placement="beside" busy decorative /> : null}
          <button
            type="submit"
            className={
              keyReady
                ? "btn btn-primary h-9 shrink-0 rounded-pill px-4"
                : "inline-flex h-9 shrink-0 items-center justify-center rounded-pill bg-[var(--line)] px-4 text-sm text-[var(--text-3)]"
            }
            disabled={generating || !keyReady || !prompt.trim() || noModels}
            title={
              keyReady ? noModelsTitle : t("videos.needsKey", { gateway: gatewayName, settings: t("rail.settings") })
            }
            data-testid="videos-studio-submit"
          >
            {generating ? <WorkingStatus label={t("videos.generating")} /> : t("videos.generate")}
          </button>
        </div>

        <div className="studio-composer-bar">
          {noModels ? null : (
            <ModelSelect
              models={modelOptions}
              value={model}
              onChange={setModel}
              disabled={generating || models.length === 0}
              testId="videos-studio-model"
              variant="pill"
              prefix={t("videos.modelLabel")}
              ariaLabel={t("videos.modelLabel")}
            />
          )}
          {model ? <VideoControls spec={spec} pick={pick} onChange={setPick} disabled={generating} variant="pill" /> : null}
          <button
            type="button"
            className={`studio-pill-toggle ${showReference || hasReference ? "studio-pill-toggle-active" : ""}`}
            aria-expanded={showReference}
            disabled={generating}
            data-testid="videos-studio-reference-toggle"
            onClick={() => setShowReference((open) => !open)}
          >
            <span className="studio-pill-dot" aria-hidden="true" />
            <span>{t("videos.referenceImage")}</span>
          </button>
          {!model || estimate.unknown ? null : (
            <span
              className="studio-cost-pill"
              title={estimate.compare ?? undefined}
              data-testid="videos-studio-estimate"
            >
              <span>{estimate.line}</span>
              {estimate.compare ? (
                <span className="studio-cost-compare hidden md:inline" data-testid="videos-studio-estimate-compare">
                  · {estimate.compare}
                </span>
              ) : null}
            </span>
          )}
        </div>

        {showReference ? (
          <div className="studio-composer-notes" data-testid="videos-studio-advanced">
            {imageToVideo ? (
              <div className="space-y-2.5">
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
                      className="h-10 w-10 shrink-0 rounded-lg object-cover"
                    />
                    <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-2)]">
                      {t("videos.savedPicture.chosen")}
                    </span>
                    <button
                      type="button"
                      className="shrink-0 text-xs text-[var(--text-2)] underline disabled:opacity-50"
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
        ) : null}

        {hasNotes ? (
          <div className="studio-composer-notes">
            {noModels ? (
              <div data-testid="videos-studio-no-models">
                <p className="text-xs font-medium text-[var(--text)]">{t("videos.noModels.title")}</p>
                <p className="mt-0.5 text-xs text-[var(--text-2)]">
                  <SettingsLinkHint i18nKey="videos.noModels.body" vars={{ gateway: gatewayName }} />
                </p>
              </div>
            ) : null}
            {model ? <UnverifiedNote kind="videos" unverified={spec.unverified} /> : null}
            <MediaControlsNote kind="videos" note={note} made={made} />
            {keyMissing || (!ready && !loading) ? (
              <p className="text-xs text-[var(--text-3)]" data-testid="videos-studio-needs-key">
                <SettingsLinkHint i18nKey="videos.needsKey" vars={{ gateway: gatewayName }} />
              </p>
            ) : null}
          </div>
        ) : null}
      </form>

      {showTemplates ? (
        <section className="studio-drawer" data-testid="videos-studio-templates-drawer">
          <div className="studio-drawer-head">
            <h2 className="studio-drawer-title">{t("videos.templatesToggle")}</h2>
            <button
              type="button"
              className="text-xs text-[var(--text-3)] underline underline-offset-2 hover:text-[var(--text)]"
              onClick={() => setShowTemplates(false)}
            >
              {t("videos.templatesClose")}
            </button>
          </div>
          {starters.length > 0 ? (
            <div className="studio-chips-row" data-testid="example-gallery">
              {starters.map((entry) => (
                <button
                  key={entry.exampleId}
                  type="button"
                  className="studio-chip"
                  data-testid="example-card"
                  data-example-id={entry.exampleId}
                  title={entry.resultSummary}
                  onClick={() => {
                    changePrompt(entry.prompt);
                    setShowTemplates(false);
                  }}
                >
                  {entry.title}
                </button>
              ))}
            </div>
          ) : null}
          <EditPromptTemplates onPick={pickTemplate} selectedId={templateId} />
          <VideoExamples onPick={pickTemplate} selectedId={templateId} />
        </section>
      ) : null}

      <section className="relative pt-2" data-testid="videos-studio-gallery">
        {landed > 0 ? <Confetti key={landed} /> : null}
        {loading ? (
          <p className="text-sm text-[var(--text-3)]">{t("videos.loadingGallery")}</p>
        ) : items.length === 0 ? (
          generating ? null : (
            <StudioEmptyDesk mode="videos" flush />
          )
        ) : (
          <ul className="studio-gallery-grid">
            {items.map((item, index) => (
              <li
                key={item.id}
                className="studio-gallery-card enter-rise"
                style={{ "--i": index } as CSSProperties}
              >
                <GalleryVideo src={mediaSrc(item.url)} missing={item.fileMissing === true} index={index} />
                <div className="flex items-center justify-between gap-2 px-3 py-2.5">
                  {item.prompt ? (
                    <p className="min-w-0 truncate text-xs text-[var(--text-2)]">{item.prompt}</p>
                  ) : (
                    <span />
                  )}
                  {item.fileMissing ? null : (
                    <a
                      href={mediaSrc(item.url)}
                      download={`agentforge-video-${item.id}.mp4`}
                      className="shrink-0 text-xs text-[var(--text-2)] underline underline-offset-2 hover:text-[var(--text)]"
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
