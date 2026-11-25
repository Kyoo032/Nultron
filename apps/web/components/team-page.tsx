"use client";

import { useEffect, useState } from "react";
import { PRODUCT_MODE_IDS, type ProductMode } from "@agentforge/core/product-modes";
import { ModeHeader } from "@/components/mode-header";
import { isModeIconName, ModeIcon } from "@/components/mode-icons";
import { t } from "@/lib/i18n";
import { Link, useRouter } from "@/lib/nav";
import {
  hireTeam,
  notifyTeamChanged,
  proposeTeam,
  releaseTeam,
  teamBotHref,
  useTeam,
  type TeamBotInput,
  type TeamBotView,
  type TeamReleaseTarget,
} from "@/lib/team";
import {
  fetchVirtualAgentCatalog,
  virtualAgentName,
  virtualAgentTagline,
  type VirtualAgentInfo,
} from "@/lib/virtual-agents";
import "./team-page.css";

/**
 * The orchestrator demo's home: describe the work, review the proposed team, hire it, then chat with
 * the default agent while it delegates to the specialists and bots on this page. The host owns the
 * roster (`/api/v1/team`); this page only edits the proposal before it is hired.
 */

type BotDraft = {
  readonly key: string;
  name: string;
  role: string;
  prompt: string;
};

type EditorDraft = {
  readonly brief: string;
  readonly modes: Set<ProductMode>;
  readonly bots: BotDraft[];
};

const SPECIALIST_IDS = PRODUCT_MODE_IDS.filter((id) => id !== "chat");

function specialistsOf(catalog: { agents: readonly VirtualAgentInfo[]; available: readonly VirtualAgentInfo[] }) {
  const byId = new Map<ProductMode, VirtualAgentInfo>();
  for (const agent of [...catalog.agents, ...catalog.available]) {
    if (!agent.generalist) {
      byId.set(agent.id, agent);
    }
  }
  return SPECIALIST_IDS.map((id) => byId.get(id)).filter((agent): agent is VirtualAgentInfo => Boolean(agent));
}

function botDraft(bot: TeamBotInput, index: number): BotDraft {
  return { key: `proposal-${index}-${bot.name}`, name: bot.name, role: bot.role, prompt: bot.prompt };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function TeamPage() {
  const router = useRouter();
  const { roster, loaded, error } = useTeam();
  const [specialists, setSpecialists] = useState<readonly VirtualAgentInfo[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [brief, setBrief] = useState("");
  const [composer, setComposer] = useState<"closed" | "brief">("closed");
  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const [custom, setCustom] = useState({ name: "", role: "", prompt: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchVirtualAgentCatalog()
      .then((catalog) => {
        if (!cancelled) {
          setSpecialists(specialistsOf(catalog));
          setCatalogLoaded(true);
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setCatalogError(errorMessage(loadError, t("team.error.load")));
          setCatalogLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rosterModes = roster.modes.filter((mode) => mode !== "chat");
  const hasTeam = rosterModes.length > 0 || roster.bots.length > 0;
  const ready = loaded && catalogLoaded;
  const showBrief = draft === null && (!hasTeam || composer === "brief");
  const customReady = custom.name.trim().length > 0 && custom.role.trim().length > 0 && custom.prompt.trim().length > 0;

  async function buildTeam() {
    const text = brief.trim();
    if (!text || busy !== null) {
      return;
    }
    setBusy("propose");
    setActionError(null);
    try {
      const proposal = await proposeTeam(text);
      const allowed = new Set(specialists.map((agent) => agent.id));
      setDraft({
        brief: proposal.brief || text,
        modes: new Set(proposal.modes.filter((mode) => allowed.has(mode))),
        bots: proposal.bots.map(botDraft),
      });
      setComposer("closed");
    } catch (error) {
      setActionError(errorMessage(error, t("team.error.propose")));
    } finally {
      setBusy(null);
    }
  }

  function toggleMode(mode: ProductMode, checked: boolean) {
    setDraft((current) => {
      if (!current) {
        return current;
      }
      const modes = new Set(current.modes);
      if (checked) {
        modes.add(mode);
      } else {
        modes.delete(mode);
      }
      return { ...current, modes };
    });
  }

  function updateBot(key: string, field: "name" | "role" | "prompt", value: string) {
    setDraft((current) =>
      current
        ? { ...current, bots: current.bots.map((bot) => (bot.key === key ? { ...bot, [field]: value } : bot)) }
        : current,
    );
  }

  function removeBot(key: string) {
    setDraft((current) => (current ? { ...current, bots: current.bots.filter((bot) => bot.key !== key) } : current));
  }

  function addCustomBot() {
    if (!customReady || draft === null) {
      return;
    }
    setDraft({
      ...draft,
      bots: [
        ...draft.bots,
        {
          key: `custom-${crypto.randomUUID()}`,
          name: custom.name.trim(),
          role: custom.role.trim(),
          prompt: custom.prompt.trim(),
        },
      ],
    });
    setCustom({ name: "", role: "", prompt: "" });
  }

  const botsReady = draft?.bots.every((bot) => bot.name.trim().length > 0 && bot.role.trim().length > 0) ?? true;
  const canHire = draft !== null && (draft.modes.size > 0 || draft.bots.length > 0) && botsReady;

  async function hire() {
    if (!draft || !canHire || busy !== null) {
      return;
    }
    const modes = [...draft.modes];
    const bots: TeamBotInput[] = draft.bots.map((bot) => ({
      name: bot.name.trim(),
      role: bot.role.trim(),
      prompt: bot.prompt.trim(),
    }));
    setBusy("hire");
    setActionError(null);
    try {
      await hireTeam({ modes, bots });
      notifyTeamChanged();
      router.refresh();
      setDraft(null);
      setComposer("closed");
      setBrief("");
    } catch (error) {
      setActionError(errorMessage(error, t("team.error.hire")));
    } finally {
      setBusy(null);
    }
  }

  async function release(target: TeamReleaseTarget, key: string) {
    if (busy !== null) {
      return;
    }
    setBusy(key);
    setActionError(null);
    try {
      await releaseTeam(target);
      notifyTeamChanged();
      router.refresh();
    } catch (error) {
      setActionError(errorMessage(error, t("team.error.release")));
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="team-page" data-testid="team-page">
      <ModeHeader
        icon="workspaces"
        title={t("team.page.title")}
        shapes={false}
        outcome={t("team.page.lede")}
        outcomeTestId="team-lede"
      />
      {error || catalogError || actionError ? (
        <p className="team-error" role="alert" data-testid="team-error">
          {actionError ?? catalogError ?? error}
        </p>
      ) : null}
      {!ready ? (
        <p className="team-loading" data-testid="team-loading">
          {t("team.page.loading")}
        </p>
      ) : draft ? (
        <TeamEditor
          draft={draft}
          specialists={specialists}
          custom={custom}
          customReady={customReady}
          canHire={canHire}
          busy={busy}
          onToggleMode={toggleMode}
          onUpdateBot={updateBot}
          onRemoveBot={removeBot}
          onCustomChange={(field, value) => setCustom((current) => ({ ...current, [field]: value }))}
          onAddCustom={addCustomBot}
          onHire={() => void hire()}
        />
      ) : showBrief ? (
        <TeamBrief
          hasTeam={hasTeam}
          brief={brief}
          busy={busy === "propose"}
          disabled={busy !== null || brief.trim().length === 0}
          onBriefChange={setBrief}
          onBuild={() => void buildTeam()}
        />
      ) : (
        <TeamRoster
          modes={rosterModes}
          bots={roster.bots}
          busy={busy}
          onRelease={release}
          onAdd={() => setComposer("brief")}
        />
      )}
    </main>
  );
}

type BriefProps = {
  hasTeam: boolean;
  brief: string;
  busy: boolean;
  disabled: boolean;
  onBriefChange: (value: string) => void;
  onBuild: () => void;
};

function TeamBrief({ hasTeam, brief, busy, disabled, onBriefChange, onBuild }: BriefProps) {
  return (
    <section className="team-brief card-live" data-testid="team-brief">
      <h2 className="team-section-title">{hasTeam ? t("team.brief.addTitle") : t("team.brief.title")}</h2>
      <p className="team-hint">{t("team.brief.hint")}</p>
      <form
        className="team-brief-form"
        onSubmit={(event) => {
          event.preventDefault();
          onBuild();
        }}
      >
        <label className="field">
          <span className="label">{t("team.brief.label")}</span>
          <textarea
            className="team-brief-input"
            rows={4}
            value={brief}
            placeholder={t("team.brief.placeholder")}
            onChange={(event) => onBriefChange(event.target.value)}
            data-testid="team-brief-input"
          />
        </label>
        <p className="team-examples">{t("team.brief.examples")}</p>
        <div className="team-actions">
          <button type="submit" className="btn btn-primary" disabled={disabled} data-testid="team-build">
            {busy ? t("team.brief.building") : t("team.brief.build")}
          </button>
        </div>
      </form>
    </section>
  );
}

type EditorProps = {
  draft: EditorDraft;
  specialists: readonly VirtualAgentInfo[];
  custom: { name: string; role: string; prompt: string };
  customReady: boolean;
  canHire: boolean;
  busy: string | null;
  onToggleMode: (mode: ProductMode, checked: boolean) => void;
  onUpdateBot: (key: string, field: "name" | "role" | "prompt", value: string) => void;
  onRemoveBot: (key: string) => void;
  onCustomChange: (field: "name" | "role" | "prompt", value: string) => void;
  onAddCustom: () => void;
  onHire: () => void;
};

function TeamEditor({
  draft,
  specialists,
  custom,
  customReady,
  canHire,
  busy,
  onToggleMode,
  onUpdateBot,
  onRemoveBot,
  onCustomChange,
  onAddCustom,
  onHire,
}: EditorProps) {
  return (
    <section className="team-editor" data-testid="team-editor">
      <div className="team-editor-head">
        <h2 className="team-section-title">{t("team.editor.title")}</h2>
        <p className="team-hint">{t("team.editor.lede")}</p>
      </div>

      <section className="team-editor-section" aria-labelledby="team-specialists-title">
        <h3 className="team-subsection-title" id="team-specialists-title">
          {t("team.editor.specialists")}
        </h3>
        <div className="team-specialists">
          {specialists.map((agent) => (
            <label className="team-specialist card-live" key={agent.id} data-mode={agent.id}>
              <input
                type="checkbox"
                checked={draft.modes.has(agent.id)}
                onChange={(event) => onToggleMode(agent.id, event.target.checked)}
                data-testid={`team-specialist-${agent.id}`}
              />
              <span className="team-specialist-text">
                <strong>{virtualAgentName(agent, "")}</strong>
                <span>{virtualAgentTagline(agent)}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="team-editor-section" aria-labelledby="team-bots-title">
        <h3 className="team-subsection-title" id="team-bots-title">
          {t("team.editor.bots")}
        </h3>
        {draft.bots.length === 0 ? (
          <p className="team-empty" data-testid="team-no-bots">
            {t("team.editor.noBots")}
          </p>
        ) : (
          <ul className="team-bot-list">
            {draft.bots.map((bot) => (
              <li className="team-bot card-live" key={bot.key} data-testid="team-bot-draft">
                <div className="team-bot-fields">
                  <label className="field">
                    <span className="label">{t("team.editor.name")}</span>
                    <input
                      className="input"
                      value={bot.name}
                      onChange={(event) => onUpdateBot(bot.key, "name", event.target.value)}
                      data-testid="team-bot-name"
                    />
                  </label>
                  <label className="field">
                    <span className="label">{t("team.editor.role")}</span>
                    <input
                      className="input"
                      value={bot.role}
                      onChange={(event) => onUpdateBot(bot.key, "role", event.target.value)}
                      data-testid="team-bot-role"
                    />
                  </label>
                </div>
                <details className="team-bot-prompt">
                  <summary>{t("team.editor.prompt")}</summary>
                  <p>{bot.prompt.trim().length > 0 ? bot.prompt : t("team.editor.noPrompt")}</p>
                </details>
                <div className="team-bot-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => onRemoveBot(bot.key)}
                    aria-label={t("team.editor.removeAria", { name: bot.name || t("team.editor.unnamed") })}
                    data-testid="team-bot-remove"
                  >
                    {t("team.editor.remove")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="team-custom card-live" data-testid="team-custom-bot">
          <h4 className="team-custom-title">{t("team.editor.addBot")}</h4>
          <div className="team-bot-fields">
            <label className="field">
              <span className="label">{t("team.editor.name")}</span>
              <input
                className="input"
                value={custom.name}
                onChange={(event) => onCustomChange("name", event.target.value)}
                data-testid="team-custom-name"
              />
            </label>
            <label className="field">
              <span className="label">{t("team.editor.role")}</span>
              <input
                className="input"
                value={custom.role}
                onChange={(event) => onCustomChange("role", event.target.value)}
                data-testid="team-custom-role"
              />
            </label>
          </div>
          <label className="field">
            <span className="label">{t("team.editor.prompt")}</span>
            <textarea
              className="input team-custom-prompt"
              rows={3}
              value={custom.prompt}
              onChange={(event) => onCustomChange("prompt", event.target.value)}
              data-testid="team-custom-prompt"
            />
          </label>
          <div className="team-actions">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!customReady}
              onClick={onAddCustom}
              data-testid="team-custom-add"
            >
              {t("team.editor.add")}
            </button>
          </div>
        </div>
      </section>

      <div className="team-editor-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy !== null || !canHire}
          onClick={onHire}
          data-testid="team-hire"
        >
          {busy === "hire" ? t("team.editor.hiring") : t("team.editor.hire")}
        </button>
        <p className="team-hint">{t("team.editor.hireHint")}</p>
      </div>
    </section>
  );
}

type RosterProps = {
  modes: readonly ProductMode[];
  bots: readonly TeamBotView[];
  busy: string | null;
  onRelease: (target: TeamReleaseTarget, key: string) => void;
  onAdd: () => void;
};

function TeamRoster({ modes, bots, busy, onRelease, onAdd }: RosterProps) {
  return (
    <section className="team-roster" data-testid="team-roster">
      <div className="team-roster-head">
        <div>
          <h2 className="team-section-title">{t("team.roster.title")}</h2>
          <p className="team-hint">{t("team.roster.hint")}</p>
        </div>
        <div className="team-actions">
          <Link href="/chat" className="btn btn-primary" data-testid="team-chat">
            {t("team.roster.chat")}
          </Link>
          <button type="button" className="btn btn-secondary" onClick={onAdd} data-testid="team-add">
            {t("team.roster.add")}
          </button>
        </div>
      </div>

      <section className="team-editor-section" aria-labelledby="team-roster-specialists">
        <h3 className="team-subsection-title" id="team-roster-specialists">
          {t("team.roster.specialists")}
        </h3>
        {modes.length === 0 ? (
          <p className="team-empty">{t("team.roster.noSpecialists")}</p>
        ) : (
          <ul className="team-roster-grid">
            {modes.map((mode) => {
              const name = virtualAgentName({ id: mode, generalist: false }, "");
              return (
                <li className="team-roster-card card-live" key={mode} data-mode={mode} data-testid="team-member">
                  <div className="team-member-head">
                    <span className="team-tile" aria-hidden="true">
                      <ModeIcon name={isModeIconName(mode) ? mode : "chat"} size={20} strokeWidth={2} />
                    </span>
                    <div>
                      <h4>{name}</h4>
                      <p>{t(`agents.tagline.${mode}`)}</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy !== null}
                    onClick={() => onRelease({ mode }, `mode:${mode}`)}
                    aria-label={t("team.roster.letGoAria", { name })}
                    data-testid="team-let-go"
                  >
                    {busy === `mode:${mode}` ? t("team.roster.lettingGo") : t("team.roster.letGo")}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {bots.length > 0 ? (
        <section className="team-editor-section" aria-labelledby="team-roster-bots">
          <h3 className="team-subsection-title" id="team-roster-bots">
            {t("team.roster.bots")}
          </h3>
          <ul className="team-roster-grid">
            {bots.map((bot) => (
              <li className="team-roster-card card-live" key={bot.id} data-testid="team-bot">
                <div className="team-member-head">
                  <span className="team-tile team-tile-bot" aria-hidden="true">
                    <ModeIcon name="chat" size={20} strokeWidth={2} />
                  </span>
                  <div>
                    <h4>{bot.name}</h4>
                    <p>{bot.role || bot.description}</p>
                  </div>
                </div>
                <div className="team-actions">
                  <Link href={teamBotHref(bot.slug)} className="btn btn-secondary" data-testid="team-bot-open">
                    {t("team.roster.open")}
                  </Link>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy !== null}
                    onClick={() => onRelease({ bot: bot.slug }, `bot:${bot.slug}`)}
                    aria-label={t("team.roster.letGoAria", { name: bot.name })}
                    data-testid="team-let-go"
                  >
                    {busy === `bot:${bot.slug}` ? t("team.roster.lettingGo") : t("team.roster.letGo")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
