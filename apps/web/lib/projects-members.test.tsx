/**
 * The Members tab of a Workspace (K-D22, K-D23). It draws only on the hosted build, and shows each button only to a
 * role the host lets press it. The host decides every action; these tests check what is drawn.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectMembersPanel, ProjectMembersView, type MembersActions } from "@/components/projects-members";
import { applyLocale, resetLocaleForTests } from "@/lib/i18n";
import type {
  InvitablePerson,
  ProjectMember,
  ProjectPeople,
  ProjectRecord,
  WorkspaceRole,
} from "@/lib/projects-client";
import { agentsToBring, canTakeOutAgent, memberActions } from "@/lib/projects-view";

afterEach(() => {
  vi.unstubAllGlobals();
  resetLocaleForTests();
});

const hosted = () => vi.stubGlobal("__AGENTFORGE_SERVER__", "1");

const member = (userId: string, role: WorkspaceRole): ProjectMember => ({
  userId,
  name: userId,
  role,
  addedBy: "ana",
  addedAt: 1,
});

const PEOPLE: ProjectPeople = {
  members: [member("ana", "owner"), member("budi", "admin"), member("citra", "member")],
  agents: [
    { agentId: "research", broughtBy: "ana", addedAt: 2 },
    { agentId: "documents", broughtBy: "citra", addedAt: 3 },
  ],
};

const DESK = [
  { id: "chat", generalist: true },
  { id: "research", generalist: false },
  { id: "documents", generalist: false },
  { id: "images", generalist: false },
] as const;

const project = (role: WorkspaceRole): ProjectRecord => ({
  id: "proj_1",
  name: "Launch",
  role,
  memberCount: 3,
  createdBy: "ana",
  createdAt: 1,
  updatedAt: 2,
});

const NOOP: MembersActions = {
  invite: () => {},
  setRole: () => {},
  remove: () => {},
  handOver: () => {},
  leave: () => {},
  bring: () => {},
  takeOut: () => {},
};

const COLLEAGUES: InvitablePerson[] = [
  { userId: "dewi", name: "Dewi" },
  { userId: "eko", name: "Eko" },
];

function view(
  me: string,
  role: WorkspaceRole,
  people: ProjectPeople | null = PEOPLE,
  candidates: InvitablePerson[] | null = COLLEAGUES,
  candidatesFailed = false,
): string {
  return renderToStaticMarkup(
    <ProjectMembersView
      project={project(role)}
      me={me}
      people={people}
      loadFailed={false}
      candidates={candidates}
      candidatesFailed={candidatesFailed}
      deskAgents={DESK}
      busy={false}
      error={null}
      actions={NOOP}
    />,
  );
}

/** The `data-testid`s inside one member's row, in order. */
function rowControls(html: string, userId: string): string[] {
  const start = html.indexOf(`data-user="${userId}"`);
  const end = html.indexOf("</li>", start);
  return [...html.slice(start, end).matchAll(/data-testid="(projects-member-[a-z]+)"/g)].map((match) => match[1]);
}

describe("member rules", () => {
  it("the owner sets roles, hands over and removes anyone but herself, and cannot leave", () => {
    const ana = { userId: "ana", role: "owner" as const };
    expect(memberActions(ana, member("ana", "owner"))).toEqual({
      setRole: false,
      handOver: false,
      remove: false,
      leave: false,
    });
    expect(memberActions(ana, member("budi", "admin"))).toEqual({
      setRole: true,
      handOver: true,
      remove: true,
      leave: false,
    });
  });

  it("an admin removes plain members only, never the owner or another admin, and may leave", () => {
    const budi = { userId: "budi", role: "admin" as const };
    expect(memberActions(budi, member("citra", "member")).remove).toBe(true);
    expect(memberActions(budi, member("dewi", "admin")).remove).toBe(false);
    expect(memberActions(budi, member("ana", "owner")).remove).toBe(false);
    expect(memberActions(budi, member("citra", "member")).setRole).toBe(false);
    expect(memberActions(budi, member("budi", "admin"))).toEqual({
      setRole: false,
      handOver: false,
      remove: false,
      leave: true,
    });
  });

  it("a member only leaves, and a signed-out viewer gets nothing", () => {
    expect(memberActions({ userId: "citra", role: "member" }, member("budi", "admin")).remove).toBe(false);
    expect(memberActions({ userId: "citra", role: "member" }, member("citra", "member")).leave).toBe(true);
    expect(memberActions(null, member("citra", "member")).leave).toBe(false);
  });

  it("an agent is taken out by whoever brought it, or by the owner or an admin", () => {
    const agent = { agentId: "research", broughtBy: "ana", addedAt: 2 };
    expect(canTakeOutAgent(agent, "member", "ana")).toBe(true);
    expect(canTakeOutAgent(agent, "member", "citra")).toBe(false);
    expect(canTakeOutAgent(agent, "admin", "budi")).toBe(true);
  });

  it("offers the desk's own agents that are not in the Workspace yet, never the default agent", () => {
    expect(agentsToBring(DESK, PEOPLE.agents).map((agent) => agent.id)).toEqual(["images"]);
  });
});

describe("the Members tab on Personal", () => {
  it("draws nothing at all", () => {
    expect(
      renderToStaticMarkup(
        <ProjectMembersPanel project={project("owner")} me="ana" onChanged={() => {}} onLeft={() => {}} />,
      ),
    ).toBe("");
  });
});

describe("the Members tab on the hosted build", () => {
  it("shows the loading line until the host has answered", () => {
    hosted();
    const html = renderToStaticMarkup(
      <ProjectMembersPanel project={project("owner")} me="ana" onChanged={() => {}} onLeft={() => {}} />,
    );
    expect(html).toContain('data-testid="projects-members-status"');
    expect(html).toContain("Loading the members…");
  });

  it("as owner: role, hand-over and remove on the others, nothing on her own row, and the invite form", () => {
    const html = view("ana", "owner");
    expect(rowControls(html, "ana")).toEqual([]);
    expect(rowControls(html, "budi")).toEqual([
      "projects-member-role",
      "projects-member-handover",
      "projects-member-remove",
    ]);
    expect(rowControls(html, "citra")).toEqual([
      "projects-member-role",
      "projects-member-handover",
      "projects-member-remove",
    ]);
    expect(html).toContain('data-testid="projects-invite-input"');
    expect(html).toContain("Your account id: ana");
    expect(html.split('data-testid="projects-agent-takeout"').length - 1).toBe(2);
  });

  it("as admin: removes the plain member only, leaves on her own row, and still invites", () => {
    const html = view("budi", "admin");
    expect(rowControls(html, "ana")).toEqual([]);
    expect(rowControls(html, "budi")).toEqual(["projects-member-leave"]);
    expect(rowControls(html, "citra")).toEqual(["projects-member-remove"]);
    expect(html).toContain('data-testid="projects-invite-input"');
  });

  it("as member: no invite form, Leave on her own row, Take out on her own agent only", () => {
    const html = view("citra", "member");
    expect(rowControls(html, "ana")).toEqual([]);
    expect(rowControls(html, "budi")).toEqual([]);
    expect(rowControls(html, "citra")).toEqual(["projects-member-leave"]);
    expect(html).not.toContain('data-testid="projects-invite-input"');
    expect(html).not.toContain('data-testid="projects-picker"');
    expect(html.split('data-testid="projects-agent-takeout"').length - 1).toBe(1);
    expect(html).toContain("citra (you)");
  });

  it("as owner: the invite is a labelled search box over her colleagues, and Invite waits for a pick", () => {
    const html = view("ana", "owner");
    const label = html.match(/<label class="projects-picker-label" for="([^"]+)">Find a colleague by name<\/label>/);
    expect(label).not.toBeNull();
    expect(html).toContain(`id="${label?.[1]}"`);
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(
      /<button type="submit" class="btn btn-secondary" disabled="" data-testid="projects-invite">Invite<\/button>/,
    );
    expect(html).not.toContain("Account id");
  });

  it("says when the colleagues are loading, could not be loaded, or are all in already", () => {
    expect(view("ana", "owner", PEOPLE, null)).toContain("Loading your colleagues…");
    expect(view("ana", "owner", PEOPLE, null, true)).toContain("Your colleagues could not be loaded.");
    const everyone = view("ana", "owner", PEOPLE, []);
    expect(everyone).toContain('data-testid="projects-picker-everyone"');
    expect(everyone).not.toContain('role="combobox"');
  });

  it("shows her own id only while the host knows her by id alone", () => {
    expect(view("ana", "owner")).toContain('data-testid="projects-your-id"');
    const named: ProjectPeople = { ...PEOPLE, members: [{ ...member("ana", "owner"), name: "Ana Putri" }] };
    const html = view("ana", "owner", named);
    expect(html).not.toContain('data-testid="projects-your-id"');
    expect(html).toContain("Ana Putri (you)");
  });

  it("offers only the agent not brought in yet, by its mode's name", () => {
    const html = view("citra", "member");
    expect(html).toContain('data-testid="projects-agent-pick"');
    expect(html).toContain('<option value="images" selected="">Images</option>');
    expect(html).not.toContain('<option value="research"');
  });

  it("says every agent is here when there is none left to bring", () => {
    const all: ProjectPeople = {
      ...PEOPLE,
      agents: [...PEOPLE.agents, { agentId: "images", broughtBy: "budi", addedAt: 4 }],
    };
    const html = view("citra", "member", all);
    expect(html).not.toContain('data-testid="projects-agent-pick"');
    expect(html).toContain('data-testid="projects-agents-none"');
  });

  it("shows the host's refusal as it came", () => {
    const html = renderToStaticMarkup(
      <ProjectMembersView
        project={project("member")}
        me="citra"
        people={PEOPLE}
        loadFailed={false}
        candidates={COLLEAGUES}
        candidatesFailed={false}
        deskAgents={DESK}
        busy={false}
        error="Only the owner of this Workspace can change a role."
        actions={NOOP}
      />,
    );
    expect(html).toContain(">Only the owner of this Workspace can change a role.</p>");
  });

  it("names the roles and buttons in Indonesian from the id catalog", () => {
    applyLocale("id");
    const html = view("ana", "owner");
    expect(html).toContain(">Pemilik</span>");
    expect(html).toContain(">Jadikan pemilik</button>");
    expect(html).toContain(">Undang</button>");
  });
});
