"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { chooseImageFrame } from "@agentforge/core/images";
import type { MediaPrice } from "@agentforge/core/media-pricing";
import type { ImageSent, MediaAdjustment, MediaParamSpec } from "@agentforge/core/media-params";
import { Confetti } from "@/components/confetti";
import { EnhancePromptButton } from "@/components/enhance-prompt-button";
import { GalleryImage } from "@/components/gallery-media";
import { MascotSlot } from "@/components/mascot-slot";
import { ImageControls, UnverifiedNote } from "@/components/media-controls";
import { MediaControlsNote } from "@/components/media-controls-note";
import { ModeIcon } from "@/components/mode-icons";
import { ModelSelect } from "@/components/model-select";
import { SettingsLinkHint } from "@/components/settings-link-hint";
import { StudioEmptyDesk } from "@/components/studio-empty-desk";
import { WorkingStatus } from "@/components/working-status";
import { apiFetch, mediaSrc } from "@/lib/api-client";
import { isGatewayBlockedText, messageUnlessBlocked } from "@/lib/gateway-blocked";
import { t } from "@/lib/i18n";
import { imageEstimateView, mediaPriceHints } from "@/lib/media-estimate";
import {
  adjustedNote,
  effectiveShape,
  fitImagePick,
  imageRequestFields,
  imageSentNote,
  imageSpecOf,
  shapeOfValue,
  type ImagePick,
} from "@/lib/media-options";
import { keepModelChoice } from "@/lib/model-choice";
import { useProductBrand } from "@/lib/product-brand";
import { studioPickerEmpty } from "@/lib/studio-picker-empty";
import { localizedLibrary } from "@/lib/ui-copy";
import { useDeskNeedsKey } from "@/lib/use-desk-needs-key";
import "@/components/studio-minimal.css";

type StudioModel = {
  id: string;
  label: string;
  provider?: string;
  inputModalities: string[];
  contextLength?: number;
  /** Provider list price for the cost estimate; null when nobody has transcribed one. */
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
  /** The host's word that the file is gone from the store: the row lists, the picture does not load. */
  fileMissing?: boolean;
};

type GalleryResponse = {
  items: GalleryItem[];
  models: StudioModel[];
  defaultModel: string;
};

export function ImagesStudio() {
  const { gatewayName } = useProductBrand();
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [models, setModels] = useState<StudioModel[]>([]);
  const [listed, setListed] = useState(false);
  const [model, setModel] = useState("");
  const [pick, setPick] = useState<ImagePick>({
    shape: "",
    shapeTouched: false,
    quality: "",
    tier: "",
    count: 1,
    format: "",
  });
  const [note, setNote] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const fitted = useRef("");
  const [prompt, setPrompt] = useState("");
  const [selectedExampleId, setSelectedExampleId] = useState<string | null>(null);
  const needsKey = useDeskNeedsKey();
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [landed, setLanded] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const starters = useMemo(() => localizedLibrary("images"), []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch("/api/v1/images");
      const data = (await response.json().catch(() => ({}))) as GalleryResponse & {
        error?: { message?: string };
      };
      if (!response.ok) {
        setError(data.error?.message ?? t("images.loadError"));
        return;
      }
      setItems(data.items ?? []);
      setModels(data.models ?? []);
      setListed(true);
      setModel((current) => keepModelChoice(current, data.models ?? [], data.defaultModel));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("images.loadError"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const promptShape = chooseImageFrame(prompt);
  const spec = useMemo(() => imageSpecOf(model, models), [model, models]);
  const shape = effectiveShape(spec, pick, promptShape);
  const aspect = shapeOfValue(spec, shape);
  const quality =
    pick.quality === "low" || pick.quality === "medium" || pick.quality === "high" ? pick.quality : undefined;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the fit runs when the model changes; the picks and the sentence are read, not watched
  useEffect(() => {
    if (!model) {
      return;
    }
    const first = fitted.current === "";
    const result = fitImagePick(spec, first ? undefined : pick, promptShape);
    fitted.current = model;
    setPick(result.pick);
    setNote(first ? null : adjustedNote("images", model, result.moved));
  }, [model]);

  const estimate = useMemo(
    () => imageEstimateView({ model, models, aspect, quality }),
    [model, models, aspect, quality],
  );
  const modelOptions = useMemo(() => {
    const hints = mediaPriceHints("images", models);
    return models.map((item) => ({ ...item, hint: hints[item.id] }));
  }, [models]);
  const noModels = studioPickerEmpty({ listed, loading, keyMissing: needsKey, models });
  const noModelsTitle = noModels
    ? t("images.noModels.body", { gateway: gatewayName, settings: t("rail.settings") })
    : undefined;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || generating || needsKey || noModels) {
      return;
    }
    setGenerating(true);
    setError(null);
    setMade(null);
    try {
      const response = await apiFetch("/api/v1/images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt.trim(),
          model: model || undefined,
          ...imageRequestFields(spec, pick, promptShape),
        }),
      });
      const data = (await response.json().catch(() => ({}))) as GalleryItem & {
        sent?: ImageSent;
        adjusted?: MediaAdjustment[];
        error?: { message?: string };
      };
      if (!response.ok) {
        setError(messageUnlessBlocked(data, () => data.error?.message ?? t("images.generateError")));
        return;
      }
      setLanded((count) => count + 1);
      setPrompt("");
      setSelectedExampleId(null);
      setMade(
        data.sent
          ? [imageSentNote(data.sent), adjustedNote("images", data.model ?? model, data.adjusted ?? [])]
              .filter(Boolean)
              .join(" ")
          : null,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("images.generateError"));
    } finally {
      setGenerating(false);
    }
  }

  const showStarters = !prompt.trim() || items.length === 0;
  const hasNotes = Boolean(
    noModels || (model && spec.unverified.length > 0) || note || made || (needsKey && !loading),
  );

  return (
    <main data-mode="images" className="studio-shell" data-testid="images-studio">
      <header className="studio-head">
        <div className="studio-head-main">
          <span className="studio-head-icon" aria-hidden="true">
            <ModeIcon name="images" size={18} strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <h1 className="studio-head-title">{t("images.title")}</h1>
            <p className="studio-head-sub">{t("images.expectedInputs")}</p>
          </div>
        </div>
      </header>

      {error && !isGatewayBlockedText(error) ? (
        <div
          className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--danger)]"
          role="alert"
          data-testid="images-studio-error"
        >
          {error}
        </div>
      ) : null}

      <form className="studio-composer" onSubmit={onSubmit} data-testid="images-studio-prompt-bar">
        <div className="studio-composer-top">
          <input
            type="text"
            className="studio-composer-input"
            placeholder={t("images.promptPlaceholder")}
            value={prompt}
            onChange={(event) => {
              setPrompt(event.target.value);
              setSelectedExampleId(null);
            }}
            disabled={generating}
            data-testid="images-studio-prompt"
          />
          <EnhancePromptButton
            text={prompt}
            surface="images"
            model={model}
            disabled={generating}
            testId="images-enhance"
            onApply={setPrompt}
          />
          {generating ? <MascotSlot mode="images" placement="beside" busy decorative /> : null}
          <button
            type="submit"
            className={
              needsKey
                ? "inline-flex h-9 shrink-0 items-center justify-center rounded-pill bg-[var(--line)] px-4 text-sm text-[var(--text-3)]"
                : "btn btn-primary h-9 shrink-0 rounded-pill px-4"
            }
            disabled={generating || !prompt.trim() || needsKey || noModels}
            title={
              needsKey ? t("images.needsKey", { gateway: gatewayName, settings: t("rail.settings") }) : noModelsTitle
            }
            data-testid="images-studio-submit"
          >
            {generating ? <WorkingStatus label={t("images.generating")} /> : t("images.generate")}
          </button>
        </div>

        <div className="studio-composer-bar">
          {noModels ? null : (
            <ModelSelect
              models={modelOptions}
              value={model}
              onChange={setModel}
              disabled={generating || models.length === 0}
              testId="images-studio-model"
              variant="pill"
              prefix={t("images.modelLabel")}
              ariaLabel={t("images.modelLabel")}
            />
          )}
          {model ? (
            <ImageControls spec={spec} pick={pick} shape={shape} onChange={setPick} disabled={generating} variant="pill" />
          ) : null}
          {!model || estimate.unknown ? null : (
            <span
              className="studio-cost-pill"
              title={estimate.compare ?? undefined}
              data-testid="images-studio-estimate"
            >
              <span>{estimate.line}</span>
              {estimate.compare ? (
                <span className="studio-cost-compare hidden md:inline" data-testid="images-studio-estimate-compare">
                  · {estimate.compare}
                </span>
              ) : null}
            </span>
          )}
        </div>

        {hasNotes ? (
          <div className="studio-composer-notes">
            {noModels ? (
              <div data-testid="images-studio-no-models">
                <p className="text-xs font-medium text-[var(--text)]">{t("images.noModels.title")}</p>
                <p className="mt-0.5 text-xs text-[var(--text-2)]">
                  <SettingsLinkHint i18nKey="images.noModels.body" vars={{ gateway: gatewayName }} />
                </p>
              </div>
            ) : null}
            {model ? <UnverifiedNote kind="images" unverified={spec.unverified} /> : null}
            <MediaControlsNote kind="images" note={note} made={made} />
            {needsKey && !loading ? (
              <p className="text-xs text-[var(--text-3)]" data-testid="images-studio-needs-key">
                <SettingsLinkHint i18nKey="images.needsKey" vars={{ gateway: gatewayName }} />
              </p>
            ) : null}
          </div>
        ) : null}
      </form>

      {showStarters && starters.length > 0 ? (
        <div
          className="studio-chips-row"
          aria-label={t("images.examplesHeading")}
          data-testid="example-gallery"
        >
          {starters.map((entry) => (
            <button
              key={entry.exampleId}
              type="button"
              className="studio-chip"
              data-testid="example-card"
              data-example-id={entry.exampleId}
              aria-pressed={selectedExampleId === entry.exampleId}
              title={entry.resultSummary}
              disabled={generating}
              onClick={() => {
                setSelectedExampleId(entry.exampleId);
                setPrompt(entry.prompt);
              }}
            >
              {entry.title}
            </button>
          ))}
        </div>
      ) : null}

      <section className="relative pt-2" data-testid="images-studio-gallery">
        {landed > 0 ? <Confetti key={landed} /> : null}
        {loading ? (
          <p className="text-sm text-[var(--text-3)]">{t("images.loadingGallery")}</p>
        ) : items.length === 0 ? (
          generating ? null : (
            <StudioEmptyDesk mode="images" flush />
          )
        ) : (
          <ul className="studio-gallery-grid">
            {items.map((item) => (
              <li key={item.id} className="studio-gallery-card">
                <GalleryImage
                  src={mediaSrc(item.url)}
                  alt={item.prompt || t("images.generatedAlt")}
                  missing={item.fileMissing === true}
                />
                {item.prompt ? (
                  <p className="studio-gallery-caption line-clamp-2" title={item.prompt}>
                    {item.prompt}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
