/**
 * The private upload folders, at the desk store: every path a tool or a route takes goes through
 * `createDeskRoot` and the version functions, so one test here covers the file tools, `run_code`'s
 * inputs, the list and glob, search and the Files view's version routes.
 *
 * Two people on one team desk (same tenant, same organisation), and the Personal desk beside them.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, ensurePortalOwner, sql } from "@agentforge/db";
import type { TenantContext } from "@agentforge/core";
import { FileRootError, parseDeskPath } from "@agentforge/core/tools/files";
import type { DeskPath } from "@agentforge/core/tools/files";
import { getTenant } from "../tenant";
import { forgetTenantJobBytes, resetObjectStoreForTests } from "../tenant-storage";
import "../tenant-storage-db";
import { privateFolderFor } from "./private-uploads";
import { createDeskRoot, listVersions, readVersion, revertTo } from "./store";

process.env.AGENTFORGE_SECRETS_KEY = "3f8a1c05d97e26b4084fa3c1e5d7290b6c48af13e02d95b7ca6318fd4e7092a5";

const ANA = { id: "priv-session-a", tenantId: "priv-tenant", orgId: "priv-org", userId: "priv-user-ana" };
const BEN = { id: "priv-session-b", tenantId: "priv-tenant", orgId: "priv-org", userId: "priv-user-ben" };

let ana: TenantContext;
let ben: TenantContext;
let anaPath: DeskPath;

const asPath = (raw: string): DeskPath => {
  const parsed = parseDeskPath(raw);
  if (typeof parsed !== "string") {
    throw new Error(`bad test path ${raw}`);
  }
  return parsed;
};

const authorOf = (tenant: TenantContext) => ({ kind: "user", userId: tenant.userId }) as const;

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return error instanceof FileRootError ? error.code : "other";
  }
}

beforeAll(async () => {
  await ensurePortalOwner(db, { tenantId: ANA.tenantId, orgId: ANA.orgId, userId: ANA.userId, role: "owner" });
  await ensurePortalOwner(db, { tenantId: BEN.tenantId, orgId: BEN.orgId, userId: BEN.userId, role: "owner" });
  ana = await getTenant({ session: ANA });
  ben = await getTenant({ session: BEN });
  anaPath = asPath(`uploads/${privateFolderFor(ana.userId)}/contract.md`);
  process.env.AGENTFORGE_SERVER = "1";
  await createDeskRoot(ana, authorOf(ana)).write(anaPath, "SECRET-CONTRACT-TEXT version one", authorOf(ana));
  await createDeskRoot(ana, authorOf(ana)).write(
    asPath("team/plan.md"),
    "shared plan SECRET-CONTRACT-TEXT",
    authorOf(ana),
  );
  delete process.env.AGENTFORGE_SERVER;
});

afterEach(() => {
  delete process.env.AGENTFORGE_SERVER;
  sql.prepare("DELETE FROM tenant_storage").run();
  resetObjectStoreForTests();
  forgetTenantJobBytes();
});

afterAll(() => {
  sql.close();
});

describe("on the hosted server, with Ana and Ben on one desk", () => {
  it("really is one desk", () => {
    expect(ben.workspaceId).toBe(ana.workspaceId);
    expect(ben.userId).not.toBe(ana.userId);
  });

  it("lets Ana read, list, search and version her own private file", async () => {
    process.env.AGENTFORGE_SERVER = "1";
    const root = createDeskRoot(ana, authorOf(ana));
    expect((await root.read(anaPath)).text).toContain("SECRET-CONTRACT-TEXT");
    expect((await root.list(null)).map((entry) => entry.path)).toContain(anaPath);
    expect((await root.search("SECRET-CONTRACT-TEXT")).map((hit) => hit.path)).toContain(anaPath);
    expect((await listVersions(ana, anaPath)).length).toBe(1);
    expect((await readVersion(ana, anaPath, 1)).text).toContain("SECRET");
  });

  it("makes it not found for Ben on every path: read, list, glob, search, versions, write, remove, revert", async () => {
    process.env.AGENTFORGE_SERVER = "1";
    const root = createDeskRoot(ben, authorOf(ben));
    expect(await code(root.read(anaPath))).toBe("not_found");
    expect((await root.list(null)).map((entry) => entry.path)).not.toContain(anaPath);
    expect((await root.list(asPath("uploads"))).map((entry) => entry.path)).toEqual([]);
    expect((await root.list(null, "uploads/**")).map((entry) => entry.path)).toEqual([]);
    const hits = await root.search("SECRET-CONTRACT-TEXT");
    expect(hits.map((hit) => hit.path)).toEqual(["team/plan.md"]);
    expect(await code(listVersions(ben, anaPath))).toBe("not_found");
    expect(await code(readVersion(ben, anaPath, 1))).toBe("not_found");
    expect(await code(root.write(anaPath, "overwritten", authorOf(ben)))).toBe("not_found");
    expect(await code(root.remove(anaPath, authorOf(ben)))).toBe("not_found");
    expect(await code(revertTo(ben, anaPath, 1, authorOf(ben)))).toBe("not_found");
    // ...and nothing Ben tried changed Ana's file.
    process.env.AGENTFORGE_SERVER = "1";
    expect((await createDeskRoot(ana, authorOf(ana)).read(anaPath)).text).toBe("SECRET-CONTRACT-TEXT version one");
  });

  it("will not let Ben create a folder under Ana's name, or any folder under another person's mark", async () => {
    process.env.AGENTFORGE_SERVER = "1";
    const root = createDeskRoot(ben, authorOf(ben));
    expect(
      await code(root.write(asPath(`uploads/${privateFolderFor(ana.userId)}/planted.md`), "x", authorOf(ben))),
    ).toBe("not_found");
    expect(await code(root.write(asPath("uploads/~made-up/x.md"), "x", authorOf(ben)))).toBe("not_found");
    expect(await code(root.write(asPath(`uploads/${privateFolderFor(ben.userId)}/mine.md`), "x", authorOf(ben)))).toBe(
      "ok",
    );
  });

  it("refuses every private folder to a caller with no user id, such as a background run", async () => {
    process.env.AGENTFORGE_SERVER = "1";
    const nobody = { ...ana, userId: "" } as TenantContext;
    const root = createDeskRoot(nobody, authorOf(ana));
    expect(await code(root.read(anaPath))).toBe("not_found");
    expect((await root.list(null)).map((entry) => entry.path)).not.toContain(anaPath);
    expect((await root.read(asPath("team/plan.md"))).text).toContain("shared plan");
  });

  it("leaves every other path as shared as it was", async () => {
    process.env.AGENTFORGE_SERVER = "1";
    const root = createDeskRoot(ben, authorOf(ben));
    expect((await root.read(asPath("team/plan.md"))).text).toContain("shared plan");
    expect(await code(root.write(asPath("uploads/shared-note.md"), "x", authorOf(ben)))).toBe("ok");
  });
});

describe("on Personal, one person, nothing is hidden (parity)", () => {
  it("lets the caller read, list and search a private-looking folder, as before", async () => {
    // Server mode is off: this is the desk. Ben stands in for the one local owner.
    const root = createDeskRoot(ben, authorOf(ben));
    expect((await root.read(anaPath)).text).toContain("SECRET-CONTRACT-TEXT");
    expect((await root.list(null)).map((entry) => entry.path)).toContain(anaPath);
    expect((await root.search("SECRET-CONTRACT-TEXT")).map((hit) => hit.path)).toContain(anaPath);
    expect((await listVersions(ben, anaPath)).length).toBeGreaterThan(0);
    expect(await code(root.write(asPath("uploads/~anyone/x.md"), "x", authorOf(ben)))).toBe("ok");
  });
});
