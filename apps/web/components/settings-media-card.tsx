"use client";

import type { AlwaysAllow, MediaKind } from "@/components/tool-rows/media-result";
import { t } from "@/lib/i18n";

const KINDS: readonly MediaKind[] = ["image", "video"];

type MediaSettingsFailure = "load" | "save";

export function AlwaysAllowToggles({
  allow,
  busy,
  failure,
  onToggle,
}: {
  readonly allow: AlwaysAllow | null;
  readonly busy: MediaKind | null;
  readonly failure: MediaSettingsFailure | null;
  readonly onToggle: (kind: MediaKind, next: boolean) => void;
}) {
  return (
    <div className="space-y-3">
      {KINDS.map((kind) => (
        <label key={kind} className="flex items-center gap-2 text-sm text-[var(--text)]">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={allow ? allow[kind] : false}
            disabled={allow === null || busy !== null}
            onChange={(event) => onToggle(kind, event.target.checked)}
            data-testid={`settings-media-${kind}`}
          />
          {kind === "image" ? t("settings.media.image") : t("settings.media.video")}
        </label>
      ))}
      {failure ? (
        <p className="text-sm text-[var(--danger)]" role="alert" data-testid="settings-media-error">
          {failure === "load" ? t("settings.media.loadFailed") : t("settings.media.failed")}
        </p>
      ) : null}
    </div>
  );
}

export function SettingsMediaCard() {
  return null;
}
