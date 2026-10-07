/**
 * `build_deck` and the hosted storage ceiling.
 *
 * A deck is a row in the artifacts table, not an object in the tenant's store, so the ceiling used to
 * see none of it: an account that called the tool in a loop wrote about 15 MB a minute with the meter at
 * zero. Saved artifacts are now counted in what a hosted tenant holds, and the deck path asks about the
 * number the row will carry (the base64 text), not the smaller file inside it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureSchema, sql } from "@agentforge/db";
import { artifactStore } from "../artifacts";
import { forgetTenantJobBytes, resetObjectStoreForTests, tenantStorageReport } from "../tenant-storage";
import "../tenant-storage-db";
import { buildDeckForTenant } from "./build-deck";
import { deckTenant, OTHER_DECK_PERSON, SAMPLE_DECK } from "./deck-test-fixtures";

process.env.AGENTFORGE_SECRETS_KEY = "3f8a1c05d97e26b4084fa3c1e5d7290b6c48af13e02d95b7ca6318fd4e7092a5";

let tenant: Awaited<ReturnType<typeof deckTenant>>;

beforeAll(async () => {
  // A hosted process opens the database with the size index the quota's sum is answered from; this one
  // was opened as a desk, so open it again as a server (`ensureSchema` is idempotent).
  process.env.AGENTFORGE_SERVER = "1";
  try {
    ensureSchema(sql);
  } finally {
    delete process.env.AGENTFORGE_SERVER;
  }
  tenant = await deckTenant();
});

afterEach(() => {
  delete process.env.AGENTFORGE_SERVER;
  delete process.env.AGENTFORGE_TENANT_STORAGE_BYTES;
  sql.prepare("DELETE FROM tenant_storage").run();
  sql.prepare("DELETE FROM artifacts").run();
  resetObjectStoreForTests();
  forgetTenantJobBytes();
});

afterAll(() => {
  sql.close();
});

/** What one sample deck holds once stored: the number the ceiling is measured in. */
async function deckSize(): Promise<number> {
  const first = await buildDeckForTenant(SAMPLE_DECK, tenant);
  if (!first.ok) {
    throw new Error("the sample deck did not build");
  }
  const size = artifactStore().get(tenant, first.artifactId)?.sizeBytes ?? 0;
  artifactStore().remove(tenant, first.artifactId);
  return size;
}

describe("saved decks and the hosted storage ceiling", () => {
  it("counts what a saved deck holds, so a scripted account cannot fill the disk one deck at a time", async () => {
    const size = await deckSize();
    expect(size).toBeGreaterThan(10_000);
    process.env.AGENTFORGE_SERVER = "1";
    process.env.AGENTFORGE_TENANT_STORAGE_BYTES = String(Math.floor(size * 3.5));

    const answers = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      answers.push(await buildDeckForTenant(SAMPLE_DECK, tenant));
    }

    expect(answers.filter((answer) => answer.ok)).toHaveLength(3);
    expect(answers.slice(3).every((answer) => !answer.ok && answer.reason === "quota")).toBe(true);
    expect(artifactStore().list(tenant, "presentations")).toHaveLength(3);
    const report = await tenantStorageReport(tenant.tenantId);
    expect(report.artifactBytes).toBe(size * 3);
    expect(report.usedBytes).toBe(size * 3);
  });

  it("checks the stored size (the base64 text), not the smaller file inside it", async () => {
    const size = await deckSize();
    process.env.AGENTFORGE_SERVER = "1";
    // Above the decoded file (about three quarters of the stored text) and below the stored text.
    process.env.AGENTFORGE_TENANT_STORAGE_BYTES = String(size - 500);
    await expect(buildDeckForTenant(SAMPLE_DECK, tenant)).resolves.toMatchObject({ ok: false, reason: "quota" });
    process.env.AGENTFORGE_TENANT_STORAGE_BYTES = String(size);
    await expect(buildDeckForTenant(SAMPLE_DECK, tenant)).resolves.toMatchObject({ ok: true });
  });

  it("gives the room back when a deck is deleted", async () => {
    const size = await deckSize();
    process.env.AGENTFORGE_SERVER = "1";
    process.env.AGENTFORGE_TENANT_STORAGE_BYTES = String(Math.floor(size * 1.5));
    const first = await buildDeckForTenant(SAMPLE_DECK, tenant);
    expect(first).toMatchObject({ ok: true });
    await expect(buildDeckForTenant(SAMPLE_DECK, tenant)).resolves.toMatchObject({ ok: false, reason: "quota" });
    if (first.ok) {
      artifactStore().remove(tenant, first.artifactId);
    }
    await expect(buildDeckForTenant(SAMPLE_DECK, tenant)).resolves.toMatchObject({ ok: true });
  });

  it("does not count another tenant's decks", async () => {
    const size = await deckSize();
    const other = await deckTenant(OTHER_DECK_PERSON);
    const theirs = await buildDeckForTenant(SAMPLE_DECK, other);
    expect(theirs).toMatchObject({ ok: true });
    process.env.AGENTFORGE_SERVER = "1";
    process.env.AGENTFORGE_TENANT_STORAGE_BYTES = String(Math.floor(size * 1.5));
    expect((await tenantStorageReport(tenant.tenantId)).artifactBytes).toBe(0);
    await expect(buildDeckForTenant(SAMPLE_DECK, tenant)).resolves.toMatchObject({ ok: true });
    expect((await tenantStorageReport(other.tenantId)).artifactBytes).toBe(size);
  });

  it("is what Personal never sees: off the server the report reads no artifacts and nothing is refused", async () => {
    const size = await deckSize();
    process.env.AGENTFORGE_TENANT_STORAGE_BYTES = "1000";
    await expect(buildDeckForTenant(SAMPLE_DECK, tenant)).resolves.toMatchObject({ ok: true });
    await expect(buildDeckForTenant(SAMPLE_DECK, tenant)).resolves.toMatchObject({ ok: true });
    const report = await tenantStorageReport(tenant.tenantId);
    expect(report.artifactBytes).toBe(0);
    expect(report.limitBytes).toBeNull();
    expect(size).toBeGreaterThan(1000);
  });
});
