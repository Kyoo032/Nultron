import type { CSSProperties } from "react";

/**
 * Placeholder rows for the rail's recent sessions while `GET /api/v1/threads` is in flight.
 *
 * Same height as a real row (`h-7`, see `RailRecentThreads`), so when the rows arrive they take these
 * places and the pinned Account group below does not move (`lib/rail-recent-shape.ts`). Still on
 * purpose: no shimmer, no pulse, no loop, like `RailModesSkeleton`. `aria-hidden`; the group is
 * labelled by the real block around it.
 */
const LABEL_WIDTHS: readonly string[] = ["72%", "58%", "66%", "48%"];

const BLOCK = "bg-[color-mix(in_srgb,var(--rail-text-3)_18%,transparent)]";

export function RailRecentSkeleton({ rows, more }: { rows: number; more: boolean }) {
  // Rows have no identity and never reorder; the keys are made once, up front.
  const keys = Array.from({ length: Math.max(0, rows) }, (_, index) => `recent-skeleton-${index}`);
  return (
    <div aria-hidden="true" data-testid="rail-recent-skeleton">
      {keys.map((key, index) => (
        <div key={key} className="flex h-7 items-center px-2" data-testid="rail-recent-skeleton-row">
          <span
            className={`h-2.5 rounded-sm ${BLOCK}`}
            style={{ width: LABEL_WIDTHS[index % LABEL_WIDTHS.length] } as CSSProperties}
          />
        </div>
      ))}
      {more ? (
        <div className="flex h-7 items-center px-2" data-testid="rail-recent-skeleton-more">
          <span className={`h-2.5 w-[34%] rounded-sm ${BLOCK}`} />
        </div>
      ) : null}
    </div>
  );
}
