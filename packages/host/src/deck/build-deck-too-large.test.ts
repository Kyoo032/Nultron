/**
 * `build_deck` and the artifact body cap.
 *
 * The per-field limits keep any outline the tool accepts far below the cap (the largest legal deck is a
 * few hundred kilobytes), so the cap is a second line of defence that real input cannot reach. It is
 * still code that decides whether a row is written, so it is driven here with an exporter that answers a
 * file past it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "@agentforge/db";
import { artifactStore } from "../artifacts";
import "../tenant-storage-db";
import { buildDeckForTenant } from "./build-deck";
import { deckTenant, SAMPLE_DECK } from "./deck-test-fixtures";

process.env.AGENTFORGE_SECRETS_KEY = "3f8a1c05d97e26b4084fa3c1e5d7290b6c48af13e02d95b7ca6318fd4e7092a5";

/** Past 3 MiB of file, which is past 4 MiB once base64 encoded. */
const OVERSIZE_FILE_BYTES = 3 * 1024 * 1024 + 100_000;

vi.mock("../presentation-pptx", () => ({
  buildPresentationPptx: async () => ({ buffer: new ArrayBuffer(OVERSIZE_FILE_BYTES), filename: "heavy.pptx" }),
}));

let tenant: Awaited<ReturnType<typeof deckTenant>>;

beforeAll(async () => {
  tenant = await deckTenant();
});

afterEach(() => {
  sql.prepare("DELETE FROM artifacts").run();
});

afterAll(() => {
  sql.close();
});

describe("a file past the artifact body cap", () => {
  it("answers too_large to the model, with what to shorten, and saves nothing", async () => {
    const result = await buildDeckForTenant(SAMPLE_DECK, tenant);
    expect(result).toMatchObject({ ok: false, reason: "too_large" });
    expect(result.ok ? "" : result.message).toMatch(/shorten/i);
    expect(artifactStore().list(tenant, "presentations")).toHaveLength(0);
  });
});
