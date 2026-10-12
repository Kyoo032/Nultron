"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { t } from "@/lib/i18n";

/**
 * The `+` in the bare composer, and the menu that opens upward from it (chat-first plan, virtual agents).
 *
 * The bar itself is only `+`, the message box and Send. Everything that used to sit in the toolbar lives
 * here: "Add files" is built in, and the caller passes the other rows as children (Enhance, and the tier
 * picker when the pane offers one). The children stay mounted while the menu is closed, hidden, because
 * Enhance remembers the prompt it can revert and the picker its own state; unmounting would drop both.
 */

type Props = {
  /** Holds the button and the rows while a run is going. */
  disabled?: boolean;
  /** Opens the file picker. The hidden file input stays in the composer. */
  onAddFiles: () => void;
  children?: ReactNode;
};

export type MenuKeyAction = Readonly<{ kind: "move"; index: number }> | Readonly<{ kind: "none" }>;

const NONE: MenuKeyAction = Object.freeze({ kind: "none" });

/**
 * Where an arrow key moves among the menu's enabled buttons. Arrows wrap; Home and End jump. `current`
 * is the index of the button holding focus, or -1 when focus is elsewhere (then ArrowDown lands on the
 * first and ArrowUp on the last).
 */
export function menuKeyAction(key: string, current: number, count: number): MenuKeyAction {
  if (count === 0) {
    return NONE;
  }
  const inRange = current >= 0 && current < count;
  switch (key) {
    case "ArrowDown":
      return { kind: "move", index: inRange ? (current + 1) % count : 0 };
    case "ArrowUp":
      return { kind: "move", index: inRange ? (current - 1 + count) % count : count - 1 };
    case "Home":
      return { kind: "move", index: 0 };
    case "End":
      return { kind: "move", index: count - 1 };
    default:
      return NONE;
  }
}

/**
 * A choice made on the spot closes the menu. The tier panel is portalled out of the menu, so its rows are
 * matched here. Enhance stays open on purpose: its running, Revert and failed states live on that button.
 */
const CLOSES_MENU = ".tier-picker-option:not([aria-disabled='true'])";
const OUTSIDE_EXEMPT = ".tier-picker-panel";

export function ComposerPlusMenu({ disabled, onAddFiles, children }: Props) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  function enabledButtons(): HTMLButtonElement[] {
    return Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
  }

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) {
      triggerRef.current?.focus();
    }
  }

  // A run started while the menu was open: the rows are disabled, so the menu goes with them.
  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  // Opening puts focus on the first row, so the arrow keys work straight away.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `enabledButtons` only reads a ref; the effect belongs to `open`, not to a new closure each render
  useEffect(() => {
    if (open) {
      enabledButtons()[0]?.focus();
    }
  }, [open]);

  // A press outside both the menu and the tier panel (portalled to the body) closes it and leaves focus
  // where the press put it.
  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Element | null;
      if (rootRef.current?.contains(target) || target?.closest?.(OUTSIDE_EXEMPT)) {
        return;
      }
      setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  // Capture phase, so an arrow on the tier picker's trigger moves between rows instead of opening its list.
  function onKeyDownCapture(event: ReactKeyboardEvent<HTMLDivElement>) {
    const target = event.target as Node;
    if (!menuRef.current?.contains(target) && target !== triggerRef.current) {
      return; // From the tier panel, which is portalled: its keys are its own.
    }
    if (!open) {
      if (target === triggerRef.current && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    const buttons = enabledButtons();
    const action = menuKeyAction(
      event.key,
      buttons.indexOf(document.activeElement as HTMLButtonElement),
      buttons.length,
    );
    if (action.kind === "move") {
      event.preventDefault();
      event.stopPropagation();
      buttons[action.index]?.focus();
    }
  }

  // Bubble phase: the tier list calls `preventDefault` on its own Escape, and React bubbles that through
  // the portal, so a handled Escape must not close this menu as well.
  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || !open || event.defaultPrevented) {
      return;
    }
    const target = event.target as Node;
    if (!menuRef.current?.contains(target) && target !== triggerRef.current) {
      return;
    }
    event.preventDefault();
    close(true);
  }

  function onClick(event: ReactMouseEvent<HTMLDivElement>) {
    if ((event.target as Element).closest?.(CLOSES_MENU)) {
      close(false);
    }
  }

  // Tabbing out of the menu closes it. A blur with no destination is a press on a bare spot, which the
  // pointer listener already answers.
  function onBlur(event: ReactFocusEvent<HTMLDivElement>) {
    const next = event.relatedTarget as Element | null;
    if (open && next && !rootRef.current?.contains(next) && !next.closest?.(OUTSIDE_EXEMPT)) {
      setOpen(false);
    }
  }

  return (
    <div
      className="composer-plus"
      ref={rootRef}
      onKeyDownCapture={onKeyDownCapture}
      onKeyDown={onKeyDown}
      onClick={onClick}
      onBlur={onBlur}
    >
      <button
        ref={triggerRef}
        type="button"
        className="composer-plus-btn"
        data-testid="composer-plus"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={t("agents.composer.add")}
        title={t("agents.composer.add")}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      <div
        ref={menuRef}
        id={menuId}
        className="composer-plus-menu raise"
        role="menu"
        data-testid="composer-plus-menu"
        hidden={!open}
      >
        <button
          type="button"
          className="composer-plus-row wash"
          role="menuitem"
          data-testid="composer-attach"
          disabled={disabled}
          onClick={() => {
            close(true);
            onAddFiles();
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21.4 11.05 12.25 20.2a5 5 0 0 1-7.07-7.07l9.19-9.19a3 3 0 0 1 4.24 4.24l-9.2 9.19a1 1 0 0 1-1.41-1.41l8.48-8.49" />
          </svg>
          <span>{t("agents.composer.addFiles")}</span>
        </button>
        {children}
      </div>
    </div>
  );
}
