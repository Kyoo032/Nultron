"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { isPanelMounted, type PickerCloseReason } from "@/components/model-picker";
import {
  PICKER_PANEL_GUTTER,
  PICKER_PANEL_WIDTH,
  placePickerPanel,
  viewportBounds,
  type PickerPanelPos,
} from "@/lib/picker-panel";
import "@/components/ui-select.css";

export type UiSelectOption = {
  value: string;
  label: string;
  description?: string;
  badge?: string;
  disabled?: boolean;
};

export type UiSelectGroup = {
  key?: string;
  label: string;
  options: readonly UiSelectOption[];
};

export type UiSelectVariant = "pill" | "field";

export type UiSelectProps = {
  options?: readonly UiSelectOption[];
  groups?: readonly UiSelectGroup[];
  value: string;
  onChange: (value: string) => void;
  variant?: UiSelectVariant;
  /** Optional subtle muted prefix shown inside the trigger before the active value (e.g. "Aspect"). */
  prefix?: string;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  id?: string;
  testId?: string;
  className?: string;
  triggerClassName?: string;
  /** Minimum desired width of the dropdown panel in pixels. */
  minPanelWidth?: number;
};

export type UiSelectKeyAction =
  | Readonly<{ kind: "move"; index: number }>
  | Readonly<{ kind: "select"; index: number }>
  | Readonly<{ kind: "close" }>
  | Readonly<{ kind: "none" }>;

const NONE: UiSelectKeyAction = Object.freeze({ kind: "none" });
const CLOSE: UiSelectKeyAction = Object.freeze({ kind: "close" });

/**
 * Pure keyboard state machine for `<UiSelect>`'s open listbox.
 *
 * Arrows wrap, Home/End jump to ends, Enter/Space chooses the highlighted option unless disabled,
 * and Escape/Tab close the panel.
 */
export function uiSelectKeyAction(
  key: string,
  state: Readonly<{ highlight: number; options: readonly { disabled?: boolean }[] }>,
): UiSelectKeyAction {
  if (key === "Escape" || key === "Tab") {
    return CLOSE;
  }
  const count = state.options.length;
  if (count === 0) {
    return NONE;
  }
  const inRange = state.highlight >= 0 && state.highlight < count;
  switch (key) {
    case "ArrowDown":
      return { kind: "move", index: inRange ? (state.highlight + 1) % count : 0 };
    case "ArrowUp":
      return { kind: "move", index: inRange ? (state.highlight - 1 + count) % count : count - 1 };
    case "Home":
      return { kind: "move", index: 0 };
    case "End":
      return { kind: "move", index: count - 1 };
    case "Enter":
    case " ":
      return inRange && !state.options[state.highlight]?.disabled ? { kind: "select", index: state.highlight } : NONE;
    default:
      return NONE;
  }
}

function optionDomId(listId: string, index: number): string {
  return `${listId}-opt-${index}`;
}

type NormalizedSection = {
  key: string;
  label: string | null;
  items: ReadonlyArray<{ option: UiSelectOption; flatIndex: number }>;
};

export function normalizeSelectSections(
  options?: readonly UiSelectOption[],
  groups?: readonly UiSelectGroup[],
): { sections: NormalizedSection[]; flat: UiSelectOption[] } {
  const flat: UiSelectOption[] = [];
  const sections: NormalizedSection[] = [];

  if (groups && groups.length > 0) {
    groups.forEach((group, groupIndex) => {
      if (group.options.length === 0) {
        return;
      }
      const items = group.options.map((option) => {
        const flatIndex = flat.length;
        flat.push(option);
        return { option, flatIndex };
      });
      sections.push({
        key: group.key ?? `${group.label}-${groupIndex}`,
        label: group.label,
        items,
      });
    });
  } else if (options && options.length > 0) {
    const items = options.map((option) => {
      const flatIndex = flat.length;
      flat.push(option);
      return { option, flatIndex };
    });
    sections.push({ key: "default", label: null, items });
  }

  return { sections, flat };
}

type OptionListProps = {
  listId: string;
  sections: readonly NormalizedSection[];
  flat: readonly UiSelectOption[];
  value: string;
  highlight: number;
  ariaLabel?: string;
  testId?: string;
  onPick: (value: string) => void;
  onHover: (index: number) => void;
  listRef?: Ref<HTMLDivElement>;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
};

/** Exported so unit tests can inspect the listbox markup directly without a DOM portal. */
export function UiSelectOptionList({
  listId,
  sections,
  flat,
  value,
  highlight,
  ariaLabel,
  testId,
  onPick,
  onHover,
  listRef,
  onKeyDown,
}: OptionListProps) {
  const activeValid = highlight >= 0 && highlight < flat.length;

  function renderOption(option: UiSelectOption, flatIndex: number) {
    const selected = option.value === value;
    const disabled = Boolean(option.disabled);
    return (
      <li
        key={`${option.value}-${flatIndex}`}
        id={optionDomId(listId, flatIndex)}
        role="option"
        aria-selected={selected}
        aria-disabled={disabled ? true : undefined}
        data-active={flatIndex === highlight ? "true" : "false"}
        data-value={option.value}
        data-testid={testId ? `${testId}-option-${option.value}` : undefined}
        className="ui-select-option"
        onMouseEnter={() => onHover(flatIndex)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (!disabled) {
            onPick(option.value);
          }
        }}
      >
        <span className="ui-select-check" aria-hidden="true">
          {selected ? "✓" : ""}
        </span>
        <span className="ui-select-option-body">
          <span className="ui-select-option-label">{option.label}</span>
          {option.description ? <span className="ui-select-option-desc">{option.description}</span> : null}
        </span>
        {option.badge ? <span className="ui-select-badge">{option.badge}</span> : null}
      </li>
    );
  }

  return (
    <div
      id={listId}
      ref={listRef}
      role="listbox"
      tabIndex={-1}
      className="ui-select-list"
      aria-label={ariaLabel}
      aria-activedescendant={activeValid ? optionDomId(listId, highlight) : undefined}
      onKeyDown={onKeyDown}
    >
      {sections.map((section, sectionIndex) => {
        if (section.label === null) {
          return (
            <ul key={section.key} className="ui-select-group" role="presentation">
              {section.items.map(({ option, flatIndex }) => renderOption(option, flatIndex))}
            </ul>
          );
        }
        const headingId = `${listId}-group-${sectionIndex}`;
        return (
          <ul key={section.key} className="ui-select-group" role="group" aria-labelledby={headingId}>
            <li id={headingId} role="presentation" className="ui-select-group-label">
              {section.label}
            </li>
            {section.items.map(({ option, flatIndex }) => renderOption(option, flatIndex))}
          </ul>
        );
      })}
    </div>
  );
}

function fitPanelPosition(
  base: PickerPanelPos,
  trigger: DOMRect,
  viewportWidth: number,
  variant: UiSelectVariant,
  minPanelWidth?: number,
): PickerPanelPos {
  const available = Math.max(0, viewportWidth - PICKER_PANEL_GUTTER * 2);
  const desiredWidth =
    variant === "field"
      ? Math.max(trigger.width, minPanelWidth ?? 220)
      : Math.max(trigger.width, Math.min(PICKER_PANEL_WIDTH, minPanelWidth ?? 220));
  const width = Math.min(Math.max(desiredWidth, Math.min(trigger.width, available)), available);
  const maxLeft = Math.max(PICKER_PANEL_GUTTER, viewportWidth - PICKER_PANEL_GUTTER - width);
  const left = Math.min(maxLeft, Math.max(PICKER_PANEL_GUTTER, trigger.left));
  return { ...base, left, width };
}

export function UiSelect({
  options,
  groups,
  value,
  onChange,
  variant = "pill",
  prefix,
  placeholder,
  disabled,
  ariaLabel,
  ariaLabelledBy,
  id,
  testId,
  className,
  triggerClassName,
  minPanelWidth,
}: UiSelectProps) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [pos, setPos] = useState<PickerPanelPos | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { sections, flat } = useMemo(() => normalizeSelectSections(options, groups), [options, groups]);
  const selected = flat.find((opt) => opt.value === value) ?? flat[0] ?? null;
  const blocked = Boolean(disabled) || flat.length === 0;
  const panelMounted = isPanelMounted(open, pos);

  function closePanel(reason: PickerCloseReason) {
    setOpen(false);
    setPos(null);
    if (reason === "escape" || reason === "select") {
      queueMicrotask(() => triggerRef.current?.focus());
    }
  }

  function openPanel() {
    if (blocked) {
      return;
    }
    const activeIndex = flat.findIndex((opt) => opt.value === value);
    setHighlight(activeIndex >= 0 ? activeIndex : 0);
    setOpen(true);
  }

  function choose(nextValue: string) {
    if (nextValue !== value) {
      onChange(nextValue);
    }
    closePanel("select");
  }

  // Close on click outside both the panel and the trigger.
  // biome-ignore lint/correctness/useExhaustiveDependencies: closePanel only updates state and reads refs; listener lifecycle belongs to open
  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) {
        return;
      }
      closePanel("outside");
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  // Portal positioning against the viewport so clipping toolbars never crop the dropdown.
  useEffect(() => {
    if (!open) {
      return;
    }
    function place() {
      const trigger = triggerRef.current;
      if (!trigger) {
        return;
      }
      const rect = trigger.getBoundingClientRect();
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const base = placePickerPanel(rect, viewportBounds(viewport), viewport);
      setPos(fitPanelPosition(base, rect, viewport.width, variant, minPanelWidth));
    }
    place();
    const frame = window.requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, variant, minPanelWidth]);

  useEffect(() => {
    if (panelMounted) {
      listRef.current?.focus();
    }
  }, [panelMounted]);

  function onListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const action = uiSelectKeyAction(event.key, { highlight, options: flat });
    if (action.kind === "none") {
      return;
    }
    event.preventDefault();
    if (action.kind === "move") {
      setHighlight(action.index);
    } else if (action.kind === "select") {
      const picked = flat[action.index];
      if (picked && !picked.disabled) {
        choose(picked.value);
      }
    } else {
      closePanel("escape");
    }
  }

  function onTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      openPanel();
      return;
    }
    if (open && event.key === "Escape") {
      event.preventDefault();
      closePanel("escape");
    }
  }

  const displayLabel = selected?.label ?? placeholder ?? "";
  const isPlaceholder = !selected && Boolean(placeholder);
  const computedAriaLabel = ariaLabel
    ? displayLabel
      ? `${ariaLabel}: ${displayLabel}`
      : ariaLabel
    : undefined;

  const panel =
    open && pos && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={panelRef}
            className="ui-select-panel"
            data-testid={testId ? `${testId}-panel` : "ui-select-panel"}
            style={{ top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}
            role="presentation"
          >
            <UiSelectOptionList
              listId={listId}
              sections={sections}
              flat={flat}
              value={selected?.value ?? value}
              highlight={highlight}
              ariaLabel={ariaLabel ?? prefix}
              testId={testId}
              onPick={choose}
              onHover={setHighlight}
              listRef={listRef}
              onKeyDown={onListKeyDown}
            />
          </div>,
          document.body,
        )
      : null;

  const rootClasses = ["ui-select", variant === "field" ? "ui-select-field-root" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  const buttonClasses = [
    "ui-select-trigger",
    variant === "field" ? "ui-select-trigger-field" : "ui-select-trigger-pill",
    triggerClassName ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={rootClasses}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={buttonClasses}
        data-testid={testId}
        data-value={selected?.value ?? value}
        data-options={flat.map((item) => item.value).join(",")}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={panelMounted ? listId : undefined}
        aria-label={computedAriaLabel}
        aria-labelledby={ariaLabelledBy}
        disabled={blocked}
        onClick={() => (open ? closePanel("toggle") : openPanel())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="ui-select-value-wrap">
          {prefix ? <span className="ui-select-prefix">{prefix}</span> : null}
          <span className={isPlaceholder ? "ui-select-value ui-select-placeholder" : "ui-select-value"}>
            {displayLabel}
          </span>
        </span>
        <svg
          className="ui-select-chevron"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {panel}
    </div>
  );
}
