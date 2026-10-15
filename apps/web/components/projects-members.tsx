"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { PeoplePicker } from "@/components/projects-people-picker";
import { isHostedBuild } from "@/lib/hosted-build";
import { t } from "@/lib/i18n";
import { personName } from "@/lib/people-names";
import {
  bringProjectAgent,
  handOverProject,
  inviteProjectMember,
  listInvitablePeople,
  listProjectPeople,
  ProjectsError,
  removeProjectMember,
  setProjectMemberRole,
  takeOutProjectAgent,
  type AssignableRole,
  type InvitablePerson,
  type ProjectMember,
  type ProjectPeople,
  type ProjectRecord,
} from "@/lib/projects-client";
import { agentsToBring, canManage, canTakeOutAgent, memberActions } from "@/lib/projects-view";
import { useVirtualAgents, virtualAgentName, type VirtualAgentInfo } from "@/lib/virtual-agents";

/** What the view asks the container to do. Each one goes to the host, which decides. */
export type MembersActions = {
  readonly invite: (userId: string) => void;
  readonly setRole: (member: ProjectMember, role: AssignableRole) => void;
  readonly remove: (member: ProjectMember) => void;
  readonly handOver: (member: ProjectMember) => void;
  readonly leave: () => void;
  readonly bring: (agentId: string) => void;
  readonly takeOut: (agentId: string) => void;
};

type ViewProps = {
  readonly project: ProjectRecord;
  readonly me: string | null;
  readonly people: ProjectPeople | null;
  readonly loadFailed: boolean;
  readonly candidates: readonly InvitablePerson[] | null;
  readonly candidatesFailed: boolean;
  readonly deskAgents: readonly Pick<VirtualAgentInfo, "id" | "generalist">[];
  readonly busy: boolean;
  readonly error: string | null;
  readonly actions: MembersActions;
};

function agentName(agentId: string): string {
  return virtualAgentName({ id: agentId as VirtualAgentInfo["id"], generalist: false }, "");
}

function labelOf(people: ProjectPeople, userId: string, me: string | null): string {
  const found = people.members.find((member) => member.userId === userId);
  const name = personName({ userId, name: found?.name ?? null });
  return userId === me ? `${name} (${t("projects.members.you")})` : name;
}

/** The people and agents of a Workspace, drawn from what the host answered, with the buttons the caller's role allows. */
export function ProjectMembersView({
  project,
  me,
  people,
  loadFailed,
  candidates,
  candidatesFailed,
  deskAgents,
  busy,
  error,
  actions,
}: ViewProps) {
  const [pick, setPick] = useState("");

  if (!people) {
    return (
      <p className="projects-status" role="status" data-testid="projects-members-status">
        {loadFailed ? t("projects.members.loadFailed") : t("projects.members.loading")}
      </p>
    );
  }

  const viewer = me ? { userId: me, role: project.role } : null;
  const bringable = agentsToBring(deskAgents, people.agents);
  const chosen = bringable.some((agent) => agent.id === pick) ? pick : (bringable[0]?.id ?? "");

  function submitBring(event: FormEvent) {
    event.preventDefault();
    if (chosen) {
      actions.bring(chosen);
    }
  }

  return (
    <div className="projects-members" data-testid="projects-members">
      {error ? (
        <p className="projects-error" role="alert" data-testid="projects-members-error">
          {error}
        </p>
      ) : null}

      <section className="projects-members-section">
        <h3 className="projects-group-title">{t("projects.members.heading")}</h3>
        <p className="projects-note">{t("projects.members.note")}</p>
        <ul className="projects-file-list">
          {people.members.map((member) => {
            const can = memberActions(viewer, member);
            const label = labelOf(people, member.userId, me);
            return (
              <li
                key={member.userId}
                className="projects-member"
                data-testid="projects-member"
                data-role={member.role}
                data-user={member.userId}
              >
                <span className="projects-file-main">
                  <span className="projects-file-title">{label}</span>
                  <span className="projects-file-meta">{t(`projects.roles.${member.role}`)}</span>
                </span>
                <span className="projects-file-actions">
                  {can.setRole ? (
                    <select
                      className="input projects-role-select"
                      value={member.role}
                      disabled={busy}
                      aria-label={t("projects.members.roleOf", { name: label })}
                      onChange={(event) => actions.setRole(member, event.target.value as AssignableRole)}
                      data-testid="projects-member-role"
                    >
                      <option value="admin">{t("projects.roles.admin")}</option>
                      <option value="member">{t("projects.roles.member")}</option>
                    </select>
                  ) : null}
                  {can.handOver ? (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={busy}
                      onClick={() => actions.handOver(member)}
                      data-testid="projects-member-handover"
                    >
                      {t("projects.members.handOver")}
                    </button>
                  ) : null}
                  {can.remove ? (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={busy}
                      onClick={() => actions.remove(member)}
                      data-testid="projects-member-remove"
                    >
                      {t("projects.members.remove")}
                    </button>
                  ) : null}
                  {can.leave ? (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={busy}
                      onClick={actions.leave}
                      data-testid="projects-member-leave"
                    >
                      {t("projects.members.leave")}
                    </button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>

        {canManage(project.role) ? (
          <PeoplePicker people={candidates} loadFailed={candidatesFailed} busy={busy} onInvite={actions.invite} />
        ) : null}
      </section>

      <section className="projects-members-section">
        <h3 className="projects-group-title">{t("projects.agents.heading")}</h3>
        <p className="projects-note">{t("projects.agents.note")}</p>
        {people.agents.length === 0 ? (
          <p className="projects-status" data-testid="projects-agents-empty">
            {t("projects.agents.empty")}
          </p>
        ) : (
          <ul className="projects-file-list">
            {people.agents.map((agent) => (
              <li
                key={`${agent.agentId}:${agent.broughtBy}`}
                className="projects-member"
                data-testid="projects-agent"
                data-agent={agent.agentId}
              >
                <span className="projects-file-main">
                  <span className="projects-file-title">{agentName(agent.agentId)}</span>
                  <span className="projects-file-meta">
                    {t("projects.agents.broughtBy", { name: labelOf(people, agent.broughtBy, me) })}
                  </span>
                </span>
                <span className="projects-file-actions">
                  {canTakeOutAgent(agent, project.role, me) ? (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={busy}
                      onClick={() => actions.takeOut(agent.agentId)}
                      data-testid="projects-agent-takeout"
                    >
                      {t("projects.agents.takeOut")}
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        {bringable.length > 0 ? (
          <form className="projects-inline-form" onSubmit={submitBring}>
            <select
              className="input"
              value={chosen}
              aria-label={t("projects.agents.pickLabel")}
              onChange={(event) => setPick(event.target.value)}
              data-testid="projects-agent-pick"
            >
              {bringable.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agentName(agent.id)}
                </option>
              ))}
            </select>
            <button type="submit" className="btn btn-secondary" disabled={busy} data-testid="projects-agent-bring">
              {t("projects.agents.bring")}
            </button>
          </form>
        ) : (
          <p className="projects-note" data-testid="projects-agents-none">
            {t("projects.agents.noneToBring")}
          </p>
        )}
      </section>
    </div>
  );
}

function messageOf(error: unknown): string {
  return error instanceof ProjectsError && error.message ? error.message : t("projects.saveFailed");
}

type PanelProps = {
  readonly project: ProjectRecord;
  readonly me: string | null;
  /** The caller's own standing changed (a hand-over, an invite): read the Workspace again. */
  readonly onChanged: () => void;
  /** The caller left: the Workspace is gone for them. */
  readonly onLeft: () => void;
};

/**
 * The Members tab. Hosted only: on Personal a desk has one person and no Workspaces, and this draws nothing.
 * It reads the host's answer and sends each action back; every refusal is the host's own sentence.
 */
export function ProjectMembersPanel(props: PanelProps) {
  if (!isHostedBuild()) {
    return null;
  }
  return <MembersContainer {...props} />;
}

function MembersContainer({ project, me, onChanged, onLeft }: PanelProps) {
  const { agents: deskAgents } = useVirtualAgents();
  const [people, setPeople] = useState<ProjectPeople | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [candidates, setCandidates] = useState<InvitablePerson[] | null>(null);
  const [candidatesFailed, setCandidatesFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setPeople(await listProjectPeople(project.id));
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
    if (!canManage(project.role)) {
      return;
    }
    try {
      setCandidates(await listInvitablePeople(project.id));
      setCandidatesFailed(false);
    } catch {
      setCandidatesFailed(true);
    }
  }, [project.id, project.role]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(work: () => Promise<unknown>, after: "reload" | "left" = "reload") {
    setBusy(true);
    setError(null);
    try {
      await work();
      if (after === "left") {
        onLeft();
        return;
      }
      await reload();
      onChanged();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  const actions: MembersActions = {
    invite: (userId) => void run(() => inviteProjectMember(project.id, userId)),
    setRole: (member, role) => void run(() => setProjectMemberRole(project.id, member.userId, role)),
    remove: (member) => void run(() => removeProjectMember(project.id, member.userId)),
    handOver: (member) => {
      if (window.confirm(t("projects.members.confirmHandOver", { name: personName(member) }))) {
        void run(() => handOverProject(project.id, member.userId));
      }
    },
    leave: () => {
      if (me && window.confirm(t("projects.members.confirmLeave"))) {
        void run(() => removeProjectMember(project.id, me), "left");
      }
    },
    bring: (agentId) => void run(() => bringProjectAgent(project.id, agentId)),
    takeOut: (agentId) => void run(() => takeOutProjectAgent(project.id, agentId)),
  };

  return (
    <ProjectMembersView
      project={project}
      me={me}
      people={people}
      loadFailed={loadFailed}
      candidates={candidates}
      candidatesFailed={candidatesFailed}
      deskAgents={deskAgents}
      busy={busy}
      error={error}
      actions={actions}
    />
  );
}
