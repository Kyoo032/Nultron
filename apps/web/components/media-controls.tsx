"use client";

import {
  imageShapeOptions,
  videoLengthOptions,
  type ImageParamSpec,
  type VideoParamSpec,
} from "@agentforge/core/media-params";
import { t } from "@/lib/i18n";
import type { ImagePick, VideoPick } from "@/lib/media-options";

/**
 * The media controls a model has, and only those.
 *
 * Each control is drawn from the model's media parameter spec (`@agentforge/core/media-params`): the
 * select exists only when the model reads that field, and lists only the values the model takes. A
 * control with one value is not a choice, so it is not drawn. Same drawing for the Videos studio, the
 * Images studio and Edit's Generate tab; `testIdPrefix` keeps each one's existing test ids.
 */

const SELECT = "select-field";

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
  /** The select's classes. Edit's narrow rail passes its own. */
  selectClassName?: string;
  /** Edit keeps the project's frame, so it leaves the ratio menu out. */
  showAspect?: boolean;
};

export function VideoControls({
  spec,
  pick,
  onChange,
  disabled,
  testIdPrefix = "videos-studio",
  selectClassName = SELECT,
  showAspect = true,
}: VideoControlsProps) {
  const lengths = lengthChoices(spec, pick.seconds);
  const aspects = spec.aspect?.values ?? [];
  const resolutions = spec.resolution?.values ?? [];
  return (
    <>
      {showAspect && aspects.length > 1 ? (
        <select
          className={selectClassName}
          value={pick.aspect}
          onChange={(event) => onChange({ ...pick, aspect: event.target.value })}
          disabled={disabled}
          aria-label={t("videos.aspectLabel")}
          data-testid={`${testIdPrefix}-aspect`}
        >
          {aspects.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      ) : null}
      {lengths.length > 1 ? (
        <select
          className={selectClassName}
          value={pick.seconds}
          onChange={(event) => onChange({ ...pick, seconds: Number(event.target.value) })}
          disabled={disabled}
          aria-label={t("videos.lengthLabel")}
          data-testid={`${testIdPrefix}-seconds`}
        >
          {lengths.map((value) => (
            <option key={value} value={value}>
              {t("videos.seconds", { n: value })}
            </option>
          ))}
        </select>
      ) : null}
      {resolutions.length > 1 ? (
        <select
          className={selectClassName}
          value={pick.resolution}
          onChange={(event) => onChange({ ...pick, resolution: event.target.value })}
          disabled={disabled}
          aria-label={t("videos.resolutionLabel")}
          data-testid={`${testIdPrefix}-resolution`}
        >
          {resolutions.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      ) : null}
      {spec.audio.supported ? (
        <label
          className="inline-flex items-center gap-2 text-sm text-[var(--text-2)]"
          title={t("videos.audioHint")}
          data-testid={`${testIdPrefix}-audio-label`}
        >
          <input
            type="checkbox"
            checked={pick.audio}
            onChange={(event) => onChange({ ...pick, audio: event.target.checked })}
            disabled={disabled}
            data-testid={`${testIdPrefix}-audio`}
          />
          {t("videos.audio")}
        </label>
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
};

export function ImageControls({
  spec,
  pick,
  shape,
  onChange,
  disabled,
  testIdPrefix = "images-studio",
  selectClassName = SELECT,
  showShape = true,
}: ImageControlsProps) {
  const shapes = imageShapeOptions(spec);
  const tiers = spec.tier?.values ?? [];
  const qualities = spec.quality?.values ?? [];
  const formats = spec.outputFormat?.values ?? [];
  const countMax = spec.count?.max ?? 1;
  return (
    <>
      {showShape && shapes.length > 1 ? (
        <select
          className={selectClassName}
          value={shape}
          onChange={(event) => onChange({ ...pick, shape: event.target.value, shapeTouched: true })}
          disabled={disabled}
          aria-label={t("images.shapeLabel")}
          data-testid={`${testIdPrefix}-aspect`}
        >
          {shapes.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : null}
      {tiers.length > 1 ? (
        <select
          className={selectClassName}
          value={pick.tier}
          onChange={(event) => onChange({ ...pick, tier: event.target.value })}
          disabled={disabled}
          aria-label={t("images.tierLabel")}
          data-testid={`${testIdPrefix}-tier`}
        >
          {tiers.map((value) => (
            <option key={value} value={value}>
              {value.toUpperCase()}
            </option>
          ))}
        </select>
      ) : null}
      {qualities.length > 1 ? (
        <select
          className={selectClassName}
          value={pick.quality}
          onChange={(event) => onChange({ ...pick, quality: event.target.value })}
          disabled={disabled}
          aria-label={t("images.qualityLabel")}
          data-testid={`${testIdPrefix}-quality`}
        >
          {qualities.map((value) => (
            <option key={value} value={value}>
              {optionWords(`images.quality.option.${value}`, value)}
            </option>
          ))}
        </select>
      ) : null}
      {countMax > 1 ? (
        <select
          className={selectClassName}
          value={pick.count}
          onChange={(event) => onChange({ ...pick, count: Number(event.target.value) })}
          disabled={disabled}
          aria-label={t("images.countLabel")}
          data-testid={`${testIdPrefix}-count`}
        >
          {Array.from({ length: countMax }, (_, index) => index + 1).map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      ) : null}
      {formats.length > 1 ? (
        <select
          className={selectClassName}
          value={pick.format}
          onChange={(event) => onChange({ ...pick, format: event.target.value })}
          disabled={disabled}
          aria-label={t("images.formatLabel")}
          data-testid={`${testIdPrefix}-format`}
        >
          {formats.map((value) => (
            <option key={value} value={value}>
              {value.toUpperCase()}
            </option>
          ))}
        </select>
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
