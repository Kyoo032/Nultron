"use client";

/**
 * Two quiet lines under a studio's controls: what moved when the model changed ("Changed for X:
 * resolution 1080p → 720p."), and what the last clip or picture was made with. Nothing when there is
 * nothing to say.
 */
export function MediaControlsNote({
  kind,
  note,
  made,
}: {
  kind: "videos" | "images";
  note: string | null;
  made: string | null;
}) {
  if (!note && !made) {
    return null;
  }
  return (
    <div className="space-y-0.5" role="status">
      {note ? (
        <p className="text-xs text-[var(--text-2)]" data-testid={`${kind}-studio-note`}>
          {note}
        </p>
      ) : null}
      {made ? (
        <p className="text-xs text-[var(--text-3)]" data-testid={`${kind}-studio-sent`}>
          {made}
        </p>
      ) : null}
    </div>
  );
}
