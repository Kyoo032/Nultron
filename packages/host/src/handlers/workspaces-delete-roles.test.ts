/**
 * Who may delete a desk on the hosted service.
 *
 * Found in the 2026-10-06 review: any signed-in *member* could delete a desk of the company
 * (`DELETE /api/v1/workspaces/:id` with the desk's name typed as the confirmation). Deleting a desk
 * removes its threads (every person's chats on it, which are private to them), its Knowledge Base, its
 * files, its channels and its settings, so it is the company's call and not any one person's: an owner
 * or an admin may (`canAdminister`), and a member, or a builder (the host's own role), gets
 * `403 workspace_delete_forbidden` with the desk untouched.
 *
 * Real handlers, real membership rows, throwaway data dir. The people are provisioned through
 * `ensurePortalOwner`, the call a portal sign-in makes, so the role the handler reads is the membership
 * row the session resolves to, not a stub. Hosted mode is injected (`isServerMode`), the way
 * `settings-key-roles.test.ts` does it: flipping `AGENTFORGE_SERVER` in this process would put the
 * router's session gate in front of every call.
 *
 * The Personal half is pinned too: off server mode there is no role check at all, so the same member
 * session on a desk deletes exactly as it always did.
 *
 * What is deliberately NOT changed, and pinned here so a later change is a decision: creating a desk
 * and renaming or re-moding one stay open to a member. Neither destroys anything.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PortalRole, TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";
import type { HostRequest, HostResult } from "../types";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-workspaces-delete-roles-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_SECRETS_KEY = "d".repeat(64);
process.env.AGENTFORGE_RUNTIME = "stub";
delete process.env.AGENTFORGE_SERVER;
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;

const TENANT_ID = "tenant-delete-roles";
const ORG_ID = "org-delete-roles";

const HOSTED = { isServerMode: () => true };
const DESK = { isServerMode: () => false };
type Deps = { isServerMode: () => boolean };

type Person = "owner" | "admin" | "member" | "builder";
type Answer = { status: number; body: Record<string, unknown> };
type Desk = { id: string; name: string; slug: string };

const people = new Map<Person, TenantContext>();
let handlers: typeof import("./workspaces");
let FORBIDDEN_CODE: string;

function as(person: Person, method: string, path: string, body?: unknown, params: Record<string, string> = {}) {
  const tenant = people.get(person);
  if (!tenant) {
    throw new Error(`${person} was not provisioned`);
  }
  const request: HostRequest = {
    method,
    path,
    query: {},
    params,
    headers: {},
    body,
    session: {
      id: `session-${person}`,
      tenantId: tenant.tenantId,
      orgId: tenant.organizationId,
      userId: tenant.userId,
    },
  };
  return request;
}

function answer(result: HostResult): Answer {
  if (result.type !== "json") {
    throw new Error(`expected json, got ${result.type}`);
  }
  return { status: result.status, body: (result.body ?? {}) as Record<string, unknown> };
}

function errorOf(response: Answer): { code?: string; message?: string } {
  return (response.body.error ?? {}) as { code?: string; message?: string };
}

async function listDesks(as_: Person = "owner"): Promise<Desk[]> {
  const response = answer(await handlers.handleGetWorkspaces(as(as_, "GET", "/api/v1/workspaces")));
  return (response.body as { workspaces: Desk[] }).workspaces;
}

/** A desk the owner made, so each case deletes its own and nothing else. */
async function newDesk(name: string): Promise<Desk> {
  const created = answer(
    await handlers.handlePostWorkspaces(as("owner", "POST", "/api/v1/workspaces", { name, productModes: ["chat"] })),
  );
  expect(created.status).toBe(201);
  return (created.body as { workspace: Desk }).workspace;
}

async function remove(person: Person, desk: Desk, deps: Deps = HOSTED, confirmName: string = desk.name) {
  return answer(
    await handlers.handleDeleteWorkspace(
      as(person, "DELETE", `/api/v1/workspaces/${desk.id}`, { confirmName }, { workspaceId: desk.id }),
      deps,
    ),
  );
}

async function exists(desk: Desk): Promise<boolean> {
  return (await listDesks()).some((row) => row.id === desk.id);
}

beforeAll(async () => {
  const dbm = await import("@agentforge/db");
  handlers = await import("./workspaces");
  FORBIDDEN_CODE = handlers.WORKSPACE_DELETE_FORBIDDEN_CODE;

  const roles: Array<[Person, PortalRole | null]> = [
    ["owner", "owner"],
    ["admin", "admin"],
    ["member", "member"],
    ["builder", "member"],
  ];
  for (const [person, role] of roles) {
    people.set(
      person,
      await dbm.ensurePortalOwner(dbm.db, {
        tenantId: TENANT_ID,
        orgId: ORG_ID,
        userId: `usr-${person}`,
        role,
      }),
    );
  }
  // `builder` is the host's own role, not one of the portal's three: write the row the way a host that
  // grants it would, then read it back through the resolver the handler uses.
  dbm.sql
    .prepare("UPDATE organization_members SET role = 'builder' WHERE organization_id = ? AND user_id = ?")
    .run(ORG_ID, "usr-builder");
  const resolved = await dbm.resolvePortalTenant(dbm.db, {
    tenantId: TENANT_ID,
    orgId: ORG_ID,
    userId: "usr-builder",
  });
  if (!resolved.ok) {
    throw new Error(`builder did not resolve: ${resolved.code}`);
  }
  people.set("builder", resolved.tenant);
}, ROUTER_IMPORT_BUDGET_MS);

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("hosted: deleting a desk is for an owner or an admin", () => {
  it("refuses a member with 403 and leaves the desk, its name typed correctly", async () => {
    const desk = await newDesk("Member cannot delete");

    const response = await remove("member", desk);

    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe(FORBIDDEN_CODE);
    expect(errorOf(response).code).toBe("workspace_delete_forbidden");
    expect(errorOf(response).message).toMatch(/owner or an admin/i);
    expect(await exists(desk)).toBe(true);
  });

  it("refuses a builder too: only owner and admin administer a company", async () => {
    const desk = await newDesk("Builder cannot delete");

    const response = await remove("builder", desk);

    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe(FORBIDDEN_CODE);
    expect(await exists(desk)).toBe(true);
  });

  it("refuses the role before it looks at the confirmation, so a member learns nothing from a wrong name", async () => {
    const desk = await newDesk("Role first");

    const right = await remove("member", desk, HOSTED, desk.name);
    const wrong = await remove("member", desk, HOSTED, "not the name");
    const blank = await remove("member", desk, HOSTED, "");

    for (const response of [right, wrong, blank]) {
      expect(response.status).toBe(403);
      expect(errorOf(response).code).toBe(FORBIDDEN_CODE);
    }
    expect(await exists(desk)).toBe(true);
  });

  it("lets an admin delete it", async () => {
    const desk = await newDesk("Admin deletes");

    const response = await remove("admin", desk);

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(await exists(desk)).toBe(false);
  });

  it("lets the owner delete it", async () => {
    const desk = await newDesk("Owner deletes");

    const response = await remove("owner", desk);

    expect(response.status).toBe(200);
    expect(await exists(desk)).toBe(false);
  });

  it("still asks an owner for the desk name", async () => {
    const desk = await newDesk("Owner still confirms");

    const response = await remove("owner", desk, HOSTED, "something else");

    expect(response.status).toBe(400);
    expect(errorOf(response).code).toBe("confirm_required");
    expect(await exists(desk)).toBe(true);
  });

  it("answers an unknown desk 404 to a member, as before: the lookup comes first", async () => {
    const ghost: Desk = { id: crypto.randomUUID(), name: "Ghost", slug: "ghost" };

    const response = await remove("member", ghost);

    expect(response.status).toBe(404);
    expect(errorOf(response).code).toBe("not_found");
  });

  it("keeps the Default desk undeletable for an owner, and refuses a member the same way as any desk", async () => {
    const home = (await listDesks()).find((desk) => desk.slug === "home");
    if (!home) {
      throw new Error("no Default desk");
    }

    const owner = await remove("owner", home);
    expect(owner.status).toBe(403);
    expect(errorOf(owner).code).toBe("protected");

    const member = await remove("member", home);
    expect(member.status).toBe(403);
    expect(errorOf(member).code).toBe(FORBIDDEN_CODE);
    expect(await exists(home)).toBe(true);
  });
});

describe("hosted: what stays open to a member (recorded, not changed)", () => {
  it("lets a member create a desk and rename it", async () => {
    const created = answer(
      await handlers.handlePostWorkspaces(
        as("member", "POST", "/api/v1/workspaces", { name: "Member made this", productModes: ["chat"] }),
      ),
    );
    expect(created.status).toBe(201);
    const desk = (created.body as { workspace: Desk }).workspace;

    const renamed = answer(
      await handlers.handlePatchWorkspace(
        as(
          "member",
          "PATCH",
          `/api/v1/workspaces/${desk.id}`,
          { name: "Member renamed this" },
          { workspaceId: desk.id },
        ),
      ),
    );
    expect(renamed.status).toBe(200);
    expect((renamed.body.workspace as Desk).name).toBe("Member renamed this");
  });
});

describe("Personal parity: off server mode there is no role check", () => {
  it("lets the same member session delete a desk, exactly as before", async () => {
    const desk = await newDesk("Desk mode deletes");

    const response = await remove("member", desk, DESK);

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(await exists(desk)).toBe(false);
  });

  it("lets a builder delete it too, and still asks for the name", async () => {
    const desk = await newDesk("Desk mode builder");

    const wrong = await remove("builder", desk, DESK, "nope");
    expect(wrong.status).toBe(400);
    expect(errorOf(wrong).code).toBe("confirm_required");

    const right = await remove("builder", desk, DESK);
    expect(right.status).toBe(200);
    expect(await exists(desk)).toBe(false);
  });

  it("reads the environment when nothing is injected, and the environment says desk", async () => {
    const desk = await newDesk("No deps given");

    const response = answer(
      await handlers.handleDeleteWorkspace(
        as("member", "DELETE", `/api/v1/workspaces/${desk.id}`, { confirmName: desk.name }, { workspaceId: desk.id }),
      ),
    );

    expect(process.env.AGENTFORGE_SERVER).toBeUndefined();
    expect(response.status).toBe(200);
    expect(await exists(desk)).toBe(false);
  });
});
