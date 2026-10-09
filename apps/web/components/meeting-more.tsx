"use client";

import type { FormEvent, ReactNode } from "react";
import type { AppLocale } from "@agentforge/core/locale";
import { ModelSelect } from "@/components/model-select";
import { t } from "@/lib/i18n";

type Models = Parameters<typeof ModelSelect>[0]["models"];

export type MeetingMoreProps = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly onTitle: (value: string) => void;
  readonly locale: AppLocale;
  readonly onLocale: (value: AppLocale) => void;
  readonly onCreate: (event: FormEvent) => void;
  /** A request is in flight or a recording is running: Create waits. */
  readonly createDisabled: boolean;
  readonly models: Models;
  readonly model: string;
  readonly onModel: (id: string) => void;
  readonly alwaysTranslate: boolean;
  readonly onAlwaysTranslate: (value: boolean) => void;
  /** The recorder panel, which owns its own states and notices. */
  readonly children: ReactNode;
};

/**
 * Everything the front door does not need, behind one closed disclosure (Rizky, 2026-10-05: values are
 * added later and only when needed): how it works, the manual create form, the language spoken, the model,
 * the remembered "always translate" choice, and the recorder.
 *
 * The studio opens it by itself while a recording is running or a clip still needs a decision (Retry, Save
 * to device), because those notices must never sit in a closed box.
 */
export function MeetingMore(props: MeetingMoreProps) {
  return (
    <details
      className="mt-6"
      open={props.open}
      onToggle={(event) => props.onOpenChange(event.currentTarget.open)}
      data-testid="meeting-more-details"
    >
      <summary className="cursor-pointer select-none text-sm text-[var(--text-3)]" data-testid="meeting-more">
        {t("meeting.more")}
      </summary>
      <div className="mt-4 space-y-6">
        <p className="max-w-[var(--content-narrow)] text-sm text-[var(--text-2)]" data-testid="meeting-how-it-works">
          {t("meeting.howItWorks")}
        </p>

        <form className="flex flex-wrap items-end gap-3" onSubmit={props.onCreate} data-testid="meeting-new">
          <label className="min-w-[16rem] flex-1 text-sm">
            <span className="text-[var(--text-2)]">{t("meeting.meetingTitle")}</span>
            <input
              value={props.title}
              onChange={(event) => props.onTitle(event.target.value)}
              placeholder={t("meeting.meetingTitlePlaceholder")}
              className="mt-1 h-9 w-full rounded-lg border border-[var(--line)] bg-transparent px-3"
              data-testid="meeting-title"
            />
          </label>
          {/* Same stack as the title field beside it: the label holds a full-width control, so the
              caption sits on its own line above it instead of butting straight against the select. */}
          <label className="min-w-[10rem] text-sm">
            <span className="text-[var(--text-2)]">{t("meeting.language")}</span>
            <select
              value={props.locale}
              onChange={(event) => props.onLocale(event.target.value as AppLocale)}
              className="mt-1 h-9 w-full rounded-lg border border-[var(--line)] bg-transparent px-3"
              data-testid="meeting-locale"
            >
              <option value="en">{t("meeting.languageEnglish")}</option>
              <option value="id">{t("meeting.languageIndonesian")}</option>
            </select>
          </label>
          <button
            type="submit"
            disabled={props.createDisabled || !props.title.trim()}
            className="btn btn-primary h-9 rounded-pill px-4"
            data-testid="meeting-create"
          >
            {t("meeting.create")}
          </button>
        </form>

        <div className="space-y-1">
          <span className="block text-sm text-[var(--text-2)]">{t("meeting.model")}</span>
          <ModelSelect
            models={props.models}
            value={props.model}
            onChange={props.onModel}
            testId="meeting-model"
            className="select-field w-full"
          />
        </div>

        <label className="flex items-start gap-2 text-sm text-[var(--text)]">
          <input
            type="checkbox"
            checked={props.alwaysTranslate}
            onChange={(event) => props.onAlwaysTranslate(event.target.checked)}
            className="mt-1"
            data-testid="meeting-translate-default"
          />
          <span>
            {t("meeting.translateDefault")}
            <span className="block text-xs text-[var(--text-3)]">{t("meeting.translateDefaultHint")}</span>
          </span>
        </label>

        <div>
          {props.children}
          <p className="mt-2 text-xs text-[var(--text-3)]">{t("meeting.cap")}</p>
        </div>
      </div>
    </details>
  );
}
