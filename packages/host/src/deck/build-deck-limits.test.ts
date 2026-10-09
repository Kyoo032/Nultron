/**
 * `build_deck`: the limits the host enforces and explains, and the characters it removes.
 *
 * The tool schema the SDK checks sets no length or count ceiling (an overrun there ends the whole turn,
 * see `build-deck-run.test.ts`), so every ceiling is read here, from the text after it has been trimmed
 * and cleaned, and answered as a refusal the model can act on.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "@agentforge/db";
import { artifactStore } from "../artifacts";
import { forgetTenantJobBytes, resetObjectStoreForTests } from "../tenant-storage";
import "../tenant-storage-db";
import { firstXmlIllegalChar } from "../xml-test-support";
import { buildDeckForTenant } from "./build-deck";
import type { BuildDeckInput } from "./deck-schema";
import { deckTenant, deckWith, openDeck, slideWith } from "./deck-test-fixtures";

process.env.AGENTFORGE_SECRETS_KEY = "3f8a1c05d97e26b4084fa3c1e5d7290b6c48af13e02d95b7ca6318fd4e7092a5";

let tenant: Awaited<ReturnType<typeof deckTenant>>;

beforeAll(async () => {
  tenant = await deckTenant();
});

afterEach(() => {
  sql.prepare("DELETE FROM artifacts").run();
  resetObjectStoreForTests();
  forgetTenantJobBytes();
});

afterAll(() => {
  sql.close();
});

describe("the limits the host enforces and explains (the tool schema sets none)", () => {
  it("answers a refusal that names the field, the limit and what was sent, and saves nothing", async () => {
    const before = artifactStore().list(tenant, "presentations").length;
    const result = await buildDeckForTenant(deckWith({ notes: "n".repeat(2100) }), tenant);
    expect(result).toMatchObject({ ok: false, reason: "limits" });
    if (result.ok) {
      return;
    }
    expect(result.message).toContain("slides[0].notes");
    expect(result.message).toContain("2100");
    expect(result.message).toContain("2000");
    expect(result.message).toMatch(/call build_deck again/i);
    expect(artifactStore().list(tenant, "presentations")).toHaveLength(before);
  });

  it.each([
    ["the title", deckWith({}, "t".repeat(201)), "title", 201, 200],
    ["a heading", deckWith({ heading: "h".repeat(201) }), "slides[0].heading", 201, 200],
    ["a subhead", deckWith({ subhead: "s".repeat(301) }), "slides[0].subhead", 301, 300],
    ["an aside", deckWith({ kind: "split", aside: "a".repeat(601) }), "slides[0].aside", 601, 600],
    ["the notes", deckWith({ notes: "n".repeat(2001) }), "slides[0].notes", 2001, 2000],
    ["a bullet", deckWith({ bullets: ["ok", "b".repeat(401)] }), "slides[0].bullets[1]", 401, 400],
    [
      "the bullet count",
      deckWith({ bullets: Array.from({ length: 13 }, (_, i) => `b${i}`) }),
      "slides[0].bullets",
      13,
      12,
    ],
    [
      "the slide count",
      {
        title: "Plan",
        slides: Array.from({ length: 15 }, (_, i) => slideWith({ heading: `Claim number ${i}` })),
      } satisfies BuildDeckInput,
      "slides",
      15,
      14,
    ],
  ])("refuses %s over its limit", async (_name, input, path, sent, limit) => {
    const result = await buildDeckForTenant(input, tenant);
    expect(result).toMatchObject({ ok: false, reason: "limits" });
    const message = result.ok ? "" : result.message;
    expect(message).toContain(path);
    expect(message).toContain(String(sent));
    expect(message).toContain(String(limit));
  });

  it("lists every overrun in one answer, so the model fixes them in one call", async () => {
    const input = deckWith(
      { notes: "n".repeat(2100), subhead: "s".repeat(350), bullets: Array.from({ length: 13 }, (_, i) => `b${i}`) },
      "t".repeat(250),
    );
    const result = await buildDeckForTenant(input, tenant);
    const message = result.ok ? "" : result.message;
    for (const path of ["title", "slides[0].notes", "slides[0].subhead", "slides[0].bullets"]) {
      expect(message, path).toContain(path);
    }
  });

  it("stops the list at ten and says how many more there were", async () => {
    const input: BuildDeckInput = {
      title: "Plan",
      slides: Array.from({ length: 14 }, (_, i) =>
        slideWith({ heading: `Claim number ${i}`, notes: "n".repeat(2100) }),
      ),
    };
    const result = await buildDeckForTenant(input, tenant);
    const message = result.ok ? "" : result.message;
    expect(message).toContain("slides[9].notes");
    expect(message).not.toContain("slides[10].notes");
    expect(message).toMatch(/and 4 more/);
  });

  it("measures the text after it is trimmed and cleaned, not before", async () => {
    // 2,500 characters of notes, 2,000 of them text; a 270-character heading, 12 of them text.
    const padded = deckWith({
      notes: `${"n".repeat(2000)}${" ".repeat(500)}`,
      heading: `${"\u0000".repeat(250)}Sales grew${"\u0001".repeat(10)}`,
    });
    await expect(buildDeckForTenant(padded, tenant)).resolves.toMatchObject({ ok: true });
  });

  it("refuses an empty title, an empty heading and an empty deck by name", async () => {
    const noTitle = await buildDeckForTenant({ ...deckWith(), title: "   " }, tenant);
    expect(noTitle).toMatchObject({ ok: false, reason: "limits" });
    expect(noTitle.ok ? "" : noTitle.message).toContain("title");
    const noHeading = await buildDeckForTenant(deckWith({ heading: "\u0000  " }), tenant);
    expect(noHeading).toMatchObject({ ok: false, reason: "limits" });
    expect(noHeading.ok ? "" : noHeading.message).toContain("slides[0].heading");
    const noSlides = await buildDeckForTenant({ title: "Plan", slides: [] }, tenant);
    expect(noSlides).toMatchObject({ ok: false, reason: "limits" });
    expect(noSlides.ok ? "" : noSlides.message).toContain("slides");
  });

  it("drops a bullet that is only blank rather than refusing the deck", async () => {
    const result = await buildDeckForTenant(
      deckWith({ bullets: ["First point", "   ", "\u0000", "Second point"] }),
      tenant,
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) {
      return;
    }
    const deck = await openDeck(artifactStore().get(tenant, result.artifactId)?.body ?? "");
    const text = deck.slides.join("\n");
    expect(text.match(/First point|Second point/g)).toHaveLength(2);
  });

  it("does not change the outline it was handed, whether it saves it or refuses it", async () => {
    const frozen = (input: BuildDeckInput): BuildDeckInput => {
      const copy = structuredClone(input);
      for (const slide of copy.slides) {
        Object.freeze(slide.bullets);
        Object.freeze(slide);
      }
      Object.freeze(copy.slides);
      return Object.freeze(copy);
    };
    await expect(buildDeckForTenant(frozen(deckWith({ notes: "n".repeat(2100) })), tenant)).resolves.toMatchObject({
      ok: false,
      reason: "limits",
    });
    await expect(
      buildDeckForTenant(frozen(deckWith({ notes: "n\u000c", bullets: ["a", " ", "b"] })), tenant),
    ).resolves.toMatchObject({ ok: true });
  });
});

describe("text with characters XML cannot hold (a form feed from a PDF, a stray NUL)", () => {
  it("writes a file with no such character in any part, and still carries the words", async () => {
    const dirty: BuildDeckInput = {
      title: "Plan\u0000 2027",
      slides: [
        slideWith({
          heading: "Why\u0008 now",
          subhead: "Sub\u000bline",
          bullets: ["Lunch\u000corders doubled", "Delivery\u001b is a third"],
          notes: "Say it\u0007 slowly",
        }),
      ],
    };
    const result = await buildDeckForTenant(dirty, tenant);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) {
      return;
    }
    const saved = artifactStore().get(tenant, result.artifactId);
    expect(saved?.title).toBe("Plan 2027");
    const deck = await openDeck(saved?.body ?? "");
    const parts = await deck.parts();
    expect(parts.length).toBeGreaterThan(5);
    for (const { name, text } of parts) {
      expect(firstXmlIllegalChar(text), name).toBeNull();
    }
    expect(deck.slides.join("\n")).toContain("Lunch orders doubled");
    expect(deck.notes.join("\n")).toContain("Say it slowly");
  });
});
