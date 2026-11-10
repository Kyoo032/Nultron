/**
 * HTTP speech-to-speech talker for `qwen3.5-omni-flash` (plan week one).
 *
 * The relay codes against `talker.ts` only. This file speaks the gateway's streaming
 * chat-completions shape: speech in is a wav data URI, speech out is raw PCM16 at 24 kHz
 * even when `format` is `wav`, and `ask_nultron` comes back as `delta.tool_calls`.
 * The base URL and the key are passed in. This file does not read the environment or the
 * settings store. Logs are counts and timings only.
 */
import { log } from "../log";
import { createSseParser } from "./talker-sse";
import {
  ACK_INSTRUCTIONS,
  ACK_SENTENCE,
  ASK_NULTRON_NAME,
  gatewayTools,
  HEAR_SHORT_INSTRUCTIONS,
  KEEP_LISTENING_NAME,
  TALKER_INSTRUCTIONS,
} from "./talker-prompt";
import {
  TalkerError,
  type Pcm,
  type Talker,
  type TalkerEvent,
  type TalkerReplyOptions,
  type TalkerSession,
  type TalkerSessionOptions,
  type TalkerTurn,
  type TalkerUsage,
} from "./talker";
import { createPcmAligner, inputAudioPart } from "./talker-wav";
import type { VoiceLocale } from "./turns";

export const TALKER_FIRST_BYTE_MS = 8_000;
export const TALKER_SILENCE_MS = 10_000;
export const HEAR_SHORT_MS = 2_000;

const HISTORY_TURNS = 12;
const ERROR_SNIPPET_CHARS = 4_096;
const QUOTA_RE = /\b(quota|balance|billing|payment|credits?)\b|insufficient/i;

export type TalkerLimits = {
  readonly firstByteMs: number;
  readonly silenceMs: number;
  readonly hearShortMs: number;
};

export type OmniHttpTalkerOptions = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly voice: string;
  readonly fetch?: typeof fetch;
  /** Tests inject short budgets. Production leaves this unset. */
  readonly limits?: Partial<TalkerLimits>;
};

type Limits = TalkerLimits;

type ToolAcc = { id: string; name: string; arguments: string };

type PendingAsk = { callId: string; name: string; arguments: string; question: string };

type StreamEnd = { tools: ToolAcc[]; spoke: boolean };

type Meter = { status: number; audioBytes: number; wordChars: number };

type AckRecord = { matched: boolean; pcm: Pcm | null; heard: string };

type AckTrio = { readonly model: string; readonly voice: string; readonly locale: VoiceLocale };

const ackJobs = new Map<string, Promise<void>>();
const ackRecords = new Map<string, AckRecord>();
let ackGeneration = 0;

const DEFAULT_LIMITS: Limits = {
  firstByteMs: TALKER_FIRST_BYTE_MS,
  silenceMs: TALKER_SILENCE_MS,
  hearShortMs: HEAR_SHORT_MS,
};

function ackKey(trio: AckTrio): string {
  return `${trio.model}\n${trio.voice}\n${trio.locale}`;
}

/** Resolves when the process-wide acknowledgement attempt for this trio has finished. */
export function whenAcknowledgementSettled(trio: AckTrio): Promise<void> {
  return ackJobs.get(ackKey(trio)) ?? Promise.resolve();
}

/**
 * The words from the acknowledgement attempt, once it has settled. Null while it is still running.
 * A mismatch is returned here and is not cached as playable audio.
 */
export function acknowledgementWords(trio: AckTrio): string | null {
  const record = ackRecords.get(ackKey(trio));
  return record ? record.heard : null;
}

/** Drops the process cache. An attempt already running will not write back. */
export function resetTalkerCachesForTests(): void {
  ackGeneration += 1;
  ackJobs.clear();
  ackRecords.clear();
}

/** A timer that aborts `signal`. `cancel` stops it so a finished call does not keep the process awake. */
function openBudget(ms: number): { readonly signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(timer) };
}

function limitsOf(partial: Partial<TalkerLimits> | undefined): Limits {
  return {
    firstByteMs: partial?.firstByteMs ?? DEFAULT_LIMITS.firstByteMs,
    silenceMs: partial?.silenceMs ?? DEFAULT_LIMITS.silenceMs,
    hearShortMs: partial?.hearShortMs ?? DEFAULT_LIMITS.hearShortMs,
  };
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}${path}`;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageOf(raw: unknown): TalkerUsage | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const usage = raw as Record<string, unknown>;
  if (typeof usage.prompt_tokens !== "number" && typeof usage.completion_tokens !== "number") {
    return null;
  }
  const prompt = usage.prompt_tokens_details as { audio_tokens?: unknown } | undefined;
  const completion = usage.completion_tokens_details as { audio_tokens?: unknown } | undefined;
  return {
    inputTokens: numberOrZero(usage.prompt_tokens),
    outputTokens: numberOrZero(usage.completion_tokens),
    inputAudioTokens: numberOrZero(prompt?.audio_tokens),
    outputAudioTokens: numberOrZero(completion?.audio_tokens),
  };
}

/** Status and a short body snippet decide the code. The snippet never reaches the message. */
function failureFor(status: number, body: string): TalkerError {
  if (status === 401 || status === 403) {
    return new TalkerError("refused", "The gateway refused the request.");
  }
  if (status >= 500) {
    return new TalkerError("unavailable", "The gateway did not answer.");
  }
  if (QUOTA_RE.test(body)) {
    return new TalkerError("refused", "The gateway refused the request.");
  }
  if (status === 429 || status === 408) {
    return new TalkerError("unavailable", "The gateway did not answer.");
  }
  return new TalkerError("failed", "The gateway rejected the request.");
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function questionOf(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const question = (parsed as { question?: unknown }).question;
  if (typeof question !== "string") {
    return null;
  }
  const trimmed = question.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function absorbToolCall(raw: unknown, tools: Map<number, ToolAcc>): void {
  if (!raw || typeof raw !== "object") {
    return;
  }
  const call = raw as { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } };
  const index = typeof call.index === "number" && Number.isInteger(call.index) ? call.index : 0;
  const current = tools.get(index) ?? { id: "", name: "", arguments: "" };
  if (typeof call.id === "string" && call.id) {
    current.id = call.id;
  }
  if (typeof call.function?.name === "string" && call.function.name) {
    const name = call.function.name;
    if (!current.name) {
      current.name = name;
    } else if (current.name !== name && !current.name.endsWith(name)) {
      current.name += name;
    }
  }
  if (typeof call.function?.arguments === "string") {
    current.arguments += call.function.arguments;
  }
  tools.set(index, current);
}

function* eventsOfFrame(
  event: unknown,
  aligner: ReturnType<typeof createPcmAligner>,
  tools: Map<number, ToolAcc>,
): Generator<TalkerEvent> {
  if (!event || typeof event !== "object") {
    return;
  }
  const record = event as { choices?: unknown; usage?: unknown };
  const choice = Array.isArray(record.choices) ? record.choices[0] : undefined;
  const delta = choice && typeof choice === "object" ? (choice as { delta?: unknown }).delta : undefined;
  if (delta && typeof delta === "object") {
    const piece = delta as {
      content?: unknown;
      audio?: { data?: unknown; transcript?: unknown };
      tool_calls?: unknown;
    };
    const content = typeof piece.content === "string" ? piece.content : "";
    const transcript =
      piece.audio && typeof piece.audio.transcript === "string" ? piece.audio.transcript : "";
    const words = content.length > 0 ? content : transcript;
    if (words) {
      yield { type: "text", delta: words };
    }
    if (piece.audio && typeof piece.audio.data === "string" && piece.audio.data.length > 0) {
      const pcm = aligner.push(Buffer.from(piece.audio.data, "base64"));
      if (pcm && pcm.length > 0) {
        yield { type: "audio", pcm };
      }
    }
    if (Array.isArray(piece.tool_calls)) {
      for (const call of piece.tool_calls) {
        absorbToolCall(call, tools);
      }
    }
  }
  const usage = usageOf(record.usage);
  if (usage) {
    yield { type: "usage", usage };
  }
}

type Decision =
  | { kind: "speak" }
  | { kind: "wait" }
  | { kind: "ask"; pending: PendingAsk }
  | { kind: "bad" };

function decide(tools: readonly ToolAcc[], mustAnswer: boolean, spoke: boolean): Decision {
  const named = tools.filter((tool) => tool.name.length > 0);
  const wait = named.find((tool) => tool.name === KEEP_LISTENING_NAME);
  const ask = named.find((tool) => tool.name === ASK_NULTRON_NAME);
  if (wait && !mustAnswer) {
    return { kind: "wait" };
  }
  if (ask?.id) {
    const question = questionOf(ask.arguments);
    if (!question) {
      return { kind: "bad" };
    }
    return {
      kind: "ask",
      pending: { callId: ask.id, name: ask.name, arguments: ask.arguments, question },
    };
  }
  if (spoke || named.length === 0) {
    return { kind: "speak" };
  }
  return { kind: "bad" };
}

function sameWords(heard: string, sentence: string): boolean {
  return heard.trim().replace(/\s+/g, " ") === sentence.trim().replace(/\s+/g, " ");
}

function historyMessages(history: readonly TalkerTurn[]): { role: TalkerTurn["role"]; content: string }[] {
  return history
    .filter((turn) => turn.text.trim().length > 0)
    .map((turn) => ({ role: turn.role, content: turn.text }));
}

async function* readStream(input: {
  fetchImpl: typeof fetch;
  url: string;
  apiKey: string;
  body: unknown;
  caller: AbortSignal;
  session: AbortSignal;
  limits: Limits;
  meter: Meter;
}): AsyncGenerator<TalkerEvent, StreamEnd, void> {
  const tools = new Map<number, ToolAcc>();
  const empty = (): StreamEnd => ({ tools: [...tools.values()], spoke });
  let spoke = false;
  if (input.caller.aborted || input.session.aborted) {
    return empty();
  }

  const timeoutCtrl = new AbortController();
  let timedOut = false;
  let gotByte = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelRead: (() => void) | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      timeoutCtrl.abort();
      cancelRead?.();
    }, gotByte ? input.limits.silenceMs : input.limits.firstByteMs);
  };
  const signal = AbortSignal.any([input.caller, input.session, timeoutCtrl.signal]);
  arm();

  let response: Response;
  try {
    response = await input.fetchImpl(input.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input.body),
      redirect: "manual",
      signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (input.caller.aborted || input.session.aborted) {
      return empty();
    }
    if (timedOut) {
      throw new TalkerError("unavailable", "The gateway did not answer in time.");
    }
    if (isAbort(error)) {
      return empty();
    }
    throw new TalkerError("unavailable", "The gateway could not be reached.");
  }

  input.meter.status = response.status;
  if (input.caller.aborted || input.session.aborted) {
    clearTimeout(timer);
    return empty();
  }
  if (!response.ok || !response.body) {
    clearTimeout(timer);
    const snippet = await readSnippet(response);
    if (response.ok) {
      throw new TalkerError("failed", "The gateway returned a response the talker could not read.");
    }
    throw failureFor(response.status, snippet);
  }

  // Headers are the first byte. Later gaps are the silence budget.
  gotByte = true;
  arm();

  const reader = response.body.getReader();
  cancelRead = () => {
    reader.cancel().catch(() => undefined);
  };
  const decoder = new TextDecoder();
  const parser = createSseParser();
  const aligner = createPcmAligner();
  let prelude = "";
  let sawData = false;

  const finish = (): StreamEnd => ({ tools: [...tools.values()], spoke });

  try {
    while (!input.caller.aborted && !input.session.aborted) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (error) {
        if (input.caller.aborted || input.session.aborted) {
          return finish();
        }
        if (timedOut) {
          throw new TalkerError("unavailable", "The gateway did not answer in time.");
        }
        if (isAbort(error)) {
          return finish();
        }
        throw new TalkerError("unavailable", "The gateway could not be reached.");
      }
      if (input.caller.aborted || input.session.aborted) {
        return finish();
      }
      if (timedOut) {
        throw new TalkerError("unavailable", "The gateway did not answer in time.");
      }
      if (next.done) {
        break;
      }
      arm();
      const decoded = decoder.decode(next.value, { stream: true });
      if (!sawData) {
        prelude = (prelude + decoded).slice(0, ERROR_SNIPPET_CHARS * 2);
        if (prelude.includes("data:")) {
          sawData = true;
        }
      }
      for (const event of parser.push(decoded)) {
        if (input.caller.aborted || input.session.aborted) {
          return finish();
        }
        for (const yielded of eventsOfFrame(event, aligner, tools)) {
          if (yielded.type === "audio" || yielded.type === "text") {
            spoke = true;
          }
          yield yielded;
        }
      }
    }
    if (!sawData && !spoke && tools.size === 0) {
      const problem = malformedOrEmpty(prelude);
      if (problem) {
        throw problem;
      }
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }

  return finish();
}

/** An empty 200 is a silent model. Anything else that is not an event stream is malformed. */
function malformedOrEmpty(prelude: string): TalkerError | null {
  const trimmed = prelude.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: { message?: unknown } };
      if (parsed.error) {
        const message = typeof parsed.error.message === "string" ? parsed.error.message : "";
        return failureFor(400, message);
      }
    } catch (error) {
      if (error instanceof TalkerError) {
        return error;
      }
    }
  }
  return new TalkerError("failed", "The gateway returned a response the talker could not read.");
}

async function readSnippet(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, ERROR_SNIPPET_CHARS);
  } catch {
    return "";
  }
}

async function* tracked(
  kind: string,
  meter: Meter,
  caller: AbortSignal,
  session: AbortSignal,
  run: () => AsyncGenerator<TalkerEvent, void, void>,
): AsyncGenerator<TalkerEvent> {
  const started = performance.now();
  let outcome = "done";
  try {
    for await (const event of run()) {
      if (caller.aborted || session.aborted) {
        outcome = "aborted";
        return;
      }
      if (event.type === "audio") {
        meter.audioBytes += event.pcm.length;
      } else if (event.type === "text") {
        meter.wordChars += event.delta.length;
      } else if (event.type === "ask") {
        outcome = "ask";
      } else if (event.type === "wait") {
        outcome = "wait";
      }
      yield event;
    }
    if (caller.aborted || session.aborted) {
      outcome = "aborted";
    }
  } catch (error) {
    if (caller.aborted || session.aborted) {
      outcome = "aborted";
      return;
    }
    const talkerError =
      error instanceof TalkerError ? error : new TalkerError("failed", "The talker could not finish the reply.");
    outcome = talkerError.code;
    throw talkerError;
  } finally {
    const fields = {
      kind,
      outcome,
      ms: Math.round(performance.now() - started),
      audioBytes: meter.audioBytes,
      wordChars: meter.wordChars,
      status: meter.status,
    };
    if (outcome === "refused" || outcome === "unavailable" || outcome === "failed") {
      log.warn("voice_talker", fields);
    } else {
      log.info("voice_talker", fields);
    }
  }
}

export function createOmniHttpTalker(options: OmniHttpTalkerOptions): Talker {
  const fetchImpl = options.fetch ?? fetch;
  const url = endpoint(options.baseUrl, "/chat/completions");
  const limits = limitsOf(options.limits);
  const { model, voice, apiKey } = options;

  const startAck = (locale: VoiceLocale): void => {
    const trio: AckTrio = { model, voice, locale };
    const key = ackKey(trio);
    if (ackJobs.has(key)) {
      return;
    }
    const generation = ackGeneration;
    const job = runAcknowledgement({ fetchImpl, url, apiKey, model, voice, locale, limits }).then((record) => {
      if (generation === ackGeneration) {
        ackRecords.set(key, record);
      }
    });
    ackJobs.set(key, job);
  };

  return {
    model,
    open(sessionOptions: TalkerSessionOptions): TalkerSession {
      const locale = sessionOptions.locale;
      const history: TalkerTurn[] = sessionOptions.history.slice(-HISTORY_TURNS).map((turn) => ({
        role: turn.role,
        text: turn.text,
      }));
      const sessionCtrl = new AbortController();
      let pending: PendingAsk | null = null;
      startAck(locale);

      const stream = (
        kind: string,
        body: unknown,
        caller: AbortSignal,
        after: (end: StreamEnd) => AsyncGenerator<TalkerEvent, void, void>,
      ) => {
        const meter: Meter = { status: 0, audioBytes: 0, wordChars: 0 };
        return tracked(kind, meter, caller, sessionCtrl.signal, async function* () {
          const end = yield* readStream({
            fetchImpl,
            url,
            apiKey,
            body,
            caller,
            session: sessionCtrl.signal,
            limits,
            meter,
          });
          if (caller.aborted || sessionCtrl.signal.aborted) {
            return;
          }
          yield* after(end);
        });
      };

      return {
        reply(utterance: Pcm, replyOptions: TalkerReplyOptions) {
          pending = null;
          const mustAnswer = replyOptions.mustAnswer === true;
          const body = replyBody({ model, voice, locale, history, utterance, mustAnswer });
          return stream("reply", body, replyOptions.signal, async function* (end) {
            const decision = decide(end.tools, mustAnswer, end.spoke);
            if (decision.kind === "bad") {
              throw new TalkerError("failed", "The talker could not read the tool call.");
            }
            if (decision.kind === "wait") {
              yield { type: "wait" as const };
            } else if (decision.kind === "ask") {
              pending = decision.pending;
              yield { type: "ask" as const, callId: decision.pending.callId, question: decision.pending.question };
            }
            if (replyOptions.signal.aborted || sessionCtrl.signal.aborted) {
              return;
            }
            yield { type: "done" as const };
          });
        },

        answer(callId: string, text: string, replyOptions: TalkerReplyOptions) {
          const match = pending && pending.callId === callId ? pending : null;
          const meter: Meter = { status: 0, audioBytes: 0, wordChars: 0 };
          return tracked("answer", meter, replyOptions.signal, sessionCtrl.signal, async function* () {
            if (!match) {
              throw new TalkerError("failed", "The talker has no matching tool call.");
            }
            const end = yield* readStream({
              fetchImpl,
              url,
              apiKey,
              body: answerBody({ model, voice, locale, history, pending: match, text }),
              caller: replyOptions.signal,
              session: sessionCtrl.signal,
              limits,
              meter,
            });
            if (replyOptions.signal.aborted || sessionCtrl.signal.aborted) {
              return;
            }
            const called = end.tools.some((tool) => tool.name.length > 0);
            if (called && !end.spoke) {
              throw new TalkerError("failed", "The talker could not read the tool call.");
            }
            yield { type: "done" as const };
          });
        },

        remember(turn: { readonly user: string | null; readonly assistant: string; readonly interrupted: boolean }): void {
          // A null user means there is no transcript. An empty user turn would look like silence,
          // so it is left out and only the assistant side is kept. `assistant` is what was heard:
          // the relay already trims it when `interrupted` is set, and that flag does not add words.
          const user = turn.user?.trim() ?? "";
          if (user) {
            history.push({ role: "user", text: user });
          }
          const assistant = turn.assistant.trim();
          if (assistant) {
            history.push({ role: "assistant", text: assistant });
          }
          if (history.length > HISTORY_TURNS) {
            history.splice(0, history.length - HISTORY_TURNS);
          }
        },

        async hearShort(speech: Pcm, signal: AbortSignal): Promise<string | null> {
          const started = performance.now();
          const meter: Meter = { status: 0, audioBytes: 0, wordChars: 0 };
          let outcome = "null";
          try {
            if (signal.aborted || sessionCtrl.signal.aborted) {
              return null;
            }
            const budget = openBudget(limits.hearShortMs);
            const linked = AbortSignal.any([signal, sessionCtrl.signal, budget.signal]);
            let words = "";
            try {
              for await (const event of readStream({
                fetchImpl,
                url,
                apiKey,
                body: hearBody(model, locale, speech),
                caller: linked,
                session: sessionCtrl.signal,
                limits,
                meter,
              })) {
                if (event.type === "text") {
                  words += event.delta;
                }
              }
            } finally {
              budget.cancel();
            }
            if (budget.signal.aborted || signal.aborted || sessionCtrl.signal.aborted) {
              return null;
            }
            const text = words.trim();
            if (!text) {
              return null;
            }
            outcome = "ok";
            meter.wordChars = text.length;
            return text;
          } catch {
            return null;
          } finally {
            log.info("voice_talker", {
              kind: "hear",
              outcome,
              ms: Math.round(performance.now() - started),
              audioBytes: speech.length,
              wordChars: meter.wordChars,
              status: meter.status,
            });
          }
        },

        acknowledgement(): { readonly pcm: Pcm; readonly text: string } | null {
          const record = ackRecords.get(ackKey({ model, voice, locale }));
          if (!record?.matched || !record.pcm) {
            return null;
          }
          return { pcm: record.pcm, text: ACK_SENTENCE[locale] };
        },

        close(): void {
          sessionCtrl.abort();
        },
      };
    },
  };
}

function replyBody(input: {
  model: string;
  voice: string;
  locale: VoiceLocale;
  history: readonly TalkerTurn[];
  utterance: Pcm;
  mustAnswer: boolean;
}): unknown {
  return {
    model: input.model,
    stream: true,
    stream_options: { include_usage: true },
    modalities: ["text", "audio"],
    audio: { voice: input.voice, format: "wav" },
    messages: [
      { role: "system", content: TALKER_INSTRUCTIONS[input.locale] },
      ...historyMessages(input.history),
      { role: "user", content: [inputAudioPart(input.utterance)] },
    ],
    tools: gatewayTools(input.mustAnswer),
    tool_choice: "auto",
  };
}

function answerBody(input: {
  model: string;
  voice: string;
  locale: VoiceLocale;
  history: readonly TalkerTurn[];
  pending: PendingAsk | null;
  text: string;
}): unknown {
  const messages: unknown[] = [
    { role: "system", content: TALKER_INSTRUCTIONS[input.locale] },
    ...historyMessages(input.history),
  ];
  if (input.pending) {
    messages.push(
      { role: "user", content: input.pending.question },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: input.pending.callId,
            type: "function",
            function: { name: input.pending.name, arguments: input.pending.arguments },
          },
        ],
      },
      { role: "tool", tool_call_id: input.pending.callId, content: input.text },
    );
  }
  return {
    model: input.model,
    stream: true,
    stream_options: { include_usage: true },
    modalities: ["text", "audio"],
    audio: { voice: input.voice, format: "wav" },
    messages,
  };
}

function hearBody(model: string, locale: VoiceLocale, speech: Pcm): unknown {
  return {
    model,
    stream: true,
    stream_options: { include_usage: true },
    modalities: ["text"],
    messages: [
      { role: "system", content: HEAR_SHORT_INSTRUCTIONS[locale] },
      { role: "user", content: [inputAudioPart(speech)] },
    ],
  };
}

async function runAcknowledgement(input: {
  fetchImpl: typeof fetch;
  url: string;
  apiKey: string;
  model: string;
  voice: string;
  locale: VoiceLocale;
  limits: Limits;
}): Promise<AckRecord> {
  const started = performance.now();
  const meter: Meter = { status: 0, audioBytes: 0, wordChars: 0 };
  const detached = new AbortController();
  let heard = "";
  const chunks: Pcm[] = [];
  let outcome = "rejected";
  try {
    for await (const event of readStream({
      fetchImpl: input.fetchImpl,
      url: input.url,
      apiKey: input.apiKey,
      body: {
        model: input.model,
        stream: true,
        stream_options: { include_usage: true },
        modalities: ["text", "audio"],
        audio: { voice: input.voice, format: "wav" },
        messages: [
          { role: "system", content: ACK_INSTRUCTIONS[input.locale] },
          { role: "user", content: ACK_SENTENCE[input.locale] },
        ],
      },
      caller: detached.signal,
      session: detached.signal,
      limits: input.limits,
      meter,
    })) {
      if (event.type === "text") {
        heard += event.delta;
      } else if (event.type === "audio") {
        chunks.push(event.pcm);
      }
    }
    const matched = sameWords(heard, ACK_SENTENCE[input.locale]);
    const pcm = matched && chunks.length > 0 ? Buffer.concat(chunks) : null;
    if (matched && pcm && pcm.length > 0) {
      outcome = "cached";
      return { matched: true, pcm, heard: heard.trim() };
    }
    return { matched: false, pcm: null, heard: heard.trim() };
  } catch {
    return { matched: false, pcm: null, heard: "" };
  } finally {
    log.info("voice_talker", {
      kind: "ack",
      outcome,
      ms: Math.round(performance.now() - started),
      audioBytes: meter.audioBytes,
      wordChars: heard.trim().length,
      status: meter.status,
    });
  }
}
