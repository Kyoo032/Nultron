"use client";

import {
  imageShapeOptions,
  videoLengthOptions,
  type ImageParamSpec,
  type VideoParamSpec,
} from "@agentforge/core/media-params";
import { UiSelect, type UiSelectVariant } from "@/components/ui-select";
import { t } from "@/lib/i18n";
import type { ImagePick, VideoPick } from "@/lib/media-options";

/**
 * The media controls a model has, and only those.
 *
 * Each control is drawn from the model's media parameter spec (`@agentforge/core/media-params`): the
 * control exists only when the model reads that field, and lists only the values the model takes. A
 * control with one value is not a choice, so it is not drawn. Same drawing for the Videos studio, the
 * Images studio and Edit's Generate tab; `testIdPrefix` keeps each one's existing test ids.
 */

/** The spec's lengths, plus the current pick when a template asked for a length the thinned list skips. */
function lengthChoices(spec: VideoParamSpec, current: number): number[] {
  const options = videoLengthOptions(spec);
  return options.includes(current) ? options : [...options, current].sort((a, b) => a - b);
}

type VideoControlsProps = {
  spec: VideoParamSpec;
  pick: VideoPick;
  onChange: (next: VideoPick) => void;
  disabled?: boolean;
  testIdPrefix?: string;
  /** Optional classes applied to each select wrapper. Edit's narrow rail passes its own. */
  selectClassName?: string;
  /** Edit keeps the project's frame, so it leaves the ratio menu out. */
  showAspect?: boolean;
  variant?: UiSelectVariant;
};

function cleanWrapperClass(raw?: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  const cleaned = raw
    .split(/\s+/)
    .filter((token) => token && token !== "select-field")
    .join(" ");
  return cleaned || undefined;
}

export function VideoControls({
  spec,
  pick,
  onChange,
  disabled,
  testIdPrefix = "videos-studio",
  selectClassName,
  showAspect = true,
  variant = "pill",
}: VideoControlsProps) {
  const lengths = lengthChoices(spec, pick.seconds);
  const aspects = spec.aspect?.values ?? [];
  const resolutions = spec.resolution?.values ?? [];
  const wrapperClass = cleanWrapperClass(selectClassName);

  return (
    <>
      {showAspect && aspects.length > 1 ? (
        <UiSelect
          variant={variant}
          className={wrapperClass}
          prefix={t("videos.aspectLabel")}
          ariaLabel={t("videos.aspectLabel")}
          testId={`${testIdPrefix}-aspect`}
          value={pick.aspect}
          disabled={disabled}
          onChange={(aspect) => onChange({ ...pick, aspect })}
          options={aspects.map((value) => ({ value, label: value }))}
          minPanelWidth={160}
        />
      ) : null}
      {lengths.length > 1 ? (
        <UiSelect
          variant={variant}
          className={wrapperClass}
          prefix={t("videos.lengthLabel")}
          ariaLabel={t("videos.lengthLabel")}
          testId={`${testIdPrefix}-seconds`}
          value={String(pick.seconds)}
          disabled={disabled}
          onChange={(next) => onChange({ ...pick, seconds: Number(next) })}
          options={lengths.map((value) => ({ value: String(value), label: t("videos.seconds", { n: value }) }))}
          minPanelWidth={150}
        />
      ) : null}
      {resolutions.length > 1 ? (
        <UiSelect
          variant={variant}
          className={wrapperClass}
          prefix={t("videos.resolutionLabel")}
          ariaLabel={t("videos.resolutionLabel")}
          testId={`${testIdPrefix}-resolution`}
          value={pick.resolution}
          disabled={disabled}
          onChange={(resolution) => onChange({ ...pick, resolution })}
          options={resolutions.map((value) => ({ value, label: value }))}
          minPanelWidth={150}
        />
      ) : null}
      {spec.audio.supported ? (
        <button
          type="button"
          role="switch"
          aria-checked={pick.audio}
          disabled={disabled}
          title={t("videos.audioHint")}
          data-testid={`${testIdPrefix}-audio`}
          onClick={() => onChange({ ...pick, audio: !pick.audio })}
          className={`studio-pill-toggle ${pick.audio ? "studio-pill-toggle-active" : ""}`}
        >
          <span className="studio-pill-dot" aria-hidden="true" />
          <span data-testid={`${testIdPrefix}-audio-label`}>{t("videos.audio")}</span>
        </button>
      ) : null}
    </>
  );
}

/** A value's words where the catalog has them (`low`, `medium`), else the value as the model spells it. */
function optionWords(key: string, value: string): string {
  const words = t(key);
  return words === key ? value : words;
}

type ImageControlsProps = {
  spec: ImageParamSpec;
  pick: ImagePick;
  /** The shape value the select shows: the person's pick, or what the sentence asks for. */
  shape: string;
  onChange: (next: ImagePick) => void;
  disabled?: boolean;
  testIdPrefix?: string;
  selectClassName?: string;
  /** Edit keeps the project's frame, so it leaves the size menu out. */
  showShape?: boolean;
  variant?: UiSelectVariant;
};

export function ImageControls({
  spec,
  pick,
  shape,
  onChange,
  disabled,
  testIdPrefix = "images-studio",
  selectClassName,
  showShape = true,
  variant = "pill",
}: ImageControlsProps) {
  const shapes = imageShapeOptions(spec);
  const tiers = spec.tier?.values ?? [];
  const qualities = spec.quality?.values ?? [];
  const formats = spec.outputFormat?.values ?? [];
  const countMax = spec.count?.max ?? 1;
  const wrapperClass = cleanWrapperClass(selectClassName);

  return (
    <>
      {showShape && shapes.length > 1 ? (
        <UiSelect
          variant={variant}
          className={wrapperClass}
          prefix={t("images.shapeLabel")}
          ariaLabel={t("images.shapeLabel")}
          testId={`${testIdPrefix}-aspect`}
          value={shape}
          disabled={disabled}
          onChange={(next) => onChange({ ...pick, shape: next, shapeTouched: true })}
          options={shapes.map((option) => ({ value: option.value, label: option.label }))}
          minPanelWidth={200}
        />
      ) : null}
      {tiers.length > 1 ? (
        <UiSelect
          variant={variant}
          className={wrapperClass}
          prefix={t("images.tierLabel")}
          ariaLabel={t("images.tierLabel")}
          testId={`${testIdPrefix}-tier`}
          value={pick.tier}
          disabled={disabled}
          onChange={(tier) => onChange({ ...pick, tier })}
          options={tiers.map((value) => ({ value, label: value.toUpperCase() }))}
          minPanelWidth={150}
        />
      ) : null}
      {qualities.length > 1 ? (
        <UiSelect
          variant={variant}
          className={wrapperClass}
          prefix={t("images.qualityLabel")}
          ariaLabel={t("images.qualityLabel")}
          testId={`${testIdPrefix}-quality`}
          value={pick.quality}
          disabled={disabled}
          onChange={(quality) => onChange({ ...pick, quality })}
          options={qualities.map((value) => ({
            value,
            label: optionWords(`images.quality.option.${value}`, value),
          }))}
          minPanelWidth={160}
        />
      ) : null}
      {countMax > 1 ? (
        <UiSelect
          variant={variant}
          className={wrapperClass}
          prefix={t("images.countLabel")}
          ariaLabel={t("images.countLabel")}
          testId={`${testIdPrefix}-count`}
          value={String(pick.count)}
          disabled={disabled}
          onChange={(next) => onChange({ ...pick, count: Number(next) })}
          options={Array.from({ length: countMax }, (_, index) => {
            const val = String(index + 1);
            return { value: val, label: val };
          })}
          minPanelWidth={140}
        />
      ) : null}
      {formats.length > 1 ? (
        <UiSelect
          variant={variant}
          className={wrapperClass}
          prefix={t("images.formatLabel")}
          ariaLabel={t("images.formatLabel")}
          testId={`${testIdPrefix}-format`}
          value={pick.format}
          disabled={disabled}
          onChange={(format) => onChange({ ...pick, format })}
          options={formats.map((value) => ({ value, label: value.toUpperCase() }))}
          minPanelWidth={150}
        />
      ) : null}
    </>
  );
}

/** One quiet line when a model's spec holds values nobody published. Nothing for a fully published model. */
export function UnverifiedNote({ kind, unverified }: { kind: "videos" | "images"; unverified: readonly string[] }) {
  if (unverified.length === 0) {
    return null;
  }
  return (
    <p className="text-xs text-[var(--text-3)]" data-testid={`${kind}-studio-unverified`}>
      {t(`${kind}.unverified`)}
    </p>
  );
}
