import type { ReactNode } from "react";
import { t } from "@/lib/i18n";

export type PanelTab = "ask" | "versions";

const TABS: readonly PanelTab[] = ["ask", "versions"];

const TAB_LABEL_KEY: Readonly<Record<PanelTab, string>> = {
  ask: "docpage.tabs.ask",
  versions: "docpage.tabs.versions",
};

type Props = {
  readonly tab: PanelTab;
  readonly onTab: (tab: PanelTab) => void;
  readonly askPanel: ReactNode;
  readonly versionsPanel: ReactNode;
};

export function SidePanel({ tab, onTab, askPanel, versionsPanel }: Props) {
  return (
    <aside className="doc-side" data-testid="docpage-side">
      <div role="tablist" aria-label={t("docpage.tabs.label")} className="doc-tabs">
        {TABS.map((id) => (
          <button
            key={id}
            id={`docpage-tab-${id}`}
            type="button"
            role="tab"
            aria-selected={tab === id}
            aria-controls={`docpage-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            className="doc-tab"
            data-active={tab === id ? "true" : undefined}
            onClick={() => onTab(id)}
            data-testid={`docpage-tab-${id}`}
          >
            {t(TAB_LABEL_KEY[id])}
          </button>
        ))}
      </div>
      <div
        id="docpage-panel-ask"
        role="tabpanel"
        aria-labelledby="docpage-tab-ask"
        hidden={tab !== "ask"}
        className="doc-panel"
      >
        {askPanel}
      </div>
      <div
        id="docpage-panel-versions"
        role="tabpanel"
        aria-labelledby="docpage-tab-versions"
        hidden={tab !== "versions"}
        className="doc-panel"
      >
        {versionsPanel}
      </div>
    </aside>
  );
}
