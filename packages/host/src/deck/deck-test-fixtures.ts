/**
 * Shared by the `build_deck` test files: one signed-in person, a sample deck, and the two helpers that
 * make a slide and open a stored file the way PowerPoint would (it is a zip).
 */
import JSZip from "jszip";
import { db, ensurePortalOwner } from "@agentforge/db";
import { getTenant } from "../tenant";
import type { BuildDeckInput } from "./deck-schema";

export const DECK_PERSON = { id: "deck-session", tenantId: "deck-tenant", orgId: "deck-org", userId: "deck-user" };

export type DeckSlide = BuildDeckInput["slides"][number];

export const slideWith = (extra: Partial<DeckSlide> = {}): DeckSlide => ({
  kind: "bullets",
  heading: "Sales have grown for six months",
  subhead: "",
  bullets: ["Lunch orders doubled", "Repeat buyers are up"],
  aside: "",
  notes: "Cite the monthly sheet.",
  ...extra,
});

export const deckWith = (extra: Partial<DeckSlide> = {}, title = "Plan"): BuildDeckInput => ({
  title,
  slides: [slideWith(extra)],
});

/** Three slides: enough to be a real deck, small enough that a test can count its bytes. */
export const SAMPLE_DECK: BuildDeckInput = {
  title: "Warung expansion plan",
  slides: [
    slideWith({
      kind: "section",
      heading: "Why a second shop now",
      subhead: "Demand has outgrown one counter",
      bullets: [],
      notes: "Open with the queue photo.",
    }),
    slideWith({
      heading: "Sales have grown for six months",
      bullets: ["Lunch orders doubled", "Delivery is a third of revenue", "Repeat buyers are up"],
    }),
    slideWith({
      kind: "close",
      heading: "Decision needed this month",
      bullets: ["Approve the lease", "Hire two cooks"],
      notes: "Ask for a yes or a no.",
    }),
  ],
};

/** A second company on the same server, for the cases that must not read across tenants. */
export const OTHER_DECK_PERSON = {
  id: "deck-session-b",
  tenantId: "deck-tenant-b",
  orgId: "deck-org-b",
  userId: "deck-user-b",
};

/** A signed-in person's tenant, created on first use. */
export async function deckTenant(person = DECK_PERSON): Promise<Awaited<ReturnType<typeof getTenant>>> {
  await ensurePortalOwner(db, {
    tenantId: person.tenantId,
    orgId: person.orgId,
    userId: person.userId,
    role: "owner",
  });
  return getTenant({ session: person });
}

/** Open a stored deck (base64 of the zip) and read its slide, notes and every other XML part. */
export async function openDeck(base64: string) {
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
    parts: async () =>
      Promise.all(
        Object.keys(zip.files)
          .filter((name) => /\.(xml|rels)$/.test(name))
          .map(async (name) => ({ name, text: (await zip.file(name)?.async("string")) ?? "" })),
      ),
  };
}
