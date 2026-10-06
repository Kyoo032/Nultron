"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { ModelTierId } from "@agentforge/core/tiers";
import { focusAfterClose, isPanelMounted, type PickerCloseReason } from "@/components/model-picker";
import type { ChatTierInfo } from "@/lib/chat-tier-pref";
import { t } from "@/lib/i18n";
import { placePickerPanel, viewportBounds, type PickerPanelPos } from "@/lib/picker-panel";
import "@/components/tier-picker.css";

/**
 * The three choices in Chat's composer: Daily, Fastest, Reasoning (tester code, chat-first plan track M1,
 * model tiers spec sections 1 and 5). It replaces the model picker there. The trigger shows the current
 * choice's label and nothing else; the panel lists the three with a line on what each is for. No search,
 * no groups, and no model name anywhere, because the renderer is never told one.
 *
 * The wrapper wears the model picker's `model-picker` and `model-picker-trigger` classes. They are the
 * composer toolbar's grid hooks in `globals.css` (a stylesheet the tester lane does not edit), and they
 * place a choice control in the wide, medium, narrow and tiny layouts. A later pass that owns that
 * stylesheet can rename them.
 */

type Props = {
  tiers: readonly ChatTierInfo[];
  value: ModelTierId;
  onChange: (tier: ModelTierId) => void;
  disabled?: boolean;
  /** Where focus goes after a choice is made: the composer's text box. Escape returns to the trigger instead. */
  returnFocusRef?: RefObject<HTMLTextAreaElement | null>;
};

export type TierKeyAction =
  | Readonly<{ kind: "move"; index: number }>
  | Readonly<{ kind: "select"; index: number }>
  | Readonly<{ kind: "close" }>
  | Readonly<{ kind: "none" }>;

const NONE: TierKeyAction = Object.freeze({ kind: "none" });
const CLOSE: TierKeyAction = Object.freeze({ kind: "close" });

/**
 * What a key does inside the open list, as a decision the component then carries out.
 *
 * Arrows wrap, Home and End jump, Enter or Space chooses the highlighted tier unless the host reports it
 * unavailable (it can be reached, and read, but not chosen), Escape and Tab close. A highlight outside
 * the list is treated as "no row yet", so ArrowDown lands on the first and ArrowUp on the last.
 */
export function tierKeyAction(
  key: string,
  state: Readonly<{ highlight: number; tiers: readonly { available: boolean }[] }>,
): TierKeyAction {
  if (key === "Escape" || key === "Tab") {
    return CLOSE;
  }
  const count = state.tiers.length;
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
      return inRange && state.tiers[state.highlight]?.available ? { kind: "select", index: state.highlight } : NONE;
    default:
      return NONE;
  }
}

function optionId(listId: string, tier: ModelTierId): string {
  return `${listId}-opt-${tier}`;
}

type ListProps = {
  listId: string;
  tiers: readonly ChatTierInfo[];
  value: ModelTierId;
  highlight: number;
  onPick: (tier: ModelTierId) => void;
  onHover: (index: number) => void;
  listRef?: Ref<HTMLUListElement>;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLUListElement>) => void;
};

/** The listbox and its rows. It is its own component so the markup can be read without the portal. */
export function TierOptionList({ listId, tiers, value, highlight, onPick, onHover, listRef, onKeyDown }: ListProps) {
  const active = tiers[highlight];
  return (
    <ul
      id={listId}
      ref={listRef}
      role="listbox"
      tabIndex={-1}
      className="tier-picker-list"
      aria-label={t("chat.tiers.aria")}
      aria-activedescendant={active ? optionId(listId, active.id) : undefined}
      onKeyDown={onKeyDown}
    >
      {tiers.map((tier, index) => {
        const selected = tier.id === value;
        const unavailable = !tier.available;
        return (
          <li
            key={tier.id}
            id={optionId(listId, tier.id)}
            role="option"
            aria-selected={selected}
            aria-disabled={unavailable ? true : undefined}
            data-testid={`tier-option-${tier.id}`}
            data-active={index === highlight ? "true" : "false"}
            className="tier-picker-option wash"
            onMouseEnter={() => onHover(index)}
            // Keep focus on the list: a press on a row must not blur it before the click lands.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (!unavailable) {
                onPick(tier.id);
              }
            }}
          >
            <span className="tier-picker-check" aria-hidden="true">
              {selected ? "✓" : ""}
            </span>
            <span className="tier-picker-text">
              <span className="tier-picker-label">{t(`chat.tiers.${tier.id}.label`)}</span>
              <span className="tier-picker-hint">{t(`chat.tiers.${tier.id}.hint`)}</span>
            </span>
            {unavailable ? <span className="tier-picker-unavailable">{t("chat.tiers.unavailable")}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

export function TierPicker({ tiers, value, onChange, disabled, returnFocusRef }: Props) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [pos, setPos] = useState<PickerPanelPos | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const panelMounted = isPanelMounted(open, pos);
  const blocked = Boolean(disabled) || tiers.length === 0;
  const label = t(`chat.tiers.${value}.label`);

  function focusTarget(target: ReturnType<typeof focusAfterClose>) {
    if (!target) {
      return;
    }
    // The composer is optional; without one, the trigger is the only sane place to land.
    const element = target === "composer" ? (returnFocusRef?.current ?? triggerRef.current) : triggerRef.current;
    queueMicrotask(() => element?.focus());
  }

  function closePanel(reason: PickerCloseReason) {
    setOpen(false);
    setPos(null);
    focusTarget(focusAfterClose(reason, "trigger"));
  }

  function openPanel() {
    if (blocked) {
      return;
    }
    setHighlight(
      Math.max(
        0,
        tiers.findIndex((tier) => tier.id === value),
      ),
    );
    setOpen(true);
  }

  function choose(tier: ModelTierId) {
    onChange(tier);
    closePanel("select");
  }

  // A press outside both the panel and the trigger closes it, and leaves focus where the press put it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `closePanel` only calls state setters and reads refs, so the listener the effect holds never goes stale; it belongs to `open`, not to a new closure each render
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

  // The composer is a query container, so the panel is portalled and placed against the trigger.
  useEffect(() => {
    if (!open) {
      return;
    }
    function place() {
      const trigger = triggerRef.current;
      if (!trigger) {
        return;
      }
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      setPos(placePickerPanel(trigger.getBoundingClientRect(), viewportBounds(viewport), viewport));
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
  }, [open]);

  // Focus the list once the portalled panel exists (`isPanelMounted`): a focus call made when `open`
  // is set lands on nothing, focus stays on the trigger, and the list's keys never fire.
  useEffect(() => {
    if (panelMounted) {
      listRef.current?.focus();
    }
  }, [panelMounted]);

  function onListKeyDown(event: ReactKeyboardEvent<HTMLUListElement>) {
    const action = tierKeyAction(event.key, { highlight, tiers });
    if (action.kind === "none") {
      return;
    }
    event.preventDefault();
    if (action.kind === "move") {
      setHighlight(action.index);
    } else if (action.kind === "select") {
      const picked = tiers[action.index];
      if (picked) {
        choose(picked.id);
      }
    } else {
      closePanel("escape");
    }
  }

  // Enter and Space open it as on any button. An arrow key opens it too, and Escape on the trigger closes an
  // open panel if focus never reached the list (a press that landed before the panel mounted).
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

  const panel =
    open && pos && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={panelRef}
            className="tier-picker-panel raise"
            data-testid="tier-picker-panel"
            style={{ top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}
            role="presentation"
          >
            <TierOptionList
              listId={listId}
              tiers={tiers}
              value={value}
              highlight={highlight}
              onPick={choose}
              onHover={setHighlight}
              listRef={listRef}
              onKeyDown={onListKeyDown}
            />
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="tier-picker model-picker">
      <button
        ref={triggerRef}
        type="button"
        className="tier-picker-trigger model-picker-trigger wash inline-flex w-full min-w-0 items-center overflow-hidden rounded-pill border border-[var(--line)] bg-transparent px-3 text-left text-xs font-medium text-[var(--text)] hover:bg-[var(--accent-soft)] disabled:opacity-45"
        data-testid="tier-picker"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={panelMounted ? listId : undefined}
        // The label alone is the visible text; the name adds what the control is, and still contains it.
        aria-label={`${t("chat.tiers.aria")}: ${label}`}
        disabled={blocked}
        onClick={() => (open ? closePanel("toggle") : openPanel())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="min-w-0 truncate">{label}</span>
        <svg
          className="tier-picker-chevron"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m4 9 8 8 8-8" />
        </svg>
      </button>
      {panel}
    </div>
  );
}
