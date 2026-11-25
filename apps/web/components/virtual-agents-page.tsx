"use client";

import { useCallback, useEffect, useState } from "react";
import { PRODUCT_MODES, type ProductMode } from "@agentforge/core/product-modes";
import { ModeHeader } from "@/components/mode-header";
import { isModeIconName, ModeIcon } from "@/components/mode-icons";
import { apiFetch } from "@/lib/api-client";
import { t } from "@/lib/i18n";
import { Link, useRouter } from "@/lib/nav";
import { assistantNameOf, useProductBrand } from "@/lib/product-brand";
import {
  fetchVirtualAgentCatalog,
  notifyVirtualAgentsChanged,
  studioHref,
  virtualAgentHref,
  virtualAgentName,
  virtualAgentTagline,
  type VirtualAgentInfo,
} from "@/lib/virtual-agents";
import "@/components/virtual-agents-page.css";

/**
 * The page where a person hires agents onto their desk or lets them go (tester code, chat-first plan
 * track B). It replaces the Workspaces page in this shell: a desk is still how the host stores the
 * choice (its `productModes`), but creating, switching, renaming and deleting desks is not offered here.
 *
 * The host decides which agents there are and what each is made of; this page only changes which
 * modes the current desk lists, through the same `PATCH /api/v1/workspaces/:id` the Workspaces page
 * sends, and then reads the catalog again.
 */

export type DeskAction = "hire" | "letGo";

/**
 * The desk's mode list after hiring or letting go one agent. Catalog order, `chat` always kept (the
 * generalist cannot be let go), and a no-op when the mode is already in (or already out of) the list.
 */
export function nextDeskModes(current: readonly ProductMode[], modeId: ProductMode, action: DeskAction): ProductMode[] {
  const next = new Set<ProductMode>(current);
  if (action === "hire") {
    next.add(modeId);
  } else if (modeId !== "chat") {
    next.delete(modeId);
  }
  next.add("chat");
  return PRODUCT_MODES.map((mode) => mode.id).filter((id) => next.has(id));
}

function skillsLabel(agent: VirtualAgentInfo): string {
  const count = agent.skills.filter((skill) => skill.status !== "off").length;
  return count === 1 ? t("agents.page.skillsCountOne") : t("agents.page.skillsCount", { n: count });
}

type CardProps = {
  agent: VirtualAgentInfo;
  productName: string;
  /** The mode id whose request is in flight, if any. Every button is disabled while one is. */
  busyId: ProductMode | null;
  kind: "desk" | "available";
  onHire: (agent: VirtualAgentInfo) => void;
  onLetGo: (agent: VirtualAgentInfo) => void;
};

function AgentCard({ agent, productName, busyId, kind, onHire, onLetGo }: CardProps) {
  const name = virtualAgentName(agent, productName);
  const busy = busyId === agent.id;
  return (
    <li
      className="va-card"
      data-testid="agent-card"
      data-agent={agent.id}
      data-mode={agent.id}
      data-conversation={agent.conversation}
    >
      <div className="va-card-head">
        <span className="va-tile" aria-hidden="true">
          <ModeIcon name={isModeIconName(agent.id) ? agent.id : "chat"} size={20} strokeWidth={2} />
        </span>
        <h3 className="va-name">{name}</h3>
      </div>
      <p className="va-tagline">{virtualAgentTagline(agent)}</p>
      <p className="va-facts">
        <span>{skillsLabel(agent)}</span>
        <span className="va-pill" data-testid="agent-kind">
          {agent.conversation === "harness" ? t("agents.page.converses") : t("agents.page.studio")}
        </span>
      </p>
      <div className="va-actions">
        {kind === "desk" ? (
          <>
            <Link
              href={virtualAgentHref(agent.id)}
              className="va-open"
              data-testid="agent-open"
              aria-label={t("agents.home.ask", { name })}
            >
              {t("agents.page.open")}
            </Link>
            {!agent.generalist ? (
              <Link
                href={studioHref(agent.id)}
                className="va-open"
                data-testid="agent-open-dashboard"
                aria-label={t("agents.page.openDashboardAria", { name })}
              >
                {t("agents.page.openDashboard")}
              </Link>
            ) : null}
          </>
        ) : null}
        {kind === "available" ? (
          <button
            type="button"
            className="va-btn va-btn-primary"
            data-testid="agent-hire"
            aria-label={t("agents.page.hireAria", { name })}
            disabled={busyId !== null}
            onClick={() => onHire(agent)}
          >
            {busy ? t("agents.page.hiring") : t("agents.page.hire")}
          </button>
        ) : agent.generalist ? (
          <span className="va-always" data-testid="agent-always">
            {t("agents.page.always")}
          </span>
        ) : (
          <button
            type="button"
            className="va-btn va-btn-secondary"
            data-testid="agent-let-go"
            aria-label={t("agents.page.letGoAria", { name })}
            disabled={busyId !== null}
            onClick={() => onLetGo(agent)}
          >
            {busy ? t("agents.page.lettingGo") : t("agents.page.letGo")}
          </button>
        )}
      </div>
    </li>
  );
}

export type VirtualAgentsViewProps = {
  agents: readonly VirtualAgentInfo[];
  available: readonly VirtualAgentInfo[];
  /** False until the catalog has answered once, so "none available" does not flash before it. */
  loaded?: boolean;
  busyId: ProductMode | null;
  error: string | null;
  productName: string;
  onHire: (agent: VirtualAgentInfo) => void;
  onLetGo: (agent: VirtualAgentInfo) => void;
};

/** The page's markup with no data fetching, so tests and the page share one body. */
export function VirtualAgentsView({
  agents,
  available,
  loaded = true,
  busyId,
  error,
  productName,
  onHire,
  onLetGo,
}: VirtualAgentsViewProps) {
  return (
    <main
      className="va-page"
      data-mode="workspaces"
      data-testid="virtual-agents-page"
      aria-busy={loaded ? undefined : true}
    >
      <ModeHeader
        icon="workspaces"
        title={t("agents.page.title")}
        shapes={false}
        outcomeTestId="virtual-agents-lede"
        outcome={t("agents.page.lede")}
      />
      {error ? (
        <p className="va-error" role="alert" data-testid="virtual-agents-error">
          {error}
        </p>
      ) : null}
      {loaded ? (
        <>
          <section className="va-section" aria-labelledby="va-on-desk" data-testid="agents-on-desk">
            <h2 className="va-section-title" id="va-on-desk">
              {t("agents.page.onDesk")}
            </h2>
            <ul className="va-grid">
              {agents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  productName={productName}
                  busyId={busyId}
                  kind="desk"
                  onHire={onHire}
                  onLetGo={onLetGo}
                />
              ))}
            </ul>
          </section>
          <section className="va-section" aria-labelledby="va-available" data-testid="agents-available">
            <h2 className="va-section-title" id="va-available">
              {t("agents.page.available")}
            </h2>
            {available.length === 0 ? (
              <p className="va-empty" data-testid="agents-none-available">
                {t("agents.page.noneAvailable")}
              </p>
            ) : (
              <ul className="va-grid">
                {available.map((agent) => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    productName={productName}
                    busyId={busyId}
                    kind="available"
                    onHire={onHire}
                    onLetGo={onLetGo}
                  />
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </main>
  );
}

type Desk = { id: string; name: string; productModes: ProductMode[] };

/** The current desk out of `GET /api/v1/workspaces`, or null when the answer names none. */
function readCurrentDesk(payload: unknown): Desk | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const body = payload as { currentWorkspaceId?: unknown; workspaces?: unknown };
  const rows = Array.isArray(body.workspaces) ? body.workspaces : [];
  for (const row of rows) {
    const desk = row as { id?: unknown; name?: unknown; productModes?: unknown };
    if (desk.id === body.currentWorkspaceId && typeof desk.id === "string" && typeof desk.name === "string") {
      const modes = Array.isArray(desk.productModes) ? (desk.productModes as ProductMode[]) : [];
      return { id: desk.id, name: desk.name, productModes: modes };
    }
  }
  return null;
}

export function VirtualAgentsPage() {
  const router = useRouter();
  // The view's `productName` is only ever the default agent's name, which is the brand's character.
  const productName = assistantNameOf(useProductBrand());
  const [agents, setAgents] = useState<VirtualAgentInfo[]>([]);
  const [available, setAvailable] = useState<VirtualAgentInfo[]>([]);
  const [desk, setDesk] = useState<Desk | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<ProductMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadCatalog = useCallback(async () => {
    const catalog = await fetchVirtualAgentCatalog();
    setAgents(catalog.agents);
    setAvailable(catalog.available);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [catalog, deskPayload] = await Promise.all([
          fetchVirtualAgentCatalog(),
          apiFetch("/api/v1/workspaces").then((res) => res.json().catch(() => null)),
        ]);
        if (cancelled) {
          return;
        }
        setAgents(catalog.agents);
        setAvailable(catalog.available);
        setDesk(readCurrentDesk(deskPayload));
        setError(null);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : t("agents.error.load"));
        }
      } finally {
        if (!cancelled) {
          setLoaded(true);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function change(agent: VirtualAgentInfo, action: DeskAction) {
    if (busyId !== null) {
      return;
    }
    if (!desk) {
      // The host named no current desk, so there is nothing to save to.
      setError(t("agents.error.save"));
      return;
    }
    setBusyId(agent.id);
    setError(null);
    try {
      const modes = nextDeskModes(desk.productModes, agent.id, action);
      // The same request the Workspaces page sends to save a desk: its name stays as it is.
      const response = await apiFetch(`/api/v1/workspaces/${desk.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: desk.name, productModes: modes }),
      });
      const saved = await response.json().catch(() => null);
      if (!response.ok || !saved || saved.error || !saved.workspace) {
        throw new Error(t("agents.error.save"));
      }
      const savedModes = Array.isArray(saved.workspace.productModes)
        ? (saved.workspace.productModes as ProductMode[])
        : modes;
      setDesk({ ...desk, productModes: savedModes });
    } catch {
      setError(t("agents.error.save"));
      setBusyId(null);
      return;
    }
    // The desk is saved from here on. A catalog that will not load must not read as a failed save.
    try {
      await loadCatalog();
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("agents.error.load"));
    }
    notifyVirtualAgentsChanged();
    router.refresh();
    setBusyId(null);
  }

  return (
    <VirtualAgentsView
      agents={agents}
      available={available}
      loaded={loaded}
      busyId={busyId}
      error={error}
      productName={productName}
      onHire={(agent) => void change(agent, "hire")}
      onLetGo={(agent) => void change(agent, "letGo")}
    />
  );
}
