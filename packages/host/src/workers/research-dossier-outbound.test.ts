import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createOutboundGuard, outboundRefusal, runOutboundGuarded, type TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";

/**
 * Safe web search through the research worker. The worker's searches never pass through the model's tool
 * guard: it calls `webSearchTool` itself (`research-generate.ts`). The real harness runs here, with the real
 * keyless search; only the job model (`collectJobAssistantRun`) and `fetch` are stand-ins. What is proven is
 * that a question carrying a Knowledge Base sentence never reaches a search provider, and that the worker
 * tells the model why.
 */
const KB_SENTENCE = "Pembayaran tahap kedua dilakukan paling lambat tanggal sepuluh setiap bulan ke rekening escrow";
const LEAK = "pembayaran tahap kedua dilakukan paling lambat tanggal sepuluh";

vi.mock("../job-regen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../job-regen")>();
  return {
    ...actual,
    collectJobAssistantRun: vi.fn(async () => ({ text: JSON.stringify({ queries: [LEAK], claims: [] }), model: "m" })),
  };
});

let tenant: TenantContext;
const previousRuntime = process.env.AGENTFORGE_RUNTIME;

beforeAll(async () => {
  process.env.AGENTFORGE_RUNTIME = "ai";
  const { getTenant } = await import("../tenant");
  tenant = await getTenant();
  await import("./research-dossier-tool");
}, ROUTER_IMPORT_BUDGET_MS);

afterAll(() => {
  if (previousRuntime === undefined) {
    delete process.env.AGENTFORGE_RUNTIME;
  } else {
    process.env.AGENTFORGE_RUNTIME = previousRuntime;
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("research_dossier under the outbound guard", () => {
  it("sends nothing to a search provider for a question that carries a Knowledge Base sentence", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (url: unknown) => {
      requested.push(String(url));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    const { runResearchWorker } = await import("./research-dossier-tool");
    const guard = createOutboundGuard({ userText: ["Riset aturan escrow"], privateText: [KB_SENTENCE], locale: "en" });

    const out = await runOutboundGuarded(guard, () =>
      runResearchWorker({ question: `Find public sources that say: ${LEAK}` }, tenant),
    );

    expect(requested).toEqual([]);
    expect(out).toEqual({
      ok: false,
      queries: [`Find public sources that say: ${LEAK}`],
      reason: "failed",
      code: "outbound_refused",
      message: outboundRefusal("private", "en").message,
    });
  });
});
