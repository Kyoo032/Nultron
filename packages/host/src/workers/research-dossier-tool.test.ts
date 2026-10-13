import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type TenantContext } from "@agentforge/core";
import type { JobEvent } from "@agentforge/core/jobs";
import { generateResearchNotes } from "../research-generate";
import { RESEARCH_DOSSIER_TOOL_KEY, researchDossierTool, runResearchWorker } from "./research-dossier-tool";
import { withWorkerChannel, type WorkerChannel } from "./worker-channel";

/**
 * The Research harness as a tool of the Research agent's conversation. The harness itself
 * (`generateResearchNotes`) is replaced here: what is proven is how its result is cut down for the
 * model, how its failures are named, and how the chat run's progress and cancel reach it.
 */
vi.mock("../research-generate", () => ({ generateResearchNotes: vi.fn() }));

const generate = vi.mocked(generateResearchNotes);

const tenant = {
  organizationId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
} as unknown as TenantContext;

const QUESTION = "What changed in Indonesian e-invoicing rules this year?";

type Result = Awaited<ReturnType<typeof generateResearchNotes>>;

function source(url: string, title = "") {
  return { url, title, snippet: "" };
}

function note(heading: string, sources: ReturnType<typeof source>[] = []) {
  return { heading, body: `${heading} body`, sources };
}

function resultWith(overrides: Record<string, unknown> = {}): Result {
  return {
    title: "E-invoicing in Indonesia",
    summary: "A short summary.",
    notes: [note("Rules", [source("https://a.example/1")])],
    artifactId: "art-1",
    dossierId: "art-1",
    dossier: { title: "E-invoicing in Indonesia", markdown: "# E-invoicing" },
    checks: { passed: true, rounds: 0, verdicts: [{ ok: true }] },
    ...overrides,
  } as unknown as Result;
}

function failedVerdict(check: string, error: string) {
  return { ok: false as const, check, error, why: "because", fix: "do this" };
}

beforeEach(() => {
  generate.mockReset();
});

describe("runResearchWorker, a good result", () => {
  it("maps it to the card the model is told about", async () => {
    generate.mockResolvedValue(resultWith());

    const out = await runResearchWorker({ question: QUESTION }, tenant);

    expect(out).toEqual({
      ok: true,
      queries: [],
      artifact: { id: "art-1", kind: "research", title: "E-invoicing in Indonesia" },
      summary: "A short summary.",
      sections: ["Rules"],
      sourceCount: 1,
      checks: { passed: true, rounds: 0, failed: [] },
    });
  });

  it("lists every search the harness asked for, in order, so the tool row can show them", async () => {
    generate.mockImplementation(async (_tenant, _body, emit) => {
      emit?.({ type: "job.phase", phase: "searching", label: "Searching the web" });
      emit?.({ type: "job.step", phase: "searching", label: "e-faktur 2025 rules", current: 1, total: 2 });
      emit?.({ type: "job.step", phase: "reading", label: "A page title", current: 1, total: 1 });
      emit?.({ type: "job.step", phase: "searching", label: "coretax e-invoicing", current: 2, total: 2 });
      return resultWith();
    });

    const out = await runResearchWorker({ question: QUESTION }, tenant);

    expect(out.queries).toEqual(["e-faktur 2025 rules", "coretax e-invoicing"]);
  });

  it("keeps the searches it asked for when the harness fails", async () => {
    generate.mockImplementation(async (_tenant, _body, emit) => {
      emit?.({ type: "job.step", phase: "searching", label: "refused query", current: 1, total: 1 });
      throw new ApiError("outbound_refused", "Not sent.", 400);
    });

    const out = await runResearchWorker({ question: QUESTION }, tenant);

    expect(out).toEqual({
      ok: false,
      queries: ["refused query"],
      reason: "failed",
      code: "outbound_refused",
      message: "Not sent.",
    });
  });

  it("keeps an artifact id of null when the dossier could not be saved", async () => {
    generate.mockResolvedValue(resultWith({ artifactId: null, dossierId: null }));

    const out = await runResearchWorker({ question: QUESTION }, tenant);

    expect(out).toMatchObject({ ok: true, artifact: { id: null, kind: "research" } });
  });

  it("clips a long summary to 1200 characters, ending in an ellipsis", async () => {
    generate.mockResolvedValue(resultWith({ summary: `${"word ".repeat(600)}` }));

    const out = await runResearchWorker({ question: QUESTION }, tenant);

    expect(out.ok).toBe(true);
    const summary = out.ok ? out.summary : "";
    expect(summary.length).toBeLessThanOrEqual(1200);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("leaves a summary of exactly 1200 characters alone", async () => {
    const exact = "a".repeat(1200);
    generate.mockResolvedValue(resultWith({ summary: exact }));

    const out = await runResearchWorker({ question: QUESTION }, tenant);

    expect(out.ok && out.summary).toBe(exact);
  });

  it("trims the summary", async () => {
    generate.mockResolvedValue(resultWith({ summary: "  padded  \n" }));

    const out = await runResearchWorker({ question: QUESTION }, tenant);

    expect(out.ok && out.summary).toBe("padded");
  });

  it("lists the note headings, at most twelve", async () => {
    const notes = Array.from({ length: 15 }, (_, index) => note(`Section ${index + 1}`));
    generate.mockResolvedValue(resultWith({ notes }));

    const out = await runResearchWorker({ question: QUESTION }, tenant);

    expect(out.ok && out.sections).toHaveLength(12);
    expect(out.ok && out.sections[0]).toBe("Section 1");
    expect(out.ok && out.sections[11]).toBe("Section 12");
  });

  it("counts distinct sources across notes: the same url twice counts once", async () => {
    generate.mockResolvedValue(
      resultWith({
        notes: [
          note("One", [source("https://a.example/1"), source("https://b.example/2")]),
          note("Two", [source("https://a.example/1"), source("https://c.example/3")]),
        ],
      }),
    );

    const out = await runResearchWorker({ question: QUESTION }, tenant);

    expect(out.ok && out.sourceCount).toBe(3);
  });

  it("identifies a source with no url by its title, and skips one with neither", async () => {
    generate.mockResolvedValue(
      resultWith({
        notes: [
          note("One", [source("", "Annual report"), source("", "Annual report"), source("", "")]),
          note("Two", [source("https://a.example/1")]),
        ],
      }),
    );

    const out = await runResearchWorker({ question: QUESTION }, tenant);

    expect(out.ok && out.sourceCount).toBe(2);
  });

  it("lists failed checks as { check, error } and leaves out the ones that passed", async () => {
    generate.mockResolvedValue(
      resultWith({
        checks: {
          passed: false,
          rounds: 1,
          verdicts: [{ ok: true }, failedVerdict("cites-source", "Finding 2 has no source"), { ok: true }],
        },
      }),
    );

    const out = await runResearchWorker({ question: QUESTION }, tenant);

    expect(out.ok && out.checks).toEqual({
      passed: false,
      rounds: 1,
      failed: [{ check: "cites-source", error: "Finding 2 has no source" }],
    });
  });
});

describe("runResearchWorker, what it passes on", () => {
  it("hands the harness { prompt: question } and nothing else from the arguments", async () => {
    generate.mockResolvedValue(resultWith());

    await runResearchWorker({ question: QUESTION, model: "gpt-x", extra: true } as never, tenant);

    expect(generate).toHaveBeenCalledTimes(1);
    const [calledTenant, body] = generate.mock.calls[0] ?? [];
    expect(calledTenant).toBe(tenant);
    expect(body).toEqual({ prompt: QUESTION });
  });

  it("sends the harness's progress to the chat run's channel under the tool key", async () => {
    const phase: JobEvent = { type: "job.phase", phase: "searching", label: "Searching the web" };
    generate.mockImplementation(async (_tenant, _body, emit) => {
      emit?.(phase);
      return resultWith();
    });
    const channel: WorkerChannel & { emit: ReturnType<typeof vi.fn> } = { emit: vi.fn() };

    await withWorkerChannel(channel, () => runResearchWorker({ question: QUESTION }, tenant));

    expect(channel.emit).toHaveBeenCalledWith(RESEARCH_DOSSIER_TOOL_KEY, phase);
  });

  it("gives the harness the run's cancel signal", async () => {
    generate.mockResolvedValue(resultWith());
    const controller = new AbortController();

    await withWorkerChannel({ emit: vi.fn(), signal: controller.signal }, () =>
      runResearchWorker({ question: QUESTION }, tenant),
    );

    expect(generate.mock.calls[0]?.[3]).toBe(controller.signal);
  });

  it("works with no chat run around it", async () => {
    generate.mockResolvedValue(resultWith());

    const out = await runResearchWorker({ question: QUESTION }, tenant);

    expect(out.ok).toBe(true);
    expect(generate.mock.calls[0]?.[3]).toBeUndefined();
  });
});

describe("runResearchWorker, failures", () => {
  it("turns an ApiError into { ok: false, reason: 'failed' } with its code and message", async () => {
    generate.mockRejectedValue(new ApiError("runtime_stub", "A gateway key is needed for research.", 503));

    const out = await runResearchWorker({ question: QUESTION }, tenant);

    expect(out).toEqual({
      ok: false,
      queries: [],
      reason: "failed",
      code: "runtime_stub",
      message: "A gateway key is needed for research.",
    });
  });

  it("names any other error internal_error and keeps its message", async () => {
    generate.mockRejectedValue(new Error("socket hang up"));

    const out = await runResearchWorker({ question: QUESTION }, tenant);

    expect(out).toEqual({
      ok: false,
      queries: [],
      reason: "failed",
      code: "internal_error",
      message: "socket hang up",
    });
  });

  it("gives a plain sentence for something that is not an Error", async () => {
    generate.mockRejectedValue("nope");

    const out = await runResearchWorker({ question: QUESTION }, tenant);

    expect(out).toMatchObject({
      ok: false,
      reason: "failed",
      code: "internal_error",
      message: "The dossier could not be written.",
    });
  });

  it("reports a cancel, not a failure, when the run's signal was aborted and the harness threw", async () => {
    const controller = new AbortController();
    generate.mockImplementation(async () => {
      controller.abort();
      throw new ApiError("cancelled", "Aborted", 499);
    });

    const out = await withWorkerChannel({ emit: vi.fn(), signal: controller.signal }, () =>
      runResearchWorker({ question: QUESTION }, tenant),
    );

    expect(out).toMatchObject({ ok: false, reason: "cancelled", code: "cancelled" });
    expect(out.ok === false && out.message.length).toBeGreaterThan(0);
  });

  it("still reports a failure when the signal is not aborted", async () => {
    const controller = new AbortController();
    generate.mockRejectedValue(new Error("search failed"));

    const out = await withWorkerChannel({ emit: vi.fn(), signal: controller.signal }, () =>
      runResearchWorker({ question: QUESTION }, tenant),
    );

    expect(out).toMatchObject({ ok: false, reason: "failed", code: "internal_error" });
  });
});

describe("the tool definition", () => {
  it("is keyed research_dossier and internal", () => {
    expect(researchDossierTool.key).toBe("research_dossier");
    expect(RESEARCH_DOSSIER_TOOL_KEY).toBe("research_dossier");
    expect(researchDossierTool.trust).toBe("network");
  });

  it("refuses a question shorter than 8 characters, after trimming", () => {
    expect(researchDossierTool.schema.safeParse({ question: "short" }).success).toBe(false);
    expect(researchDossierTool.schema.safeParse({ question: "   seven   " }).success).toBe(false);
    expect(researchDossierTool.schema.safeParse({}).success).toBe(false);
  });

  it("accepts an 8 character question and trims it", () => {
    const parsed = researchDossierTool.schema.safeParse({ question: "  eightchr  " });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.question).toBe("eightchr");
  });

  it("refuses a question over 2000 characters", () => {
    expect(researchDossierTool.schema.safeParse({ question: "q".repeat(2001) }).success).toBe(false);
    expect(researchDossierTool.schema.safeParse({ question: "q".repeat(2000) }).success).toBe(true);
  });

  it("executes through the worker", async () => {
    generate.mockResolvedValue(resultWith());

    const out = await researchDossierTool.execute({ question: QUESTION }, tenant);

    expect(out).toMatchObject({ ok: true, artifact: { id: "art-1" } });
    expect(generate.mock.calls[0]?.[1]).toEqual({ prompt: QUESTION });
  });
});
