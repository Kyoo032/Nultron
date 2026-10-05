/**
 * The six smoke cases. Each drives one mode through the same public routes its studio uses, once,
 * with a short synthetic input, and reports how it ended. A case reports; it never throws for a
 * product failure (the runner catches a throw and records it as a failed row).
 *
 * Routes, from `packages/host/src/router.ts`:
 *   Chat          POST /threads, POST /threads/:id/runs/text            (SSE: RuntimeEvent)
 *   Data          POST /datasets (multipart), POST /data/stream         (SSE: JobEvent)
 *   Documents     POST /documents                                        (JSON draft, no stream)
 *   Presentation  POST /presentations                                    (JSON outline, no stream)
 *   Research      POST /research/stream                                  (SSE: JobEvent)
 */
import { findNewArtifacts, type Tracker } from "./cleanup";
import { describeError, errorText, isOk, type Http, type HttpResult } from "./client";
import {
  CHAT_PLAIN_PROMPT,
  CHAT_TOOL_PROMPT,
  DATA_PROMPT,
  DATA_TOP_REGION,
  DATA_TOP_UNITS,
  DOCUMENT_PROMPT,
  DOCUMENT_SOURCE,
  PRESENTATION_PROMPT,
  PRESENTATION_SLIDES,
  RESEARCH_ANSWER,
  RESEARCH_PROMPT,
  SALES_CSV,
  SALES_FILENAME,
} from "./fixtures";
import {
  dataCheckFailures,
  jobEnding,
  jobToolCalls,
  observeAll,
  runEnding,
  totalEvents,
  type Ending,
  type Observation,
} from "./observe";
import type { CaseOutcome, DetailValue } from "./rows";

export type Desk = { workspaceId: string | null; agentId: string; defaultModel: string };

export type CaseContext = {
  http: Http;
  tracker: Tracker;
  desk: Desk;
  /** Artifact ids that existed before the run, so a case can tell which one it made. */
  knownArtifacts: ReadonlySet<string>;
};

export type HarnessCase = {
  id: string;
  mode: string;
  title: string;
  timeoutMs: number;
  /** The prompts the case sends. An artifact whose recorded question is one of these belongs to the run. */
  questions: readonly string[];
  run(context: CaseContext): Promise<CaseOutcome>;
};

type Expectation = readonly [name: string, ok: boolean];

function unmet(expectations: readonly Expectation[]): string[] {
  return expectations.flatMap(([name, ok]) => (ok ? [] : [name]));
}

function failedOutcome(error: string, detail: Record<string, DetailValue> = {}): CaseOutcome {
  return {
    completed: false,
    error,
    model: null,
    toolCalls: [],
    toolCallSource: "none",
    checkFailures: [],
    expectFailures: [],
    artifactId: null,
    detail,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A run that stopped on this side (timeout, broken stream) is not completed whatever the events said. */
function ended(ending: Ending, streamError: string | null): Ending {
  return streamError ? { completed: false, error: ending.error ?? streamError } : ending;
}

async function artifactModel(http: Http, artifactId: string | null): Promise<string | null> {
  if (!artifactId) {
    return null;
  }
  try {
    const { status, body } = await http.get(`/api/v1/artifacts/${artifactId}`);
    return isOk(status) ? text(record(record(body).meta).model) || null : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------- Chat

async function runChat(
  context: CaseContext,
  prompt: string,
  timeoutMs: number,
  expectationsOf: (observation: Observation) => Expectation[],
): Promise<CaseOutcome> {
  const { http, tracker, desk } = context;
  const created = await http.postJson("/api/v1/threads", { agentId: desk.agentId });
  const threadId = text(record(record(created.body).thread).id);
  if (created.status !== 201 || !threadId) {
    return failedOutcome(`could not open a thread: ${errorText(created.body, created.status)}`);
  }
  tracker.thread(threadId);

  const run = await http.stream(
    `/api/v1/threads/${threadId}/runs/text`,
    { content: prompt, model: desk.defaultModel },
    timeoutMs,
  );
  if (run.status !== 200) {
    return failedOutcome(errorText(run.body, run.status));
  }
  const observation = observeAll(run.events, run.malformed);
  const ending = ended(runEnding(observation), run.streamError);

  const thread = await http.get(`/api/v1/threads/${threadId}`);
  const messages = record(thread.body).messages;
  const persisted = Array.isArray(messages) && messages.some((message) => record(message).role === "assistant");

  return {
    completed: ending.completed && persisted,
    error: ending.error ?? (persisted ? null : "the assistant message was not saved on the thread"),
    model: observation.usage?.model || desk.defaultModel,
    toolCalls: observation.toolCalls,
    toolCallSource: observation.toolCalls.length > 0 ? "tool.started" : "none",
    checkFailures: [],
    expectFailures: unmet(expectationsOf(observation)),
    artifactId: null,
    detail: {
      events: totalEvents(observation),
      textChars: observation.text.length,
      contactAttempts: observation.contactAttempts,
      toolFailures: observation.toolFailures.length,
      inputTokens: observation.usage?.inputTokens ?? null,
      outputTokens: observation.usage?.outputTokens ?? null,
      persistedAssistant: persisted,
      malformedFrames: observation.malformedFrames,
    },
  };
}

const chatPlain: HarnessCase = {
  id: "chat-plain",
  mode: "chat",
  title: "A new thread, one plain reply",
  timeoutMs: 180_000,
  questions: [],
  run: (context) =>
    runChat(context, CHAT_PLAIN_PROMPT, 180_000, (observation) => [
      ["the reply says ready", /\bready\b/i.test(observation.text)],
    ]),
};

const chatTool: HarnessCase = {
  id: "chat-tool",
  mode: "chat",
  title: "A reply that needs the calculator",
  timeoutMs: 180_000,
  questions: [],
  run: (context) =>
    runChat(context, CHAT_TOOL_PROMPT, 180_000, (observation) => [
      ["the calculator tool was called", observation.toolCalls.includes("calculator")],
      ["the reply states 409.5", /409[.,]5/.test(observation.text)],
    ]),
};

// ---------------------------------------------------------------------------------------- Data

const DATA_TOOL_PHASES = { analyzing: "run_sql" } as const;

const dataCase: HarnessCase = {
  id: "data",
  mode: "data",
  title: "A 20-row CSV, one question answered with SQL",
  timeoutMs: 300_000,
  questions: [DATA_PROMPT],
  async run({ http, tracker }) {
    const form = new FormData();
    form.append("file", new Blob([SALES_CSV], { type: "text/csv" }), SALES_FILENAME);
    const upload = await http.postForm("/api/v1/datasets", form);
    const datasetId = text(record(upload.body).id);
    if (upload.status !== 201 || !datasetId) {
      return failedOutcome(`could not upload the dataset: ${errorText(upload.body, upload.status)}`);
    }
    tracker.dataset(datasetId);

    const run = await http.stream("/api/v1/data/stream", { prompt: DATA_PROMPT, datasetId }, 300_000);
    if (run.status !== 200) {
      return failedOutcome(errorText(run.body, run.status), { datasetRows: Number(record(upload.body).rows) || null });
    }
    const observation = observeAll(run.events, run.malformed);
    const ending = ended(jobEnding(observation), run.streamError);
    const result = record(observation.jobResult);
    const artifactId = text(result.artifactId) || null;
    if (artifactId) {
      tracker.artifact(artifactId);
    }
    const markdown = text(result.markdown);
    const toolCalls = jobToolCalls(observation.jobSteps, DATA_TOOL_PHASES);

    return {
      completed: ending.completed,
      error: ending.error,
      model: await artifactModel(http, artifactId),
      toolCalls,
      toolCallSource: toolCalls.length > 0 ? "job.step" : "none",
      checkFailures: dataCheckFailures(observation.jobResult, observation.jobSteps),
      expectFailures: unmet([
        ["run_sql was called at least once", toolCalls.length > 0],
        ["the analysis names the top region", markdown.includes(DATA_TOP_REGION)],
        ["the analysis states the top total", markdown.includes(DATA_TOP_UNITS)],
        ["an artifact was saved", artifactId !== null],
      ]),
      artifactId,
      detail: {
        datasetRows: Number(record(upload.body).rows) || null,
        sqlQueries: toolCalls.length,
        findings: Array.isArray(record(result.analysis).findings)
          ? (record(result.analysis).findings as unknown[]).length
          : 0,
        events: totalEvents(observation),
        malformedFrames: observation.malformedFrames,
      },
    };
  },
};

// ------------------------------------------------------------------- Documents, Presentation

async function runDraftRoute(
  context: CaseContext,
  route: string,
  artifactMode: string,
  payload: Record<string, unknown>,
  question: string,
  timeoutMs: number,
  inspect: (draft: Record<string, unknown>) => { expectations: Expectation[]; detail: Record<string, DetailValue> },
): Promise<CaseOutcome> {
  const { http, tracker, knownArtifacts } = context;
  let response: HttpResult;
  try {
    response = await http.postJson(route, payload, timeoutMs);
  } catch (error) {
    return failedOutcome(describeError(error, timeoutMs));
  }
  const artifactIds = await findNewArtifacts(http, knownArtifacts, artifactMode, question);
  for (const id of artifactIds) {
    tracker.artifact(id);
  }
  if (!isOk(response.status)) {
    return { ...failedOutcome(errorText(response.body, response.status)), artifactId: artifactIds[0] ?? null };
  }
  const artifactId = artifactIds[0] ?? null;
  const inspected = inspect(record(response.body));
  return {
    completed: true,
    error: null,
    model: await artifactModel(http, artifactId),
    toolCalls: [],
    toolCallSource: "none",
    checkFailures: [],
    expectFailures: unmet([...inspected.expectations, ["an artifact was saved", artifactId !== null]]),
    artifactId,
    detail: inspected.detail,
  };
}

const documentsCase: HarnessCase = {
  id: "documents",
  mode: "documents",
  title: "A three-section briefing from a five-sentence source",
  timeoutMs: 240_000,
  questions: [DOCUMENT_PROMPT],
  run: (context) =>
    runDraftRoute(
      context,
      "/api/v1/documents",
      "documents",
      { prompt: DOCUMENT_PROMPT, sourceText: DOCUMENT_SOURCE },
      DOCUMENT_PROMPT,
      240_000,
      (draft) => {
        const sections = Array.isArray(draft.sections) ? (draft.sections as Array<Record<string, unknown>>) : [];
        const words = sections.map((section) => `${text(section.heading)} ${text(section.body)}`).join(" ");
        return {
          expectations: [
            ["the draft has a title", text(draft.title).length > 0],
            ["the draft has at least two sections", sections.length >= 2],
            ["the draft uses the 40-guest figure from the source", /\b40\b/.test(words)],
          ],
          detail: { sections: sections.length, words: words.split(/\s+/).filter(Boolean).length },
        };
      },
    ),
};

const presentationCase: HarnessCase = {
  id: "presentation",
  mode: "presentations",
  title: "A 3-slide outline from a two-sentence brief",
  timeoutMs: 240_000,
  questions: [PRESENTATION_PROMPT],
  run: (context) =>
    runDraftRoute(
      context,
      "/api/v1/presentations",
      "presentations",
      { prompt: PRESENTATION_PROMPT },
      PRESENTATION_PROMPT,
      240_000,
      (outline) => {
        const slides = Array.isArray(outline.slides) ? (outline.slides as Array<Record<string, unknown>>) : [];
        return {
          expectations: [
            ["the outline has a title", text(outline.title).length > 0],
            [`the outline has ${PRESENTATION_SLIDES} slides`, slides.length === PRESENTATION_SLIDES],
            ["every slide has a heading", slides.every((slide) => text(slide.heading).length > 0)],
          ],
          detail: {
            slides: slides.length,
            bullets: slides.reduce(
              (total, slide) => total + (Array.isArray(slide.bullets) ? slide.bullets.length : 0),
              0,
            ),
          },
        };
      },
    ),
};

// -------------------------------------------------------------------------------------- Research

const RESEARCH_TOOL_PHASES = { searching: "web_search" } as const;

const researchCase: HarnessCase = {
  id: "research",
  mode: "research",
  title: "A dossier on one narrow factual question",
  timeoutMs: 600_000,
  questions: [RESEARCH_PROMPT],
  async run({ http, tracker }) {
    const run = await http.stream("/api/v1/research/stream", { prompt: RESEARCH_PROMPT }, 600_000);
    if (run.status !== 200) {
      return failedOutcome(errorText(run.body, run.status));
    }
    const observation = observeAll(run.events, run.malformed);
    const ending = ended(jobEnding(observation), run.streamError);
    const result = record(observation.jobResult);
    const artifactId = text(result.artifactId) || text(result.dossierId) || null;
    if (artifactId) {
      tracker.artifact(artifactId);
    }
    const toolCalls = jobToolCalls(observation.jobSteps, RESEARCH_TOOL_PHASES);

    return {
      completed: ending.completed,
      error: ending.error,
      model: await artifactModel(http, artifactId),
      toolCalls,
      toolCallSource: toolCalls.length > 0 ? "job.step" : "none",
      checkFailures: [],
      expectFailures: unmet([
        ["web_search ran at least once", toolCalls.length > 0],
        ["at least one source was read", observation.sources.read > 0],
        ["the dossier states the answer", text(record(result.dossier).markdown).includes(RESEARCH_ANSWER)],
        ["an artifact was saved", artifactId !== null],
      ]),
      artifactId,
      detail: {
        searches: toolCalls.length,
        sourcesFound: observation.sources.found,
        sourcesRead: observation.sources.read,
        sourcesUnreachable: observation.sources.unreachable,
        modelCallsEstimate: 2 + observation.sources.read,
        events: totalEvents(observation),
        malformedFrames: observation.malformedFrames,
      },
    };
  },
};

export const CASES: readonly HarnessCase[] = [
  chatPlain,
  chatTool,
  dataCase,
  documentsCase,
  presentationCase,
  researchCase,
];

export const CASE_IDS: readonly string[] = CASES.map((item) => item.id);
