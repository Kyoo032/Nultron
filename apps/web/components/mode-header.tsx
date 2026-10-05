import type { CSSProperties, ReactNode } from "react";
import { BuddyStage } from "@/components/buddy-stage";
import { FloatingShapes } from "@/components/floating-shapes";
import { ModeIcon, type ModeIconName } from "@/components/mode-icons";

/** Nultron's box in the header's art column. The body is about 77% of it, so it stands about 100 px tall. */
const HEADER_BUDDY_SIZE = 116;

/**
 * The header every mode page opens with: a gradient icon tile, the title, and the one
 * outcome line (`expected-inputs`, which the verify recipes read). `actions` sits on the
 * right and wraps under the title on a narrow desk.
 *
 * The decorative art is a column of its own at the end of the header, never a layer over it, so it
 * cannot lie on the title, the outcome line or the actions. The header is the size container
 * (`.mode-header` in globals.css): the column appears only once the header is wide enough to keep
 * the text beside it, and a page whose header is always narrow passes `shapes={false}`.
 */
export function ModeHeader({
  icon,
  title,
  outcome,
  actions,
  children,
  outcomeTestId = "expected-inputs",
  shapes = true,
}: {
  icon: ModeIconName;
  title: ReactNode;
  outcome?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  /** Account pages have an intro rather than a mode's outcome line. */
  outcomeTestId?: string;
  /** Draw the art column when the header has room. Off for a header that is never wide enough. */
  shapes?: boolean;
}) {
  return (
    <header className="mode-header relative flex gap-4 pb-2" data-testid="mode-header" data-mode={icon}>
      <div className="flex min-w-0 flex-1 flex-wrap items-end justify-between gap-4">
        <div className="mode-header-title enter-rise relative flex min-w-0 items-start gap-4">
          <span className="icon-orb icon-orb-lg icon-orb-solid tile-bounce">
            <ModeIcon name={icon} size={26} strokeWidth={2} />
          </span>
          <div className="min-w-0">
            <h1 className="font-heading text-[length:var(--fs-24)] font-bold leading-[var(--lh-tight)] tracking-[var(--track)] text-[var(--text)]">
              {title}
            </h1>
            {outcome ? (
              <p
                className="mt-1.5 max-w-[var(--content-narrow)] text-sm text-[var(--text-2)]"
                data-testid={outcomeTestId}
              >
                {outcome}
              </p>
            ) : null}
            {children}
          </div>
        </div>
        {actions ? (
          <div className="enter-fade relative flex flex-wrap items-center gap-2" style={{ "--i": 2 } as CSSProperties}>
            {actions}
          </div>
        ) : null}
      </div>
      {shapes ? (
        <div className="mode-header-art">
          <div className="mode-header-art-shapes" aria-hidden="true">
            <FloatingShapes layout="header" interactive />
          </div>
          <BuddyStage kind="header" mode={icon} size={HEADER_BUDDY_SIZE} />
        </div>
      ) : null}
    </header>
  );
}
