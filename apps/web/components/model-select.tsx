"use client";

import { pickerGroups } from "@agentforge/core/preferred";
import { UiSelect, type UiSelectGroup, type UiSelectOption, type UiSelectVariant } from "@/components/ui-select";
import { embeddingsGroupLabel, pickerGroupLabel } from "@/lib/picker-group-label";

export type ChatModel = {
  id: string;
  label: string;
  provider?: string;
  inputModalities: string[];
  contextLength?: number;
  /** Optional curation metadata (friendly label / best-for hint). */
  friendlyLabel?: string;
  bestFor?: string;
  tier?: "everyday" | "advanced";
  /** Optional trailing tag for the option label, e.g. a list price ("$0.03/img"). */
  hint?: string;
};

type Props = {
  models: ChatModel[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  testId?: string;
  showModalities?: boolean;
  className?: string;
  /** Skip chat hide-lists so embedding ids stay visible. */
  flat?: boolean;
  variant?: UiSelectVariant;
  prefix?: string;
  ariaLabel?: string;
};

function toOption(model: ChatModel, showModalities: boolean): UiSelectOption {
  const name = model.friendlyLabel ?? model.label;
  const parts: string[] = [];
  if (model.bestFor) {
    parts.push(model.bestFor);
  }
  if (showModalities && model.inputModalities.length > 0) {
    parts.push(model.inputModalities.join(" + "));
  }
  return {
    value: model.id,
    label: name,
    description: parts.length > 0 ? parts.join(" · ") : undefined,
    badge: model.hint,
  };
}

/** Build the grouped option list for `<ModelSelect>`. Exported so unit tests can inspect groups cleanly. */
export function modelSelectGroups(
  models: ChatModel[],
  value: string,
  options?: { showModalities?: boolean; flat?: boolean },
): { selected: string; groups: UiSelectGroup[] } {
  const showModalities = options?.showModalities ?? false;
  const flat = options?.flat ?? false;
  const selected = models.some((model) => model.id === value) ? value : (models[0]?.id ?? "");

  // The group words are translated here, in the renderer; core sends a stable kind (`pickerGroups`).
  const rawGroups = flat
    ? [{ key: "embeddings", label: embeddingsGroupLabel(), models }]
    : pickerGroups(models, selected).map((group) => ({
        key: group.label,
        label: pickerGroupLabel(group),
        models: group.models,
      }));

  return {
    selected,
    groups: rawGroups.map((group) => ({
      key: group.key,
      label: group.label,
      options: group.models.map((model) => toOption(model, showModalities)),
    })),
  };
}

export function ModelSelect({
  models,
  value,
  onChange,
  disabled,
  testId = "model-picker",
  showModalities = false,
  className,
  flat = false,
  variant,
  prefix,
  ariaLabel,
}: Props) {
  const { selected, groups } = modelSelectGroups(models, value, { showModalities, flat });
  const resolvedVariant: UiSelectVariant = variant ?? (className?.includes("w-full") ? "field" : "pill");
  // Drop the legacy native-select class so the custom trigger owns its height & padding.
  const rootClass = className
    ? className
        .split(/\s+/)
        .filter((token) => token && token !== "select-field")
        .join(" ")
    : undefined;

  return (
    <UiSelect
      groups={groups}
      value={selected}
      onChange={onChange}
      variant={resolvedVariant}
      prefix={prefix}
      disabled={disabled || models.length === 0}
      testId={testId}
      ariaLabel={ariaLabel}
      className={rootClass || undefined}
      triggerClassName={resolvedVariant === "pill" ? "max-w-[16rem]" : undefined}
      minPanelWidth={280}
    />
  );
}
