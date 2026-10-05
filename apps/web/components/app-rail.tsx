"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "@/lib/nav";
import { usePathname } from "@/lib/nav";
import { PRODUCT_MODES, firstVisibleHref, productModeMatches, type ProductMode } from "@agentforge/core/product-modes";
import { AppUpdatesButton } from "@/components/app-updates";
import { DeskBuddyChip, DeskBuddyDock } from "@/components/desk-buddy";
import { ThemeToggle } from "@/components/theme-toggle";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { getRailCollapsed, setRailCollapsed } from "@/lib/rail-prefs";
import { RAIL_WIDTH, RAIL_WIDTH_KEY } from "@/lib/panel-width";
import { usePanelWidth } from "@/lib/use-panel-width";
import { useMoreBelow } from "@/lib/use-more-below";
import { PanelResizeHandle } from "@/components/panel-resize-handle";
import { RailRecentThreads } from "@/components/rail-recent-threads";
import { RailEducationTasks, RailEducationTasksToggle, useRailEducationTasks } from "@/components/rail-education-tasks";
import { RailFinanceTasks, RailFinanceTasksToggle, useRailFinanceTasks } from "@/components/rail-finance-tasks";
import {
  RailMarketSpecialists,
  RailMarketSpecialistsToggle,
  useRailMarketSpecialists,
} from "@/components/rail-market-specialists";
import { ModeIcon, isModeIconName, type ModeIconName } from "@/components/mode-icons";
import { BrandMark } from "@/components/brand-mark";
import { RailModesSkeleton } from "@/components/rail-modes-skeleton";
import { useProductBrand, usesBundledMark, usesNultronWordmark } from "@/lib/product-brand";
import { t } from "@/lib/i18n";
import { railModesPending, SKELETON_MODE_ROWS, type ShellModesSource } from "@/lib/shell-modes";
import { productMonogram } from "@/components/app-shell";

type Props = {
  workspaceName: string;
  visibleModes: ProductMode[];
  /** Where `visibleModes` came from (`lib/shell-modes.ts`). Only `"unknown"` changes what is drawn. */
  modesSource?: ShellModesSource;
};

/* Music and Meeting shipped 2026-09-21 and rode a self-expiring "New" badge until
   2026-10-22. The owner took the badge off early (2026-09-23): it added noise to the
   rail, and the rail is the navigation now. The whole mechanism is gone rather than
   the constant re-dated — a badge nobody reads is worse than no badge. */

function RailItem({
  href,
  label,
  icon,
  active,
  collapsed,
  testId,
  index,
  enter = true,
  trailing,
}: {
  href: string;
  label: string;
  icon: ModeIconName;
  active: boolean;
  collapsed: boolean;
  testId: string;
  index: number;
  /** False for rows that take a skeleton's place: they appear where it was, not sliding in after it. */
  enter?: boolean;
  /** A control that rides at the row's right edge (the Finance / Market / Education sub-list chevron). */
  trailing?: ReactNode;
}) {
  /*
   * `shrink-0`: the nav is a column flex box, so without it a rail that runs past
   * the viewport squashes these rows (32px down to 23px at 640) while a row
   * wrapped in anything — the session block, Market's chevron row — keeps its
   * height and reads as though it had extra space around it. The nav already
   * scrolls; rows keep their rhythm instead.
   *
   * Every mode carries its own colour on a small icon tile; the active row is a
   * raised white card and its tile goes solid. Current is also `aria-current`.
   */
  const rowTone = active
    ? "select-row bg-[var(--rail-active)] font-semibold text-[var(--rail-active-text)] shadow-[var(--lip)]"
    : "wash text-[var(--rail-text-2)] hover:bg-[var(--rail-hover)] hover:text-[var(--rail-active-text)]";
  const tileTone = active
    ? "bg-[var(--mode)] text-[var(--on-mode)]"
    : "bg-[color-mix(in_srgb,var(--mode)_14%,transparent)] text-[var(--mode)]";

  const content = (
    <>
      <span
        data-tile
        className={`transition-colors inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ${tileTone}`}
      >
        <ModeIcon name={icon} strokeWidth={2} />
      </span>
      {collapsed ? null : <span className="truncate font-medium">{label}</span>}
    </>
  );

  if (trailing) {
    /*
     * A row with a control at its right edge is one card, not a link and a chip side by side: the
     * current-row fill, its lip and the hover wash sit on this wrapper, so they run the full width
     * under the word and the chevron too. The link inside carries everything the tests and the
     * harness read (`data-testid`, `aria-current`, `data-mode`).
     */
    return (
      <div
        className={`${enter ? "enter-slide " : ""}flex h-8 shrink-0 items-center rounded-md ${rowTone}`}
        style={{ "--i": index } as CSSProperties}
        data-rail-row
      >
        <Link
          href={href}
          className="hover-wiggle flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pl-2 pr-1 text-sm tracking-[var(--track)]"
          aria-current={active ? "page" : undefined}
          aria-label={label}
          title={label}
          data-testid={testId}
          data-mode={icon}
        >
          {content}
        </Link>
        {trailing}
      </div>
    );
  }

  return (
    <Link
      href={href}
      className={`${enter ? "enter-slide " : ""}hover-wiggle flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-sm tracking-[var(--track)] ${rowTone} ${
        collapsed ? "justify-center" : ""
      }`}
      style={{ "--i": index } as CSSProperties}
      aria-current={active ? "page" : undefined}
      aria-label={label}
      title={label}
      data-testid={testId}
      data-mode={icon}
      data-rail-row
    >
      {content}
    </Link>
  );
}

function RailGroupLabel({ children, collapsed, first }: { children: ReactNode; collapsed: boolean; first?: boolean }) {
  if (collapsed) {
    return <div className={`${first ? "mt-1" : "mt-2"} mx-auto h-px w-6 shrink-0 bg-[var(--rail-line)]`} />;
  }
  return (
    <p className="shrink-0 px-2 pt-4 pb-1.5 text-xs font-medium tracking-normal text-[var(--rail-text-3)]">
      {children}
    </p>
  );
}

function BrandTile({
  logoSrc,
  productName,
  bundled,
}: {
  logoSrc: string;
  productName: string;
  bundled: boolean;
}) {
  if (bundled) {
    // The Nultron mark is already a tile, so it is not set inside another one. The name sits
    // beside it in the header, so the image itself is decorative.
    return (
      <span
        className="enter-pop inline-flex shrink-0 items-center justify-center"
        style={{ width: 28, height: 28 }}
        data-testid="product-logo"
      >
        <BrandMark size={24} />
      </span>
    );
  }
  return (
    <span
      className="icon-orb icon-orb-solid enter-pop"
      style={{ width: 28, height: 28, borderRadius: 10 } as CSSProperties}
      data-testid="product-logo"
    >
      {logoSrc ? (
        <img src={logoSrc} alt={productName} className="h-4 w-4 object-contain" />
      ) : (
        <span className="text-xs font-medium">{productMonogram(productName)}</span>
      )}
    </span>
  );
}

export function AppRail({ workspaceName, visibleModes, modesSource = "host" }: Props) {
  const pathname = usePathname();
  const brand = useProductBrand();
  const { productName, logoSrc } = brand;
  const bundledMark = usesBundledMark(brand);
  // The public name takes the Nultron colours; a flavor's or a renamed tenant's stays plain rail text.
  const nultronWordmark = usesNultronWordmark(brand);
  const [collapsed, setCollapsed] = useState(false);
  const [railWidth, setRailWidth] = usePanelWidth(RAIL_WIDTH_KEY, RAIL_WIDTH.default, RAIL_WIDTH.min, RAIL_WIDTH.max);
  // Nothing cached and the host has not answered: `visibleModes` is only Chat, and the other rows are
  // a skeleton rather than a guess (`lib/shell-modes.ts`).
  const modesPending = railModesPending(modesSource);
  // A rail that mounted with a skeleton swaps real rows in where it stood. Their entrance would leave
  // the group empty while each row waits out its stagger, which reads as a flicker.
  const [startedPending] = useState(modesPending);
  const modes = PRODUCT_MODES.filter((mode) => visibleModes.includes(mode.id));
  const homeHref = firstVisibleHref(visibleModes);
  const chatMode = modes.find((mode) => mode.id === "chat");
  const jobModes = modes.filter((mode) => mode.id !== "chat");
  const marketSpecialists = useRailMarketSpecialists();
  const financeTasks = useRailFinanceTasks();
  const educationTasks = useRailEducationTasks();
  const { ref: navRef, more: moreBelow } = useMoreBelow<HTMLElement>();

  useEffect(() => {
    const query = window.matchMedia("(max-width: 480px)");
    function apply() {
      setCollapsed(query.matches ? true : getRailCollapsed());
    }
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  function toggleCollapsed() {
    setCollapsed((was) => {
      const next = !was;
      if (!window.matchMedia("(max-width: 480px)").matches) {
        setRailCollapsed(next);
      }
      return next;
    });
  }

  let itemIndex = 0;

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col overflow-hidden border-r border-[var(--rail-line)] bg-[var(--rail)]"
      style={{ width: collapsed ? RAIL_WIDTH.collapsed : railWidth }}
      aria-label={t("rail.aria")}
      data-rail={collapsed ? "min" : "full"}
    >
      <div
        /* Header is h-12 + this top padding, so the wordmark and the desk row get breathing
           room from the window edge (owner report 2026-09-23) without moving the nav below it. */
        className={`flex shrink-0 pt-3 ${collapsed ? "items-center justify-center px-1.5" : "items-center gap-2 px-3"}`}
      >
        {collapsed ? (
          <WorkspaceSwitcher
            workspaceName={workspaceName}
            compact
            logoSrc={bundledMark ? "" : logoSrc}
            logoAlt={productName}
          />
        ) : (
          <>
            <BrandTile logoSrc={logoSrc} productName={productName} bundled={bundledMark} />
            <div className="min-w-0 flex-1">
              <Link
                href={homeHref}
                className={`block truncate text-sm tracking-[var(--track)] ${
                  nultronWordmark ? "wordmark-nultron" : "font-medium text-[var(--rail-text)]"
                }`}
                data-testid="product-brand"
                data-wordmark={nultronWordmark ? "nultron" : undefined}
              >
                {productName}
              </Link>
              <WorkspaceSwitcher workspaceName={workspaceName} />
            </div>
          </>
        )}
      </div>

      {/* `mr-2`: a scrollbar is laid out inside the border box and outside the
          padding box, so padding cannot move it — only the margin can. Pulling
          the scrolling box 8px off the aside's right edge clears the lane the
          `rail-resize` strip occupies, so the handle is never stacked on top of
          this nav's scrollbar (owner report 2026-09-17). */}
      <nav
        ref={navRef}
        className="mr-2 flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-y-contain px-2"
        aria-label={t("rail.modesAria")}
        aria-busy={modesPending || undefined}
        data-tour="rail-modes"
      >
        {chatMode ? (
          <>
            <RailGroupLabel collapsed={collapsed} first>
              {t("rail.groupConverse")}
            </RailGroupLabel>
            <RailItem
              href={chatMode.href}
              label={t("rail.chat")}
              icon="chat"
              active={productModeMatches(chatMode.id, pathname)}
              collapsed={collapsed}
              testId={`mode-${chatMode.href.slice(1)}`}
              index={itemIndex++}
            />
            {/* Collapsed rail keeps New chat (icon + label) and hides session rows. */}
            <RailRecentThreads collapsed={collapsed} />
          </>
        ) : null}

        {jobModes.length > 0 || modesPending ? (
          <RailGroupLabel collapsed={collapsed}>{t("rail.groupJobs")}</RailGroupLabel>
        ) : null}
        {modesPending ? <RailModesSkeleton collapsed={collapsed} rows={SKELETON_MODE_ROWS} /> : null}
        {jobModes.map((mode) => {
          const icon: ModeIconName = isModeIconName(mode.id) ? mode.id : "documents";
          const index = itemIndex++;
          const itemProps = {
            href: mode.href,
            label: t(`rail.${mode.id}`),
            icon,
            active: productModeMatches(mode.id, pathname),
            collapsed,
            testId: `mode-${mode.href.slice(1)}`,
            index,
            enter: !startedPending,
          };
          const item = <RailItem key={mode.href} {...itemProps} />;
          /*
           * Market carries its agents the way Chat carries its sessions: the
           * chevron rides on the Market row and the desks render under it, each
           * one its own harness and its own watchlist. The collapsed rail stays
           * a pure icon column, so neither the chevron nor the rows appear there.
           */
          if (collapsed || (mode.id !== "market" && mode.id !== "finance" && mode.id !== "education")) {
            return item;
          }
          if (mode.id === "finance") {
            /* Finance carries its tasks on exactly the Market rules: same row,
               same chevron, same one `h-8`, same nothing-below-when-closed. */
            return (
              <div key={mode.href} className="shrink-0" data-testid="rail-finance-mode">
                <RailItem
                  {...itemProps}
                  trailing={
                    <RailFinanceTasksToggle
                      open={financeTasks.open}
                      onToggle={financeTasks.toggle}
                      enabled={financeTasks.enabled}
                    />
                  }
                />
                {financeTasks.open ? <RailFinanceTasks /> : null}
              </div>
            );
          }
          if (mode.id === "education") {
            /* Education carries its tasks on exactly the Finance rules: same row,
               same chevron, same one `h-8`, same nothing-below-when-closed. */
            return (
              <div key={mode.href} className="shrink-0" data-testid="rail-education-mode">
                <RailItem
                  {...itemProps}
                  trailing={
                    <RailEducationTasksToggle
                      open={educationTasks.open}
                      onToggle={educationTasks.toggle}
                      enabled={educationTasks.enabled}
                    />
                  }
                />
                {educationTasks.open ? <RailEducationTasks /> : null}
              </div>
            );
          }
          return (
            <div key={mode.href} className="shrink-0" data-testid="rail-market-mode">
              {/* Exactly one `h-8` row, like any other job mode: the chevron rides
                  inside it, and when the list is closed nothing renders below. */}
              <RailItem
                {...itemProps}
                trailing={
                  <RailMarketSpecialistsToggle
                    open={marketSpecialists.open}
                    onToggle={marketSpecialists.toggle}
                    enabled={marketSpecialists.enabled}
                  />
                }
              />
              {marketSpecialists.open ? <RailMarketSpecialists /> : null}
            </div>
          );
        })}

        {/* The Account group is pinned to the bottom edge of the scrolling nav (`.rail-pinned`).
            The rail is about 830px of rows, and a laptop window is 700 to 900px, so the group that
            used to sit last fell out of reach: at 1366x768 all five rows were below the fold and at
            900px Settings was half under the footer. Pinned, Settings is on screen at any height and
            the job modes scroll behind it; the fade above it (`data-more`) says there are more. */}
        <div className="rail-pinned shrink-0 pb-2" data-testid="rail-account-group" data-more={moreBelow}>
          <RailGroupLabel collapsed={collapsed}>{t("rail.groupAccount")}</RailGroupLabel>
          <RailItem
            href="/knowledge"
            label={t("rail.knowledge")}
            icon="knowledge"
            active={pathname.startsWith("/knowledge")}
            collapsed={collapsed}
            testId="mode-knowledge"
            index={itemIndex++}
          />
          <RailItem
            href="/channels"
            label={t("rail.channels")}
            icon="channels"
            active={pathname.startsWith("/channels")}
            collapsed={collapsed}
            testId="channels-link"
            index={itemIndex++}
          />
          <RailItem
            href="/workspaces"
            label={t("rail.workspaces")}
            icon="workspaces"
            active={pathname.startsWith("/workspaces")}
            collapsed={collapsed}
            testId="workspaces-link"
            index={itemIndex++}
          />
          <RailItem
            href="/usage"
            label={t("rail.usage")}
            icon="usage"
            active={pathname.startsWith("/usage")}
            collapsed={collapsed}
            testId="usage-link"
            index={itemIndex++}
          />
          <RailItem
            href="/settings"
            label={t("rail.settings")}
            icon="settings"
            active={pathname.startsWith("/settings")}
            collapsed={collapsed}
            testId="settings-link"
            index={itemIndex++}
          />
        </div>
        <DeskBuddyDock collapsed={collapsed} />
      </nav>

      <div
        /* Icon-only, one row, both states (owner ruling 2026-09-23). The footer
           is chrome, not content: a theme label, an update label and a
           "Collapse navigation" label cannot share 167px at the narrowest rail,
           and wrapping them into three stacked rows was worse than the overlap
           it replaced. Every control is a 32px square, the row is a single
           `justify-between`, and the words survive in `aria-label`/`title`.
           The update button is the one exception: it keeps its label while a
           release is actually available (`expanded`), because that is the only
           state where it has something to say. */
        className={`flex shrink-0 items-center border-t border-[var(--rail-line)] p-2 ${collapsed ? "flex-col gap-2" : "justify-between gap-2"}`}
        data-testid="rail-footer"
      >
        <ThemeToggle />
        <DeskBuddyChip />
        <div className={`flex items-center gap-2 ${collapsed ? "flex-col" : "min-w-0 flex-1 justify-end"}`}>
          <AppUpdatesButton collapsed={collapsed} />
          <button
            type="button"
            className="btn btn-ghost btn-icon h-8 w-8 shrink-0 rounded-md wash text-[var(--rail-text-2)] hover:bg-[var(--rail-hover)] hover:text-[var(--rail-active-text)]"
            onClick={toggleCollapsed}
            data-testid={collapsed ? "rail-expand" : "rail-collapse"}
            aria-label={collapsed ? t("rail.expand") : t("rail.collapse")}
            title={collapsed ? t("rail.expand") : t("rail.collapse")}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <rect x="3" y="3" width="18" height="18" />
              <path d="M9 3v18" />
            </svg>
          </button>
        </div>
      </div>
      {collapsed ? null : (
        <PanelResizeHandle
          width={railWidth}
          min={RAIL_WIDTH.min}
          max={RAIL_WIDTH.max}
          onWidth={setRailWidth}
          label={t("rail.resize")}
          testId="rail-resize"
        />
      )}
    </aside>
  );
}
