/**
 * `build_deck`: the outline a model writes becomes a real .pptx the owner can download.
 *
 * Every case opens the stored file the way PowerPoint would (it is a zip) and counts slide parts, so a
 * deck that only looks right in the tool's own answer fails here.
 */
import JSZip from "jszip";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { artifactFilename, PPTX_MIME } from "@agentforge/core/artifacts";
import { db, ensurePortalOwner, sql } from "@agentforge/db";
import { artifactStore } from "../artifacts";
import { forgetTenantJobBytes, resetObjectStoreForTests } from "../tenant-storage";
import "../tenant-storage-db";
import { getTenant } from "../tenant";
import { buildDeckForTenant } from "./build-deck";
import type { BuildDeckInput } from "./deck-schema";

process.env.AGENTFORGE_SECRETS_KEY = "3f8a1c05d97e26b4084fa3c1e5d7290b6c48af13e02d95b7ca6318fd4e7092a5";

const PERSON = { id: "deck-session", tenantId: "deck-tenant", orgId: "deck-org", userId: "deck-user" };

const DECK: BuildDeckInput = {
  title: "Warung expansion plan",
  slides: [
    {
      kind: "section",
      heading: "Why a second shop now",
      subhead: "Demand has outgrown one counter",
      bullets: [],
      aside: "",
      notes: "Open with the queue photo. Say the lunch rush doubled since March.",
    },
    {
      kind: "bullets",
      heading: "Sales have grown for six months",
      subhead: "",
      bullets: ["Lunch orders doubled", "Delivery is a third of revenue", "Repeat buyers are up"],
      aside: "",
      notes: "Cite the monthly sheet the owner shared.",
    },
    {
      kind: "close",
      heading: "Decision needed this month",
      subhead: "",
      bullets: ["Approve the lease", "Hire two cooks"],
      aside: "",
      notes: "Ask for a yes or a no.",
    },
  ],
};

let tenant: Awaited<ReturnType<typeof getTenant>>;

beforeAll(async () => {
  await ensurePortalOwner(db, {
    tenantId: PERSON.tenantId,
    orgId: PERSON.orgId,
    userId: PERSON.userId,
    role: "owner",
  });
  tenant = await getTenant({ session: PERSON });
});

afterEach(() => {
  delete process.env.AGENTFORGE_SERVER;
  delete process.env.AGENTFORGE_TENANT_STORAGE_BYTES;
  sql.prepare("DELETE FROM tenant_storage").run();
  // Saved decks count against the hosted ceiling, so one case's decks must not be the next one's use.
  sql.prepare("DELETE FROM artifacts").run();
  resetObjectStoreForTests();
  forgetTenantJobBytes();
});

afterAll(() => {
  sql.close();
});

async function openDeck(base64: string) {
  const zip = await JSZip.loadAsync(Buffer.from(base64, "base64"));
  const read = async (pattern: RegExp) =>
    Promise.all(
      Object.keys(zip.files)
        .filter((name) => pattern.test(name))
        .sort()
        .map((name) => zip.file(name)?.async("string") ?? Promise.resolve("")),
    );
  return {
    zip,
    slides: await read(/^ppt\/slides\/slide\d+\.xml$/),
    notes: await read(/^ppt\/notesSlides\/notesSlide\d+\.xml$/),
  };
}

describe("buildDeckForTenant", () => {
  it("saves a PowerPoint artifact and answers its id, file name and slide count", async () => {
    const result = await buildDeckForTenant(DECK, tenant);
    expect(result).toEqual({
      ok: true,
      artifactId: expect.any(String),
      filename: "warung-expansion-plan.pptx",
      slideCount: 4,
    });
    if (!result.ok) {
      return;
    }
    const saved = artifactStore().get(tenant, result.artifactId);
    expect(saved).toMatchObject({
      mode: "presentations",
      kind: "draft",
      mime: PPTX_MIME,
      title: "Warung expansion plan",
      meta: { source: "chat", slides: 4 },
    });
    // The name the tool reports is the name the download route will send.
    expect(artifactFilename(saved?.title ?? "", PPTX_MIME)).toBe(result.filename);
  });

  it("stores a zip with a title slide plus one slide per outline item, and the speaker notes", async () => {
    const result = await buildDeckForTenant(DECK, tenant);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const saved = artifactStore().get(tenant, result.artifactId);
    const deck = await openDeck(saved?.body ?? "");
    expect(deck.slides).toHaveLength(4);
    const text = deck.slides.join("\n");
    for (const needle of [
      "Warung expansion plan",
      "Why a second shop now",
      "Lunch orders doubled",
      "Approve the lease",
    ]) {
      expect(text, needle).toContain(needle);
    }
    expect(deck.notes.join("\n")).toContain("Say the lunch rush doubled since March.");
    expect(Object.keys(deck.zip.files)).toContain("[Content_Types].xml");
  });

  it("does not change the outline it was handed", async () => {
    const frozen = structuredClone(DECK);
    Object.freeze(frozen);
    for (const slide of frozen.slides) {
      Object.freeze(slide);
      Object.freeze(slide.bullets);
    }
    Object.freeze(frozen.slides);
    await expect(buildDeckForTenant(frozen, tenant)).resolves.toMatchObject({ ok: true });
    expect(frozen).toEqual(DECK);
  });

  it("refuses an outline with a slide that has nothing on it, names the slide, and saves nothing", async () => {
    const before = artifactStore().list(tenant, "presentations").length;
    const empty: BuildDeckInput = {
      ...DECK,
      slides: [
        ...DECK.slides,
        { kind: "bullets", heading: "Just a heading", subhead: "", bullets: [], aside: "", notes: "" },
      ],
    };
    const result = await buildDeckForTenant(empty, tenant);
    expect(result).toMatchObject({ ok: false, reason: "checks" });
    if (result.ok) {
      return;
    }
    expect(result.message).toContain("ERROR:");
    expect(result.message).toContain("Just a heading");
    expect(result.message).toContain("FIX:");
    expect(artifactStore().list(tenant, "presentations")).toHaveLength(before);
  });

  it("refuses two slides that share a heading", async () => {
    const twice: BuildDeckInput = {
      ...DECK,
      slides: [DECK.slides[1], { ...DECK.slides[1], notes: "again" }].filter((s): s is NonNullable<typeof s> =>
        Boolean(s),
      ),
    };
    const result = await buildDeckForTenant(twice, tenant);
    expect(result).toMatchObject({ ok: false, reason: "checks" });
    expect(result.ok ? "" : result.message).toContain("share a heading");
  });

  it("refuses text that would run off the exported slide, so the person never opens a clipped deck", async () => {
    // Every bullet is inside its own limit (400 characters); it is the slide that has too much on it.
    const wall = "word ".repeat(80).trim();
    const crowded: BuildDeckInput = {
      ...DECK,
      slides: [
        {
          kind: "bullets",
          heading: "A claim",
          subhead: "",
          bullets: Array.from({ length: 12 }, () => wall),
          aside: "",
          notes: "",
        },
      ],
    };
    const result = await buildDeckForTenant(crowded, tenant);
    expect(result).toMatchObject({ ok: false, reason: "checks" });
    expect(result.ok ? "" : result.message).toContain("Too much text to fit");
  });

  it("refuses an outline that is not an outline, without throwing", async () => {
    const result = await buildDeckForTenant({ title: "", slides: [] } as unknown as BuildDeckInput, tenant);
    expect(result).toMatchObject({ ok: false, reason: "limits" });
  });

  // The artifact body cap (`too_large`) is covered by `build-deck-too-large.test.ts`: the per-field
  // limits now keep any outline far below it, so only a stubbed exporter can reach it.

  it("refuses a tenant that is already past its hosted storage ceiling, and saves nothing", async () => {
    process.env.AGENTFORGE_SERVER = "1";
    process.env.AGENTFORGE_TENANT_STORAGE_BYTES = "1000";
    const before = artifactStore().list(tenant, "presentations").length;
    const result = await buildDeckForTenant(DECK, tenant);
    expect(result).toMatchObject({ ok: false, reason: "quota" });
    expect(artifactStore().list(tenant, "presentations")).toHaveLength(before);
  });

  it("does not look at the hosted ceiling off the server", async () => {
    process.env.AGENTFORGE_TENANT_STORAGE_BYTES = "1000";
    await expect(buildDeckForTenant(DECK, tenant)).resolves.toMatchObject({ ok: true });
  });
});
