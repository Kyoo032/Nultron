import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, ChatModel, TenantContext } from "@agentforge/core";
import type { WorkCard } from "./work-cards";

/**
 * A cancel stops the model call, on every job path that reaches the gateway through the job runner.
 *
 * Only the runtime, the artifact store and the Knowledge Base write are stood in for. Everything
 * between a job's entry point and `runtime.execute` is the real code, so these fail if a job
 * stops handing its caller's signal on: the call below stays in flight until the signal fires, as a
 * slow gateway's would, and the stand-in runtime records whether it saw the abort.
 */
type ExecuteInput = Parameters<AgentRuntime["execute"]>[0];

const executed: ExecuteInput[] = [];
/** What each in-flight call saw on its signal when it woke. */
const observedAborted: boolean[] = [];
const created: unknown[] = [];
const ingested: WorkCard[] = [];

vi.mock("@agentforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentforge/core")>();
  return {
    ...actual,
    createRuntime: (): AgentRuntime => ({
      async execute(input) {
        executed.push(input);
        // Like the real runtime: the call ends when the caller's signal fires, with its reason.
        await new Promise<void>((resolve) => input.signal?.addEventListener("abort", () => resolve(), { once: true }));
        observedAborted.push(input.signal?.aborted === true);
        throw input.signal?.reason;
      },
    }),
  };
});

vi.mock("./artifacts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./artifacts")>();
  return {
    ...actual,
    artifactStore: () => ({
      create: (_tenant: TenantContext, input: unknown) => {
        created.push(input);
        return { id: "artifact-1" };
      },
    }),
  };
});

vi.mock("./knowledge-ingest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./knowledge-ingest")>();
  return {
    ...actual,
    upsertWorkSource: async (_tenant: TenantContext, card: WorkCard) => {
      ingested.push(card);
      return { status: "skipped" as const, reason: "test" };
    },
  };
});

const CATALOG = ["deepseek-v4-flash", "gpt-5.6-luna", "gpt-5.6-sol"].map(
  (id): ChatModel => ({ id, label: id, provider: "openai", inputModalities: ["text", "image"] }) as ChatModel,
);

vi.mock("./selectable-models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./selectable-models")>();
  return { ...actual, listSelectableModels: () => CATALOG };
});

const { generateDocumentDraft, regenerateDocumentSection } = await import("./document-generate");
const { generatePresentationOutline, regeneratePresentationSlide } = await import("./presentation-generate");
const { generateOpenSlideDeck } = await import("./open-slide-generate");
const { analyzeDataset } = await import("./data-generate");

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org",
  workspaceId: "ws-cancel-paths",
  userId: "local",
  role: "owner",
};

const MODEL = "deepseek-v4-flash";

const DRAFT = {
  title: "Vendor switch memo",
  sections: [{ heading: "What changes on Monday", body: "The new vendor takes over billing." }],
};

const OUTLINE = {
  title: "Vendor switch",
  slides: [
    { kind: "bullets", heading: "We switch on Monday", subhead: "", bullets: ["Billing moves"], aside: "", notes: "" },
    { kind: "close", heading: "Approve by Friday", subhead: "", bullets: [], aside: "", notes: "" },
  ],
};

const CASES: Array<{ name: string; start: (signal: AbortSignal) => Promise<unknown> }> = [
  {
    name: "a Documents draft",
    start: (signal) => generateDocumentDraft(tenant, { prompt: "Write the vendor memo", model: MODEL }, signal),
  },
  {
    name: "a Documents section rewrite",
    start: (signal) => regenerateDocumentSection(tenant, { draft: DRAFT, sectionIndex: 0, model: MODEL }, signal),
  },
  {
    name: "a Presentation outline",
    start: (signal) => generatePresentationOutline(tenant, { prompt: "Vendor switch deck", model: MODEL }, signal),
  },
  {
    name: "a Presentation slide rewrite",
    start: (signal) => regeneratePresentationSlide(tenant, { outline: OUTLINE, slideIndex: 0, model: MODEL }, signal),
  },
  {
    name: "an Open Slide deck",
    start: (signal) => generateOpenSlideDeck(tenant, { prompt: "Vendor switch deck", model: MODEL }, signal),
  },
  {
    name: "a Data analysis",
    start: (signal) =>
      analyzeDataset(
        tenant,
        { prompt: "Who spends most?", csv: "vendor,spend\nAcme,12000\nBeta,4100", model: MODEL },
        () => {},
        signal,
      ),
  },
];

describe("a cancel reaches the model call of each job", () => {
  beforeEach(() => {
    executed.length = 0;
    observedAborted.length = 0;
    created.length = 0;
    ingested.length = 0;
    vi.stubEnv("AGENTFORGE_RUNTIME", "ai");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(CASES)(
    "$name: the runtime gets the caller's signal, sees it fire, and nothing is saved",
    async ({ start }) => {
      const controller = new AbortController();
      const outcome = start(controller.signal).then(
        () => "resolved",
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(executed).toHaveLength(1));
      expect(executed[0]?.signal).toBe(controller.signal);
      expect(executed[0]?.signal?.aborted).toBe(false);

      controller.abort(new Error("client left"));

      // The job's own 499, not a model failure: the stream reports it as cancelled.
      expect(await outcome).toMatchObject({ code: "aborted", status: 499 });
      expect(observedAborted).toEqual([true]);
      // No stand-in model was tried, and nothing the person cancelled was saved.
      expect(executed.map((input) => input.version.model)).toEqual([MODEL]);
      expect(created).toEqual([]);
      expect(ingested).toEqual([]);
    },
  );
});
