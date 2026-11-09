/**
 * Deleting a desk on the hosted app: who is offered the button.
 *
 * The host refuses a member's delete (`403 workspace_delete_forbidden`,
 * `packages/host/src/handlers/workspaces-delete-roles.test.ts`): a desk holds every person's chats, so
 * removing it is for an owner or an admin. This file holds the other half. The Workspaces page does not
 * dangle a Delete at somebody the host will refuse; it says in one line who can. The role is what the
 * host reports for the person (`GET /api/v1/auth/session`, the membership row) and the screen only
 * hides a control with it, a courtesy and never the control. A stale role costs one refused click.
 *
 * Unknown is never an administrator: a signed-in person whose role this screen cannot read does not see
 * the button either, the same fail-closed reading the company key and the Erase button have.
 *
 * Personal is held to the byte: a desk has no session and no role to read, so the button is the markup
 * it always was.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { hostCapabilities } from "@agentforge/core/capabilities";
import { mayDeleteDesk } from "./desk-delete-access";
import { HostCapabilitiesFixture } from "./host-capabilities";
import { applyLocale, resetLocaleForTests, t } from "./i18n";
import { SESSION_BOOTING, SESSIONS_OFF, SessionFixture, type SessionRole, type SessionSnapshot } from "./session";

vi.mock("@/lib/api-client", () => ({
  isElectron: () => false,
  apiFetch: async () => ({ ok: true, json: async () => ({}) }) as Response,
}));

const DESK = hostCapabilities({});
const HOSTED = hostCapabilities({ AGENTFORGE_SERVER: "1" });

function signedIn(role?: SessionRole): SessionSnapshot {
  return {
    status: "signed-in",
    identity: { userId: "usr_1", orgId: "org_1", tenantId: "tnt_1", expiresAt: 0, ...(role ? { role } : {}) },
    reason: null,
  };
}

const SIGNED_OUT: SessionSnapshot = { status: "signed-out", identity: null, reason: null };

type Controls = typeof import("@/components/desk-delete-control");
let controls: Controls;

// The first import evaluates the component closure, which takes seconds on a busy machine and is not what
// any case asserts; it is paid here under its own budget and the cases keep vitest's default.
beforeAll(async () => {
  controls = await import("@/components/desk-delete-control");
}, 120_000);

afterEach(() => resetLocaleForTests());

function render(node: React.ReactElement, session: SessionSnapshot, capabilities: typeof DESK): string {
  return renderToStaticMarkup(
    <SessionFixture value={session}>
      <HostCapabilitiesFixture capabilities={capabilities}>{node}</HostCapabilitiesFixture>
    </SessionFixture>,
  );
}

const deletable = { id: "ws_1", name: "Sales", slug: "sales", protected: false };
const home = { id: "ws_0", name: "Default", slug: "home", protected: true };

describe("mayDeleteDesk", () => {
  it("is true for an owner and an admin, the two roles the host admits", () => {
    expect(mayDeleteDesk(signedIn("owner"))).toBe(true);
    expect(mayDeleteDesk(signedIn("admin"))).toBe(true);
  });

  it("is false for a member, and for a role this screen cannot read", () => {
    expect(mayDeleteDesk(signedIn("member"))).toBe(false);
    expect(mayDeleteDesk(signedIn())).toBe(false);
  });

  it("is true off the hosted server whatever the session says: no role is read there at all", () => {
    for (const role of ["owner", "admin", "member", undefined] as const) {
      expect(mayDeleteDesk(signedIn(role), false), String(role)).toBe(true);
    }
  });

  it("is true wherever there is no signed-in person to judge: a desk, a boot, a signed-out visit", () => {
    for (const session of [SESSIONS_OFF, SESSION_BOOTING, SIGNED_OUT]) {
      expect(mayDeleteDesk(session), session.status).toBe(true);
    }
  });
});

describe("the Delete button", () => {
  it("is offered to an owner and an admin on the hosted app", () => {
    for (const role of ["owner", "admin"] as const) {
      const markup = render(
        <controls.DeskDeleteButton workspace={deletable} onOpen={() => {}} />,
        signedIn(role),
        HOSTED,
      );
      expect(markup, role).toContain('data-testid="delete-workspace"');
      expect(markup, role).toContain(t("workspaces.delete"));
    }
  });

  it("is not offered to a member, or to a role this screen cannot read, on the hosted app", () => {
    for (const role of ["member", undefined] as const) {
      const markup = render(
        <controls.DeskDeleteButton workspace={deletable} onOpen={() => {}} />,
        signedIn(role),
        HOSTED,
      );
      expect(markup, String(role)).toBe("");
    }
  });

  it("is never offered for the Default desk, whoever asks", () => {
    for (const [session, capabilities] of [
      [signedIn("owner"), HOSTED],
      [SESSIONS_OFF, DESK],
    ] as const) {
      expect(render(<controls.DeskDeleteButton workspace={home} onOpen={() => {}} />, session, capabilities)).toBe("");
    }
    const bySlug = { ...deletable, slug: "home", protected: undefined };
    expect(render(<controls.DeskDeleteButton workspace={bySlug} onOpen={() => {}} />, signedIn("owner"), HOSTED)).toBe(
      "",
    );
  });

  it("Personal: is the markup it always was, with no role read", () => {
    for (const [session, capabilities] of [
      [SESSIONS_OFF, DESK],
      [SESSION_BOOTING, HOSTED],
      [SIGNED_OUT, HOSTED],
      // The role is never read off the hosted server, even if a session somehow said member.
      [signedIn("member"), DESK],
    ] as const) {
      expect(render(<controls.DeskDeleteButton workspace={deletable} onOpen={() => {}} />, session, capabilities)).toBe(
        '<button type="button" class="rounded-md px-2 py-1 text-sm text-[var(--danger)] underline" data-testid="delete-workspace">Delete</button>',
      );
    }
  });
});

describe("the line that says who can", () => {
  it("is shown to a member on the hosted app, in English and in Indonesian", () => {
    applyLocale("en");
    const english = render(<controls.DeskDeleteNote />, signedIn("member"), HOSTED);
    expect(english).toContain('data-testid="workspaces-delete-restricted"');
    expect(english).toContain(t("workspaces.deleteRestricted"));
    expect(t("workspaces.deleteRestricted")).toBe("Only an owner or admin can delete a desk.");

    applyLocale("id");
    const indonesian = render(<controls.DeskDeleteNote />, signedIn("member"), HOSTED);
    expect(indonesian).toContain(t("workspaces.deleteRestricted"));
    expect(t("workspaces.deleteRestricted")).toBe("Hanya pemilik atau admin yang bisa menghapus meja kerja.");
  });

  it("is shown for a role it cannot read, never as if that person were an owner", () => {
    expect(render(<controls.DeskDeleteNote />, signedIn(), HOSTED)).toContain("workspaces-delete-restricted");
  });

  it("is not shown to an owner, an admin, or anyone on a desk", () => {
    for (const [session, capabilities] of [
      [signedIn("owner"), HOSTED],
      [signedIn("admin"), HOSTED],
      [SESSIONS_OFF, DESK],
      [signedIn("member"), DESK],
    ] as const) {
      expect(render(<controls.DeskDeleteNote />, session, capabilities)).toBe("");
    }
  });
});

describe("the refusal, if one still comes back", () => {
  it("is worded from the catalog, in the person's language, not from the host's English", () => {
    applyLocale("id");
    expect(controls.deskDeleteErrorMessage({ code: "workspace_delete_forbidden", message: "Only an owner" })).toBe(
      t("workspaces.errors.deleteForbidden"),
    );
    expect(t("workspaces.errors.deleteForbidden")).toBe("Hanya pemilik atau admin yang bisa menghapus meja kerja.");
  });

  it("keeps the host's own wording for every other refusal, and a catalog line when it sent none", () => {
    applyLocale("en");
    expect(controls.deskDeleteErrorMessage({ code: "confirm_required", message: "Type the desk name" })).toBe(
      "Type the desk name",
    );
    expect(controls.deskDeleteErrorMessage({ code: "boom" })).toBe(t("workspaces.errors.delete"));
  });
});

describe("the Workspaces page", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "components", "workspaces-page.tsx"),
    "utf8",
  ).replace(/\r\n/g, "\n");

  it("takes the Delete button and the note from the role-aware controls, not inline", () => {
    expect(source).toContain("<DeskDeleteButton");
    expect(source).toContain("<DeskDeleteNote");
    expect(source).not.toContain('data-testid="delete-workspace"\n');
    expect(source).toContain("deskDeleteErrorMessage");
  });
});
