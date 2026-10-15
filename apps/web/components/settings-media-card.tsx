"use client";

import { useEffect, useState } from "react";
import type { AlwaysAllow, MediaKind } from "@/components/tool-rows/media-result";
import { t } from "@/lib/i18n";
import { mediaApi } from "@/lib/media-approval-client";
import { useShellLook } from "@/lib/product-brand";

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
  const enterprise = useShellLook() === "enterprise";
  const [allow, setAllow] = useState<AlwaysAllow | null>(null);
  const [busy, setBusy] = useState<MediaKind | null>(null);
  const [failure, setFailure] = useState<MediaSettingsFailure | null>(null);

  useEffect(() => {
    if (!enterprise) {
      return;
    }
    let current = true;
    void mediaApi.fetchAlwaysAllow().then((outcome) => {
      if (!current) {
        return;
      }
      if (outcome.ok) {
        setAllow(outcome.value);
      } else {
        setFailure("load");
      }
    });
    return () => {
      current = false;
    };
  }, [enterprise]);

  if (!enterprise) {
    return null;
  }

  function onToggle(kind: MediaKind, next: boolean) {
    setBusy(kind);
    setFailure(null);
    void mediaApi
      .setAlwaysAllow(kind, next)
      .then((outcome) => {
        if (outcome.ok) {
          setAllow(outcome.value);
        } else {
          setFailure("save");
        }
      })
      .finally(() => setBusy(null));
  }

  return (
    <section
      className="mt-6 space-y-4 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4"
      data-testid="settings-media"
    >
      <div>
        <h2 className="font-medium text-[var(--text)]">{t("settings.media.heading")}</h2>
        <p className="mt-1 text-xs text-[var(--text-3)]">{t("settings.media.help")}</p>
      </div>
      <AlwaysAllowToggles allow={allow} busy={busy} failure={failure} onToggle={onToggle} />
    </section>
  );
}
