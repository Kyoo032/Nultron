"use client";

import { useEffect, useRef, useState } from "react";
import { formatBytes } from "@agentforge/core/format-bytes";
import { createFilesApi } from "@/lib/files-api";
import type { FileEntry } from "@/lib/files-model";
import { t } from "@/lib/i18n";
import {
  deskSourcesOverLimit,
  MAX_DESK_SOURCE_FILES,
  pickableFiles,
  pruneDeskSources,
  splitDeskPath,
  toggleDeskSource,
} from "@/lib/documents-desk-sources";

/** A refresh asked for sooner than this after the last one is skipped; the form asks on every focus. */
const REFRESH_MIN_MS = 4000;

/**
 * A path that gives way from the left: the folders shorten first, the file name stays whole for as long
 * as the row allows. The row carries the full path as its title.
 */
function PathLabel({ path, className = "" }: { readonly path: string; readonly className?: string }) {
  const { dir, name } = splitDeskPath(path);
  return (
    <span className={`flex min-w-0 ${className}`}>
      {dir ? <span className="min-w-0 shrink-[1000] truncate text-[var(--text-2)]">{dir}</span> : null}
      <span className="min-w-0 truncate text-[var(--text)]">{name}</span>
    </span>
  );
}

type ChipsProps = {
  readonly selected: readonly string[];
  readonly disabled: boolean;
  readonly onRemove: (path: string) => void;
};

/** The picked files, each removable. They stay visible with the list closed. */
export function DeskSourceChips({ selected, disabled, onRemove }: ChipsProps) {
  if (selected.length === 0) {
    return null;
  }
  return (
    <ul
      className="mt-2 flex flex-wrap gap-1.5"
      aria-label={t("files.deskSources.chips")}
      data-testid="desk-sources-chips"
    >
      {selected.map((path) => (
        <li
          key={path}
          className="flex min-w-0 max-w-full items-center gap-1 rounded-pill border border-[var(--line)] bg-[var(--accent-soft)] py-0.5 pl-2.5 pr-1 text-xs text-[var(--text)]"
          title={path}
          data-testid="desk-sources-chip"
        >
          <PathLabel path={path} />
          <button
            type="button"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--text-2)] hover:bg-[var(--line)] hover:text-[var(--text)] disabled:opacity-45"
            aria-label={t("files.deskSources.remove", { name: path })}
            disabled={disabled}
            onClick={() => onRemove(path)}
            data-testid="desk-sources-remove"
          >
            <span aria-hidden="true">×</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

type ListProps = {
  readonly entries: readonly FileEntry[];
  readonly selected: readonly string[];
  readonly disabled: boolean;
  readonly onToggle: (path: string) => void;
};

/** Every file on the desk as a checkbox row. A sixth pick is disabled, not hidden. */
export function DeskSourceList({ entries, selected, disabled, onToggle }: ListProps) {
  return (
    <ul
      className="mt-2 max-h-56 divide-y divide-[var(--line)] overflow-y-auto rounded-lg border border-[var(--line)]"
      aria-label={t("files.deskSources.listAria")}
      data-testid="desk-sources-list"
    >
      {entries.map((entry) => {
        const on = selected.includes(entry.path);
        const full = !on && selected.length >= MAX_DESK_SOURCE_FILES;
        return (
          <li key={entry.path}>
            <label
              className={`flex items-center gap-2 px-2.5 py-2 text-xs ${
                full ? "opacity-45" : "cursor-pointer hover:bg-[var(--accent-soft)]"
              }`}
              title={entry.path}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={disabled || full}
                onChange={() => onToggle(entry.path)}
                data-testid="desk-sources-option"
                data-path={entry.path}
              />
              <PathLabel path={entry.path} className="flex-1" />
              <span className="shrink-0 text-[var(--text-3)]">{formatBytes(entry.bytes)}</span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

type Props = {
  readonly selected: readonly string[];
  readonly onChange: (next: string[]) => void;
  readonly disabled?: boolean;
  /** Characters already in the pasted source box, so the limit warning counts both. */
  readonly pastedChars?: number;
  /** Bumped by the form when it is used, so a file made in Chat since the pane mounted shows up. */
  readonly refreshKey?: number;
};

/**
 * "Add from desk files": the person picks up to five files of the desk as sources, and the host reads
 * them when the request is sent. The studio sends only the paths (`sourceFiles`). One control for every
 * studio that takes desk sources. Hidden while the desk has no files and nothing is picked, so a desk
 * without files sees the form as it was.
 */
export function DeskSourcePicker({ selected, onChange, disabled = false, pastedChars = 0, refreshKey = 0 }: Props) {
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [open, setOpen] = useState(false);
  const lastLoad = useRef(0);
  const loadSeq = useRef(0);
  const alive = useRef(true);
  const selectedNow = useRef(selected);
  selectedNow.current = selected;
  const changeNow = useRef(onChange);
  changeNow.current = onChange;

  // Not the load effect's own cleanup: a strict-mode remount would discard the first read and the
  // throttle would then skip the second.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  function load() {
    if (Date.now() - lastLoad.current < REFRESH_MIN_MS) {
      return;
    }
    lastLoad.current = Date.now();
    loadSeq.current += 1;
    const seq = loadSeq.current;
    void createFilesApi()
      .list()
      .then((outcome) => {
        // A failed read keeps what the form already shows: it never hides a picker that worked.
        if (!alive.current || seq !== loadSeq.current || !outcome.ok) {
          return;
        }
        const files = pickableFiles(outcome.data);
        setEntries(files);
        const live = pruneDeskSources(
          selectedNow.current,
          files.map((file) => file.path),
        );
        if (live.length !== selectedNow.current.length) {
          changeNow.current(live);
        }
      });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: `refreshKey` is the trigger; `load` reads refs on purpose.
  useEffect(() => {
    load();
  }, [refreshKey]);

  if ((entries === null || entries.length === 0) && selected.length === 0) {
    return null;
  }
  const over = deskSourcesOverLimit(selected, entries ?? [], pastedChars);
  const full = selected.length >= MAX_DESK_SOURCE_FILES;

  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2" data-testid="desk-sources">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          className="text-xs font-medium text-[var(--text-2)] underline-offset-2 hover:underline disabled:opacity-45"
          onClick={() => {
            if (!open) {
              // Opening is the moment a file saved since the page loaded has to be there.
              load();
            }
            setOpen((current) => !current);
          }}
          disabled={disabled}
          aria-expanded={open}
          data-testid="desk-sources-toggle"
        >
          {t("files.deskSources.add")}
        </button>
        <span className="min-w-0 text-xs text-[var(--text-3)]" data-testid="desk-sources-hint">
          {full
            ? t("files.deskSources.full", { max: MAX_DESK_SOURCE_FILES })
            : t("files.deskSources.limit", { max: MAX_DESK_SOURCE_FILES })}
        </span>
      </div>
      <DeskSourceChips
        selected={selected}
        disabled={disabled}
        onRemove={(path) => onChange(toggleDeskSource(selected, path))}
      />
      {open && entries ? (
        <DeskSourceList
          entries={entries}
          selected={selected}
          disabled={disabled}
          onToggle={(path) => onChange(toggleDeskSource(selected, path))}
        />
      ) : null}
      {over ? (
        <p className="mt-1.5 text-xs text-[var(--danger)]" data-testid="desk-sources-over">
          {t("files.deskSources.tooLarge")}
        </p>
      ) : null}
    </div>
  );
}
