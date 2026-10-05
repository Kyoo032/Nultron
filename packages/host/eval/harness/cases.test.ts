import { describe, expect, it } from "vitest";
import { CASES, type CaseContext, type HarnessCase } from "./cases";
import { createTracker } from "./cleanup";
import { createHttp } from "./client";
import { fakeHost, json, sse, type FakeAnswer } from "./fake-host";
import {
  CHAT_PLAIN_PROMPT,
  CHAT_TOOL_PROMPT,
  DATA_PROMPT,
  DOCUMENT_PROMPT,
  DOCUMENT_SOURCE,
  PRESENTATION_PROMPT,
  RESEARCH_PROMPT,
  SALES_CSV,
} from "./fixtures";

const BASE = "http://127.0.0.1:3000";
const DESK = { workspaceId: "w1", agentId: "agent-1", defaultModel: "model-a" };

function caseById(id: string): HarnessCase {
  const found = CASES.find((item) => item.id === id);
  if (!found) {
    throw new Error(`no case ${id}`);
  }
  return found;
}

function contextFor(answers: Record<string, FakeAnswer>, known: string[] = []) {
  const host = fakeHost(answers);
  const tracker = createTracker();
  const context: CaseContext = {
    http: createHttp({ base: BASE, fetch: host.fetch }),
    tracker,
    desk: DESK,
    knownArtifacts: new Set(known),
  };
  return { context, tracker, seen: host.seen };
}

const chatRoutes = (events: Array<Record<string, unknown>>, persisted = true): Record<string, FakeAnswer> => ({
  "POST /api/v1/threads": json({ thread: { id: "t1" } }, 201),
  "POST /api/v1/threads/t1/runs/text": () => sse(events),
  "GET /api/v1/threads/t1": json({
    thread: { id: "t1" },
    messages: persisted ? [{ role: "user" }, { role: "assistant" }] : [{ role: "user" }],
  }),
});

describe("the six cases", () => {
  it("are chat-plain, chat-tool, data, documents, presentation and research, once each", () => {
    expect(CASES.map((item) => item.id)).toEqual([
      "chat-plain",
      "chat-tool",
      "data",
      "documents",
      "presentation",
      "research",
    ]);
  });
});

describe("chat-plain", () => {
  it("opens a thread on the desk's agent, posts the prompt with the default model, and reads the reply", async () => {
    const { context, tracker, seen } = contextFor(
      chatRoutes([
        { type: "run.started", runId: "r1" },
        { type: "assistant.delta", text: "Ready" },
        { type: "run.completed", runId: "r1", usage: { model: "model-a", inputTokens: 9, outputTokens: 2 } },
      ]),
    );
    const outcome = await caseById("chat-plain").run(context);
    expect(seen.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /api/v1/threads",
      "POST /api/v1/threads/t1/runs/text",
      "GET /api/v1/threads/t1",
    ]);
    expect(seen[0]?.body).toEqual({ agentId: "agent-1" });
    expect(seen[1]?.body).toEqual({ content: CHAT_PLAIN_PROMPT, model: "model-a" });
    expect(outcome).toEqual({
      completed: true,
      error: null,
      model: "model-a",
      toolCalls: [],
      toolCallSource: "none",
      checkFailures: [],
      expectFailures: [],
      artifactId: null,
      detail: {
        events: 3,
        textChars: 5,
        contactAttempts: 0,
        toolFailures: 0,
        inputTokens: 9,
        outputTokens: 2,
        persistedAssistant: true,
        malformedFrames: 0,
      },
    });
    expect(tracker.snapshot().threads).toEqual(["t1"]);
  });

  it("reports a closed gateway gate as the error and still tracks the thread", async () => {
    const { context, tracker } = contextFor({
      "POST /api/v1/threads": json({ thread: { id: "t1" } }, 201),
      "POST /api/v1/threads/t1/runs/text": json(
        { error: "gateway_blocked", status: "needs_key", message: "Add a key." },
        403,
      ),
    });
    const outcome = await caseById("chat-plain").run(context);
    expect(outcome.completed).toBe(false);
    expect(outcome.error).toBe("HTTP 403 gateway_blocked: Add a key.");
    expect(tracker.snapshot().threads).toEqual(["t1"]);
  });

  it("is not completed when the reply never persisted", async () => {
    const { context } = contextFor(
      chatRoutes(
        [
          { type: "assistant.delta", text: "ready" },
          { type: "run.completed", runId: "r1" },
        ],
        false,
      ),
    );
    const outcome = await caseById("chat-plain").run(context);
    expect(outcome.completed).toBe(false);
    expect(outcome.error).toBe("the assistant message was not saved on the thread");
  });
});

describe("chat-tool", () => {
  it("records the calculator call and expects it", async () => {
    const events = [
      { type: "run.started", runId: "r1" },
      { type: "tool.started", toolKey: "calculator", input: { expression: "2340*0.175" } },
      { type: "tool.completed", toolKey: "calculator", output: { success: true, result: 409.5 } },
      { type: "assistant.delta", text: "17.5% of 2340 is 409.5." },
      { type: "run.completed", runId: "r1" },
    ];
    const { context, seen } = contextFor(chatRoutes(events));
    const outcome = await caseById("chat-tool").run(context);
    expect(seen[1]?.body).toEqual({ content: CHAT_TOOL_PROMPT, model: "model-a" });
    expect(outcome.completed).toBe(true);
    expect(outcome.toolCalls).toEqual(["calculator"]);
    expect(outcome.toolCallSource).toBe("tool.started");
    expect(outcome.expectFailures).toEqual([]);
  });

  it("names both unmet expectations when the model answers from its head", async () => {
    const { context } = contextFor(
      chatRoutes([
        { type: "assistant.delta", text: "About 410." },
        { type: "run.completed", runId: "r1" },
      ]),
    );
    const outcome = await caseById("chat-tool").run(context);
    expect(outcome.completed).toBe(true);
    expect(outcome.expectFailures).toEqual(["the calculator tool was called", "the reply states 409.5"]);
  });
});

describe("data", () => {
  const jobEvents = [
    { type: "job.phase", phase: "profiling", label: "Profiling" },
    { type: "job.phase", phase: "analyzing", label: "Querying" },
    {
      type: "job.step",
      phase: "analyzing",
      label: "SELECT region, SUM(units) FROM data GROUP BY region",
      detail: "4 rows",
      current: 1,
      total: 8,
    },
    { type: "job.phase", phase: "saving", label: "Saving" },
    {
      type: "job.done",
      result: {
        artifactId: "art-1",
        markdown: "# Regional units\n\nEast sold the most: 610 units.",
        analysis: { findings: [{ heading: "East leads", body: "East sold 610 units." }] },
      },
    },
  ];

  it("uploads the CSV as multipart, tracks the dataset, and reads run_sql from the job steps", async () => {
    const { context, tracker, seen } = contextFor({
      "POST /api/v1/datasets": json({ id: "ds-1", rows: 20 }, 201),
      "POST /api/v1/data/stream": () => sse(jobEvents),
      "GET /api/v1/artifacts/art-1": json({ id: "art-1", meta: { model: "model-b" } }),
    });
    const outcome = await caseById("data").run(context);

    const form = seen[0]?.body as FormData;
    const file = form.get("file") as File;
    expect(file.name).toBe("harness-sales.csv");
    expect(await file.text()).toBe(SALES_CSV);
    expect(seen[1]?.body).toEqual({ prompt: DATA_PROMPT, datasetId: "ds-1" });

    expect(outcome).toEqual({
      completed: true,
      error: null,
      model: "model-b",
      toolCalls: ["run_sql"],
      toolCallSource: "job.step",
      checkFailures: [],
      expectFailures: [],
      artifactId: "art-1",
      detail: { datasetRows: 20, sqlQueries: 1, findings: 1, events: 5, malformedFrames: 0 },
    });
    expect(tracker.snapshot()).toEqual({ threads: [], datasets: ["ds-1"], artifacts: ["art-1"] });
  });

  it("reports a failed evidence query as an API check failure", async () => {
    const result = {
      artifactId: "art-1",
      markdown: "East 610",
      analysis: {
        findings: [
          { heading: "East leads", body: "East sold 610.\n\n(Evidence query failed: no such column: reigon)" },
        ],
      },
    };
    const events = [...jobEvents.slice(0, 2), jobEvents[2] as Record<string, unknown>, { type: "job.done", result }];
    const { context } = contextFor({
      "POST /api/v1/datasets": json({ id: "ds-1", rows: 20 }, 201),
      "POST /api/v1/data/stream": () => sse(events),
      "GET /api/v1/artifacts/art-1": json({ meta: {} }),
    });
    const outcome = await caseById("data").run(context);
    expect(outcome.checkFailures).toEqual(["evidence query failed: East leads: no such column: reigon"]);
    expect(outcome.model).toBeNull();
  });

  it("ends not completed on a job.error and says what the host said", async () => {
    const { context } = contextFor({
      "POST /api/v1/datasets": json({ id: "ds-1", rows: 20 }, 201),
      "POST /api/v1/data/stream": () =>
        sse([
          { type: "job.phase", phase: "profiling", label: "p" },
          { type: "job.error", code: "generation_failed", message: "empty analysis", status: 502 },
        ]),
    });
    const outcome = await caseById("data").run(context);
    expect(outcome.completed).toBe(false);
    expect(outcome.error).toBe("empty analysis");
    expect(outcome.artifactId).toBeNull();
  });
});

describe("documents and presentation", () => {
  it("documents: posts the prompt with the source, finds the artifact it saved, reads the draft", async () => {
    const draft = {
      title: "Briefing",
      sections: [
        { heading: "What changed", body: "The branch seats 40 guests." },
        { heading: "What it costs", body: "Rent is 18 million rupiah." },
        { heading: "What next", body: "Add online ordering." },
      ],
    };
    const { context, tracker, seen } = contextFor(
      {
        "POST /api/v1/documents": json(draft),
        "GET /api/v1/artifacts?mode=documents": json({
          items: [
            { id: "art-old", mode: "documents", meta: { question: DOCUMENT_PROMPT } },
            { id: "art-new", mode: "documents", meta: { question: DOCUMENT_PROMPT } },
          ],
        }),
        "GET /api/v1/artifacts/art-new": json({ meta: { model: "model-c" } }),
      },
      ["art-old"],
    );
    const outcome = await caseById("documents").run(context);
    expect(seen[0]?.body).toEqual({ prompt: DOCUMENT_PROMPT, sourceText: DOCUMENT_SOURCE });
    expect(outcome.completed).toBe(true);
    expect(outcome.artifactId).toBe("art-new");
    expect(outcome.model).toBe("model-c");
    expect(outcome.expectFailures).toEqual([]);
    expect(outcome.detail).toEqual({ sections: 3, words: 20 });
    expect(tracker.snapshot().artifacts).toEqual(["art-new"]);
  });

  it("presentation: expects exactly three slides", async () => {
    const outline = {
      title: "Online ordering",
      slides: [
        { heading: "Why now", bullets: ["a", "b"] },
        { heading: "Cost", bullets: ["c"] },
      ],
    };
    const { context } = contextFor({
      "POST /api/v1/presentations": json(outline),
      "GET /api/v1/artifacts?mode=presentations": json({
        items: [{ id: "deck-1", mode: "presentations", meta: { question: PRESENTATION_PROMPT } }],
      }),
      "GET /api/v1/artifacts/deck-1": json({ meta: { model: "model-d" } }),
    });
    const outcome = await caseById("presentation").run(context);
    expect(outcome.completed).toBe(true);
    expect(outcome.expectFailures).toEqual(["the outline has 3 slides"]);
    expect(outcome.detail).toEqual({ slides: 2, bullets: 3 });
  });

  it("documents: a refused request is the error, and an artifact found anyway is still tracked", async () => {
    const { context, tracker } = contextFor({
      "POST /api/v1/documents": json({ error: { code: "invalid_document", message: "bad JSON from the model" } }, 502),
      "GET /api/v1/artifacts?mode=documents": json({
        items: [{ id: "late", mode: "documents", meta: { question: DOCUMENT_PROMPT } }],
      }),
    });
    const outcome = await caseById("documents").run(context);
    expect(outcome.completed).toBe(false);
    expect(outcome.error).toBe("HTTP 502 invalid_document: bad JSON from the model");
    expect(tracker.snapshot().artifacts).toEqual(["late"]);
  });
});

describe("research", () => {
  it("reads searches and sources from the job and estimates the model calls", async () => {
    const events = [
      { type: "job.phase", phase: "planning", label: "Planning" },
      { type: "job.phase", phase: "searching", label: "Searching" },
      { type: "job.step", phase: "searching", label: RESEARCH_PROMPT, current: 1, total: 2 },
      { type: "job.step", phase: "searching", label: "postgres default port", current: 2, total: 2 },
      { type: "job.source", id: "s1", title: "Docs", url: "https://a.example", status: "found" },
      { type: "job.source", id: "s2", title: "Wiki", url: "https://b.example", status: "found" },
      { type: "job.source", id: "s1", title: "Docs", url: "https://a.example", status: "read" },
      { type: "job.source", id: "s2", title: "Wiki", url: "https://b.example", status: "unreachable" },
      { type: "job.step", phase: "reading", label: "Docs", current: 1, total: 2 },
      {
        type: "job.done",
        result: {
          artifactId: "dos-1",
          dossierId: "dos-1",
          dossier: { title: "Port", markdown: "PostgreSQL listens on 5432." },
        },
      },
    ];
    const { context, tracker } = contextFor({
      "POST /api/v1/research/stream": () => sse(events),
      "GET /api/v1/artifacts/dos-1": json({ meta: { model: "model-e" } }),
    });
    const outcome = await caseById("research").run(context);
    expect(outcome).toEqual({
      completed: true,
      error: null,
      model: "model-e",
      toolCalls: ["web_search", "web_search"],
      toolCallSource: "job.step",
      checkFailures: [],
      expectFailures: [],
      artifactId: "dos-1",
      detail: {
        searches: 2,
        sourcesFound: 2,
        sourcesRead: 1,
        sourcesUnreachable: 1,
        modelCallsEstimate: 3,
        events: 10,
        malformedFrames: 0,
      },
    });
    expect(tracker.snapshot().artifacts).toEqual(["dos-1"]);
  });

  it("reports the host's refusal when no search is available", async () => {
    const { context } = contextFor({
      "POST /api/v1/research/stream": () =>
        sse([
          { type: "job.phase", phase: "planning", label: "p" },
          { type: "job.error", code: "tool_failed", message: "Search is not set up", status: 503 },
        ]),
    });
    const outcome = await caseById("research").run(context);
    expect(outcome.completed).toBe(false);
    expect(outcome.error).toBe("Search is not set up");
    expect(outcome.toolCalls).toEqual([]);
  });
});
