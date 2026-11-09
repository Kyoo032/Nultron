import { describe, expect, it, vi } from "vitest";
import { fetchPublicHttps } from "@agentforge/core";

vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

describe("host test network tripwire", () => {
  it("refuses a guarded fetch to a public host, so a test without a mock fails instead of calling out", async () => {
    await expect(fetchPublicHttps("https://tripwire.example/page")).rejects.toThrow(
      /Host vitest tried to reach tripwire\.example/,
    );
  });
});
