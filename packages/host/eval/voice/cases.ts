/**
 * The case table: one row per check, each a short script against a live session and a few assertions.
 *
 * A case speaks to the host only through `CaseContext` (a connected session over the real protocol) and
 * records what it saw with a `Recorder`: checks (each pass or fail with a reason), numbers (reported with run
 * count and spread) and notes. A case that cannot run says so with `SkipCase`; the runner never reports a skip
 * as a pass. An expected frame that does not arrive throws `WaitTimeout`, which the runner records as a
 * failed check, so a case reads as the script of what should happen.
 *
 * The turn-taking numbers the cases lean on (300 ms, 700 ms, 2.5 s) are `TURN_TIMING` in
 * `packages/host/src/voice/turns.ts`; the contract's frames are in `packages/core/src/voice/protocol.ts`.
 */
import type { VoiceMode } from "@agentforge/core/voice";
import { type Fixture, type FixtureName, type Fixtures, FRAME_MS, silencePcm } from "./audio";
import type { Clock } from "./clock";
import {
  type CaptionFrame,
  type DeskSettings,
  type FrameRec,
  type Rec,
  type ThreadMessage,
  type UpgradeProbe,
  type VoiceClient,
  type VoiceSession,
  H1Refused,
  SocketClosed,
  WaitTimeout,
  captions,
  isAudio,
  isFrame,
} from "./client";
import type { QueuedClip } from "./mic";
import { type NumberSummary, summarize } from "./stats";
import { type TextPolicy, carriesText, describeText, normalizeText } from "./text";

// ---------------------------------------------------------------------------------------------------------
// Shapes

export type Check = { readonly name: string; readonly ok: boolean; readonly detail?: string };
export type NoteValue = string | number | boolean | null;

export type RunOutcome = {
  readonly checks: readonly Check[];
  readonly numbers: Readonly<Record<string, number | null>>;
  readonly notes: Readonly<Record<string, NoteValue>>;
};

/** What a case writes as it goes. The runner reads it back even when the case threw half way. */
export type Recorder = {
  check(name: string, ok: boolean, detail?: string): boolean;
  number(name: string, value: number | null): void;
  note(name: string, value: NoteValue): void;
  outcome(): RunOutcome;
};

export function createRecorder(): Recorder {
  const checks: Check[] = [];
  const numbers: Record<string, number | null> = {};
  const notes: Record<string, NoteValue> = {};
  return {
    check(name, ok, detail) {
      checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
      return ok;
    },
    number(name, value) {
      numbers[name] = value === null || Number.isFinite(value) ? value : null;
    },
    note(name, value) {
      notes[name] = value;
    },
    outcome: () => ({ checks: [...checks], numbers: { ...numbers }, notes: { ...notes } }),
  };
}

/** The case cannot run here. `BLOCKED_NO_RUNTIME` is for "no model is behind it"; the default is a plain skip. */
export class SkipCase extends Error {
  constructor(
    readonly reason: string,
    readonly status: "SKIPPED_UNAVAILABLE" | "BLOCKED_NO_RUNTIME" = "SKIPPED_UNAVAILABLE",
  ) {
    super(reason);
    this.name = "SkipCase";
  }
}

export type CaseContext = {
  readonly client: VoiceClient;
  readonly clock: Clock;
  readonly fixtures: Fixtures;
  readonly settings: DeskSettings;
  readonly policy: TextPolicy;
  /** The most a microphone frame may leave after its due time before a latency number is not trusted. */
  readonly paceLagMs: number;
  /** A new empty Chat thread. The runner deletes it at the end of the run. */
  newThread(): Promise<string>;
  /** H1 then H2 on a fresh thread (or `threadId`): a connected session, ended by the runner when the run is over. */
  open(options?: { mode?: VoiceMode; threadId?: string }): Promise<VoiceSession>;
  /** The messages of a thread, as text. */
  messages(threadId: string): Promise<ThreadMessage[]>;
};

export type VoiceCase = {
  readonly id: string;
  readonly title: string;
  /** `--repeat` applies: the case is run that many times and its numbers are summarised across the runs. */
  readonly repeatable: boolean;
  /** The case needs the thinker (the desk's Chat run), so it is skipped on a desk with no live gateway. */
  readonly needsThinker: boolean;
  run(context: CaseContext, recorder: Recorder): Promise<void>;
  /** Judges the numbers across all runs (the latency percentiles) and adds checks of its own. */
  judge?(runs: readonly RunOutcome[]): Check[];
};

// ---------------------------------------------------------------------------------------------------------
// Timing. All in client-clock milliseconds.

export const TIMING = {
  /** Silence before the first clip: the host's detector learns the room from it. */
  leadInMs: 600,
  /** How long a reply may take to start. */
  replyStartMs: 20_000,
  /** The person's caption can arrive seconds late. */
  captionMs: 15_000,
  /** The host's `metrics` frame, once per answered turn, comes when the turn is over. */
  metricsMs: 40_000,
  savedMs: 30_000,
  /** The person speaks over the reply this long after its first audio. */
  bargeDelayMs: 400,
  /** The browser's own voice detection needs about this much speech before it pauses and sends `barge_in`. */
  browserDetectMs: 120,
  /** Speech over the agent this long is an interruption (`TURN_TIMING.interruptAfterMs`). */
  interruptLineMs: 700,
  /** `stop_audio` must come within this long after that line. */
  stopWithinMs: 300,
  /** Nothing may be spoken this long after speech that stopped on a word that needs more. */
  unfinishedQuietMs: 2_000,
  /** Silence between the two parts of a sentence, as near 500 ms as 40 ms frames allow. */
  pauseSilenceMs: 400,
  /** A press-and-hold that is never committed: longer than the host's own long-silence limit. */
  pushToTalkQuietMs: 3_500,
  /** A gap this long between two bursts of agent audio shows a wait for the thinker. */
  ackGapMs: 600,
  /** After the reply, how long to watch for a second one. */
  secondReplyWatchMs: 3_000,
  /** A resume after a backchannel is expected within this long of the end of the clip. */
  resumeWithinMs: 3_000,
  /** The thread's messages are read back this long at most, while the save lands. */
  threadPollMs: 4_000,
  /** The most a microphone frame may leave after its due time before a latency number is not trusted. */
  paceLagMs: 150,
  /** One whole run of one case, a backstop above every wait. */
  runMs: 180_000,
} as const;

export const LATENCY_LIMITS = { p50Ms: 1_500, p90Ms: 2_500 } as const;

// ---------------------------------------------------------------------------------------------------------
// Helpers

const stateIs =
  (value: string) =>
  (rec: Rec): boolean =>
    rec.kind === "frame" && rec.frame.type === "state" && rec.frame.value === value;

function captionOf(rec: Rec | undefined): CaptionFrame | null {
  return rec?.kind === "frame" && rec.frame.type === "caption" ? rec.frame : null;
}

const isUserFinal = (rec: Rec): boolean => {
  const caption = captionOf(rec);
  return caption !== null && caption.role === "user" && caption.final;
};

const isAssistantFinal = (rec: Rec): boolean => {
  const caption = captionOf(rec);
  return caption !== null && caption.role === "assistant" && caption.final;
};

const isCutReplyCaption = (rec: Rec): boolean => {
  const caption = captionOf(rec);
  return caption !== null && caption.role === "assistant" && caption.final && caption.interrupted === true;
};

async function sleepUntil(clock: Clock, at: number): Promise<void> {
  await clock.sleep(Math.max(0, at - clock.now()));
}

const round = (value: number): number => Math.round(value);

type Spoken = {
  readonly fixture: Fixture;
  readonly clip: QueuedClip;
  /** Stream position of the first and last speech in the clip. */
  readonly speechStartMs: number;
  readonly speechEndMs: number;
};

/** Queues a fixture on the microphone. It starts at the next 40 ms frame. */
function say(session: VoiceSession, fixture: Fixture): Spoken {
  const clip = session.mic.say(fixture.pcm);
  return {
    fixture,
    clip,
    speechStartMs: clip.startMs + fixture.marks.startMs,
    speechEndMs: clip.startMs + fixture.marks.endMs,
  };
}

/** When the person really stopped speaking, on the client clock. Valid once the clip has been sent. */
function speechEndAt(session: VoiceSession, spoken: Spoken): number {
  const at = session.mic.clockAt(spoken.speechEndMs);
  if (at === null) {
    throw new Error("the end of speech was asked for before its frame was sent");
  }
  return at;
}

function speechStartAt(session: VoiceSession, spoken: Spoken): number {
  const at = session.mic.clockAt(spoken.speechStartMs);
  if (at === null) {
    throw new Error("the start of speech was asked for before its frame was sent");
  }
  return at;
}

/** The first audio frame of the reply, or a thrown `WaitTimeout`. */
async function firstAudio(session: VoiceSession, since: number, label = "agent audio"): Promise<Rec & { kind: "audio" }> {
  const rec = await session.waitFor(isAudio, { since, timeoutMs: TIMING.replyStartMs, label });
  if (rec.kind !== "audio") {
    throw new Error("unreachable");
  }
  return rec;
}

type Reply = { id: string; longestChars: number; longestText: string; final: CaptionFrame | null; finalAt: number | null };

/** The assistant's captions grouped by id, in the order each id first appeared. */
function assistantReplies(timeline: readonly Rec[], since = 0): Reply[] {
  const replies = new Map<string, Reply>();
  for (const { at, caption } of captions(timeline, "assistant", since)) {
    const reply = replies.get(caption.id) ?? { id: caption.id, longestChars: 0, longestText: "", final: null, finalAt: null };
    if (caption.text.length >= reply.longestChars) {
      reply.longestChars = caption.text.length;
      reply.longestText = caption.text;
    }
    if (caption.final) {
      reply.final = caption;
      reply.finalAt = at;
    }
    replies.set(caption.id, reply);
  }
  return [...replies.values()];
}

/** What shows the host said something short first and the answer after: two captions, or a gap in the audio. */
function ackEvidence(timeline: readonly Rec[], since: number): "caption-ids" | "audio-gap" | "none" {
  if (assistantReplies(timeline, since).filter((reply) => reply.final).length >= 2) {
    return "caption-ids";
  }
  const audio = timeline.slice(since).filter(isAudio);
  for (let i = 1; i < audio.length; i += 1) {
    const before = audio[i - 1];
    const after = audio[i];
    if (before && after && after.at - before.at >= TIMING.ackGapMs) {
      return "audio-gap";
    }
  }
  return "none";
}

/** Waits for a frame and records a failed check, not a crash, when it does not come. */
async function expectFrame(
  recorder: Recorder,
  session: VoiceSession,
  name: string,
  match: (rec: Rec) => boolean,
  options: { since: number; timeoutMs: number },
): Promise<Rec | null> {
  try {
    return await session.waitFor(match, { since: options.since, timeoutMs: options.timeoutMs, label: name });
  } catch (error) {
    if (error instanceof WaitTimeout || error instanceof SocketClosed) {
      recorder.check(name, false, error.message);
      return null;
    }
    throw error;
  }
}

async function messagesWhen(
  context: CaseContext,
  threadId: string,
  ready: (messages: readonly ThreadMessage[]) => boolean,
): Promise<ThreadMessage[]> {
  const until = context.clock.now() + TIMING.threadPollMs;
  let messages = await context.messages(threadId);
  while (!ready(messages) && context.clock.now() < until) {
    await context.clock.sleep(250);
    messages = await context.messages(threadId);
  }
  return messages;
}

const textOnly = (messages: readonly ThreadMessage[]): boolean =>
  messages.every((message) => message.partTypes.every((type) => type === "text"));

function describeMessages(messages: readonly ThreadMessage[]): string {
  return messages.map((message) => `${message.role}[${message.partTypes.join(",") || "-"}]`).join(" ");
}

// ---------------------------------------------------------------------------------------------------------
// latency-*

function judgeLatency(runs: readonly RunOutcome[]): Check[] {
  const summary: NumberSummary = summarize(runs.map((run) => run.numbers.clientFirstAudioMs));
  if (summary.n === 0 || summary.p50 === null || summary.p90 === null) {
    return [{ name: "first audio latency", ok: false, detail: "no run produced a number" }];
  }
  return [
    {
      name: `p50 first audio <= ${LATENCY_LIMITS.p50Ms} ms`,
      ok: summary.p50 <= LATENCY_LIMITS.p50Ms,
      detail: `p50 ${round(summary.p50)} ms over ${summary.n} run${summary.n === 1 ? "" : "s"}`,
    },
    {
      name: `p90 first audio <= ${LATENCY_LIMITS.p90Ms} ms`,
      ok: summary.p90 <= LATENCY_LIMITS.p90Ms,
      detail: `p90 ${round(summary.p90)} ms over ${summary.n} run${summary.n === 1 ? "" : "s"}`,
    },
  ];
}

function latencyCase(fixtureName: FixtureName, options: { thinker: boolean }): VoiceCase {
  return {
    id: `latency-${fixtureName}`,
    title: `From the real end of ${fixtureName}.wav to the first agent audio`,
    repeatable: true,
    needsThinker: options.thinker,
    judge: judgeLatency,
    async run(context, recorder) {
      const fixture = context.fixtures[fixtureName];
      const session = await context.open();
      await session.mic.silence(TIMING.leadInMs);
      const since = session.mark();
      const spoken = say(session, fixture);
      await spoken.clip.sent;
      const endAt = speechEndAt(session, spoken);

      // A microphone stream that fell behind real time sends audio in bursts, and the host's silence timer then
      // runs short: the number would flatter the host, so a slipped stream fails the run instead.
      recorder.number("micMaxLagMs", session.mic.maxLagMs);
      recorder.check(
        `the microphone stream kept within ${context.paceLagMs} ms of real time`,
        session.mic.maxLagMs <= context.paceLagMs,
        `at worst ${round(session.mic.maxLagMs)} ms late`,
      );

      const audio = await firstAudio(session, since);
      const clientMs = audio.at - endAt;
      recorder.number("clientFirstAudioMs", clientMs);
      recorder.check(
        "the agent waited for the person to finish",
        clientMs >= 0,
        clientMs >= 0 ? undefined : `agent audio started ${round(-clientMs)} ms before the end of speech`,
      );

      const metrics = await expectFrame(recorder, session, "host metrics frame (once per answered turn)", isFrame("metrics"), {
        since,
        timeoutMs: TIMING.metricsMs,
      });
      if (metrics?.kind === "frame" && metrics.frame.type === "metrics") {
        recorder.number("hostFirstAudioMs", metrics.frame.speechEndToFirstAudioMs);
        recorder.number("hostTalkerFirstAudioMs", metrics.frame.talkerFirstAudioMs);
        recorder.number("hostTranscribeMs", metrics.frame.transcribeMs);
        if (metrics.frame.speechEndToFirstAudioMs !== null) {
          recorder.number("clientMinusHostMs", clientMs - metrics.frame.speechEndToFirstAudioMs);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// The cases

const factRoutesToDesk: VoiceCase = {
  id: "fact-routes-to-desk",
  title: "A fact question thinks, acknowledges, then answers from the desk",
  repeatable: false,
  needsThinker: true,
  async run(context, recorder) {
    const session = await context.open();
    await session.mic.silence(TIMING.leadInMs);
    const since = session.mark();
    const spoken = say(session, context.fixtures.fact);
    await spoken.clip.sent;
    const endAt = speechEndAt(session, spoken);

    const thinking = await expectFrame(recorder, session, "state thinking", stateIs("thinking"), {
      since,
      timeoutMs: TIMING.replyStartMs,
    });
    if (thinking) {
      recorder.check(
        "thinking begins after the person finished",
        thinking.at >= endAt - FRAME_MS,
        `thinking at ${round(thinking.at - endAt)} ms from the end of speech`,
      );
    }

    const metrics = await expectFrame(recorder, session, "the turn finishing (metrics frame)", isFrame("metrics"), {
      since,
      timeoutMs: TIMING.metricsMs,
    });
    if (metrics) {
      const evidence = ackEvidence(session.timeline, since);
      recorder.note("ackEvidence", evidence);
      recorder.check(
        "an acknowledgement, then the answer",
        evidence !== "none",
        evidence === "none"
          ? "one caption and one unbroken burst of audio: no sign of a short acknowledgement before the answer"
          : `seen as ${evidence}`,
      );
      const replies = assistantReplies(session.timeline, since);
      const last = replies[replies.length - 1];
      recorder.check(
        "the answer is a final, uncut assistant caption",
        Boolean(last?.final && last.final.text.trim() !== "" && last.final.interrupted !== true),
        last?.final ? `answer ${describeText(last.final.text, context.policy)}` : "no final assistant caption",
      );
    }

    const user = await expectFrame(recorder, session, "the person's caption", isUserFinal, {
      since,
      timeoutMs: TIMING.captionMs,
    });
    const userCaption = captionOf(user ?? undefined);
    if (userCaption) {
      recorder.check(
        "the person's caption carries the question",
        carriesText(userCaption.text, context.fixtures.fact.text),
        `caption ${describeText(userCaption.text, context.policy)}`,
      );
    }
  },
};

const taskBecomesCard: VoiceCase = {
  id: "task-becomes-card",
  title: "A task request becomes a card and nothing is written",
  repeatable: false,
  needsThinker: true,
  async run(context, recorder) {
    const session = await context.open();
    await session.mic.silence(TIMING.leadInMs);
    const since = session.mark();
    const spoken = say(session, context.fixtures.task);
    await spoken.clip.sent;

    const card = await expectFrame(recorder, session, "a card frame", isFrame("card"), {
      since,
      timeoutMs: TIMING.metricsMs,
    });
    if (card?.kind === "frame" && card.frame.type === "card") {
      recorder.check(
        "the card's prompt is the request",
        carriesText(card.frame.card.prompt, context.fixtures.task.text),
        `prompt ${describeText(card.frame.card.prompt, context.policy)}`,
      );
      recorder.check("the card has a one-line summary", card.frame.card.summary.trim() !== "");
    }

    await expectFrame(recorder, session, "the saved frame", isFrame("saved"), { since, timeoutMs: TIMING.savedMs });
    const messages = await messagesWhen(context, session.info.threadId, (rows) => rows.length >= 2);
    recorder.note("threadMessages", messages.length);
    recorder.check(
      "no write happened: the thread holds only the spoken turn, as text",
      textOnly(messages) && messages.length <= 2,
      `${messages.length} message(s): ${describeMessages(messages)}`,
    );
  },
};

const unfinishedWaits: VoiceCase = {
  id: "unfinished-waits",
  title: "A sentence that stops on 'yang' gets no answer for at least 2 s",
  repeatable: false,
  needsThinker: false,
  async run(context, recorder) {
    const session = await context.open();
    await session.mic.silence(TIMING.leadInMs);
    const since = session.mark();
    const spoken = say(session, context.fixtures.unfinished);
    await spoken.clip.sent;
    const endAt = speechEndAt(session, spoken);
    await sleepUntil(context.clock, endAt + TIMING.unfinishedQuietMs + 100);

    const early = session.findAll(isAudio, since).filter((rec) => rec.at < endAt + TIMING.unfinishedQuietMs);
    const first = early[0];
    recorder.check(
      `no agent audio for ${TIMING.unfinishedQuietMs} ms after the end of speech`,
      early.length === 0,
      first ? `agent audio ${round(first.at - endAt)} ms after the end of speech` : undefined,
    );
    if (first) {
      recorder.number("firstAudioAfterEndMs", first.at - endAt);
    }
  },
};

const pauseMidSentence: VoiceCase = {
  id: "pause-mid-sentence",
  title: "A pause mid-sentence gets one reply, after the second part",
  repeatable: false,
  needsThinker: true,
  async run(context, recorder) {
    const session = await context.open();
    await session.mic.silence(TIMING.leadInMs);
    const since = session.mark();
    const first = say(session, context.fixtures.unfinished);
    session.mic.say(silencePcm(TIMING.pauseSilenceMs));
    const second = say(session, context.fixtures.fact);
    await second.clip.sent;
    const secondStartAt = speechStartAt(session, second);
    const secondEndAt = speechEndAt(session, second);
    const firstEndAt = speechEndAt(session, first);
    recorder.number("pauseMs", secondStartAt - firstEndAt);

    const audio = await firstAudio(session, since);
    recorder.check(
      "no reply during the pause or the second part",
      audio.at >= secondEndAt,
      audio.at >= secondEndAt ? undefined : `agent audio ${round(secondEndAt - audio.at)} ms before the second part ended`,
    );
    recorder.number("firstAudioAfterSecondPartMs", audio.at - secondEndAt);

    await expectFrame(recorder, session, "the turn finishing (metrics frame)", isFrame("metrics"), {
      since,
      timeoutMs: TIMING.metricsMs,
    });
    await context.clock.sleep(TIMING.secondReplyWatchMs);
    const replies = session.findAll(isFrame("metrics"), since).length;
    recorder.check("exactly one reply", replies === 1, `${replies} answered turn(s)`);

    const heard = await expectFrame(recorder, session, "the person's caption", isUserFinal, {
      since,
      timeoutMs: TIMING.captionMs,
    });
    const user = captionOf(heard ?? undefined);
    if (user) {
      recorder.check(
        "the person's caption carries the second part",
        carriesText(user.text, context.fixtures.fact.text),
        `caption ${describeText(user.text, context.policy)}`,
      );
    }
  },
};

/** How much of the reply the cut left in the saved message. */
function describeCut(savedChars: number, fullChars: number): string {
  return `saved ${savedChars} of ${fullChars} chars`;
}

const bargeInStops: VoiceCase = {
  id: "barge-in-stops",
  title: "Speech over the reply stops it within 300 ms of the 700 ms line",
  repeatable: true,
  needsThinker: false,
  async run(context, recorder) {
    const session = await context.open();
    await session.mic.silence(TIMING.leadInMs);
    const since = session.mark();
    const hello = say(session, context.fixtures.smalltalk);
    await hello.clip.sent;
    const start = await firstAudio(session, since, "the reply to smalltalk.wav");
    await sleepUntil(context.clock, start.at + TIMING.bargeDelayMs);

    // The person talks over the agent. The browser hears it and pauses after a moment.
    const sinceBarge = session.mark();
    const stop = say(session, context.fixtures.stop);
    await session.mic.whenStreamReaches(stop.speechStartMs + TIMING.browserDetectMs);
    session.bargeIn();
    await stop.clip.sent;
    const bargeStartAt = speechStartAt(session, stop);
    const line = bargeStartAt + TIMING.interruptLineMs;

    const cut = await waitForCut(context, recorder, session, sinceBarge, line, start.at);
    if (!cut) {
      return;
    }
    const delta = cut.at - line;
    recorder.number("stopAfterLineMs", delta);
    recorder.check(
      `stop_audio within ${TIMING.stopWithinMs} ms of the ${TIMING.interruptLineMs} ms line`,
      delta <= TIMING.stopWithinMs,
      `${round(delta)} ms after the line (${round(cut.at - bargeStartAt)} ms after speech began)`,
    );

    const finalCut = await expectFrame(recorder, session, "the cut reply's final caption", isCutReplyCaption, {
      since: sinceBarge,
      timeoutMs: TIMING.captionMs,
    });
    const cutCaption = captionOf(finalCut ?? undefined);
    if (cutCaption) {
      recorder.check("the cut reply is marked interrupted", cutCaption.interrupted === true);
    }

    // The next turn: the words that cut in are answered.
    // The caption of the first turn can still be on its way, so only one that carries the new words counts.
    const heard = await expectFrame(
      recorder,
      session,
      "the person's caption carrying the interruption's words",
      (rec) => {
        const caption = captionOf(rec);
        return isUserFinal(rec) && caption !== null && carriesText(caption.text, context.fixtures.stop.text);
      },
      { since: sinceBarge, timeoutMs: TIMING.captionMs },
    );
    const heardCaption = captionOf(heard ?? undefined);
    if (heardCaption) {
      recorder.note("interruptionCaption", describeText(heardCaption.text, context.policy));
    }
    const answer = await expectFrame(
      recorder,
      session,
      "an answer to the interruption",
      (rec) => isAudio(rec) && rec.at > cut.at,
      { since: sinceBarge, timeoutMs: TIMING.replyStartMs },
    );
    if (answer) {
      await expectFrame(recorder, session, "the answer's final caption", (rec) => isAssistantFinal(rec) && !isCutReplyCaption(rec), {
        since: sinceBarge,
        timeoutMs: TIMING.metricsMs,
      });
    }

    await expectFrame(recorder, session, "the saved frame", isFrame("saved"), { since: sinceBarge, timeoutMs: TIMING.savedMs });
    const reply = assistantReplies(session.timeline, since)[0];
    const messages = await messagesWhen(context, session.info.threadId, (rows) => rows.some((row) => row.role === "assistant"));
    const saved = messages.find((message) => message.role === "assistant");
    if (!saved || !reply) {
      recorder.check("the saved assistant text is shorter than the full reply", false, "no saved assistant message or no assistant caption");
      return;
    }
    recorder.note("savedChars", saved.text.length);
    recorder.note("fullReplyChars", reply.longestChars);
    recorder.check(
      "the saved assistant text is shorter than the full reply",
      saved.text.length < reply.longestChars,
      reply.longestChars > 0
        ? describeCut(saved.text.length, reply.longestChars)
        : "no assistant caption was seen, so the full reply is unknown",
    );
  },
};

/** Waits for `stop_audio`; when it never comes, says whether the reply simply ended first (a skip) or was not cut (a failure). */
async function waitForCut(
  context: CaseContext,
  recorder: Recorder,
  session: VoiceSession,
  since: number,
  line: number,
  replyStartAt: number,
): Promise<FrameRec | null> {
  const timeoutMs = Math.max(500, line - context.clock.now()) + TIMING.stopWithinMs + 1_500;
  try {
    const rec = await session.waitFor(isFrame("stop_audio"), { since, timeoutMs, label: "stop_audio" });
    return rec as FrameRec;
  } catch (error) {
    if (!(error instanceof WaitTimeout)) {
      throw error;
    }
    const replyEnded = session.find(stateIs("listening"), since);
    if (replyEnded && replyEnded.at < line) {
      throw new SkipCase(
        `the reply was over (${round(session.playback.receivedMs)} ms of audio) before the ${TIMING.interruptLineMs} ms line, ${round(line - replyStartAt)} ms after it began: nothing was cut, so nothing is proven`,
      );
    }
    recorder.check(
      `stop_audio within ${TIMING.stopWithinMs} ms of the ${TIMING.interruptLineMs} ms line`,
      false,
      `no stop_audio ${round(timeoutMs)} ms after the person began speaking over a reply that was still playing`,
    );
    return null;
  }
}

const backchannelResumes: VoiceCase = {
  id: "backchannel-resumes",
  title: "A short 'iya' over the reply resumes it and the reply is saved whole",
  repeatable: false,
  needsThinker: false,
  async run(context, recorder) {
    const session = await context.open();
    await session.mic.silence(TIMING.leadInMs);
    const since = session.mark();
    const hello = say(session, context.fixtures.smalltalk);
    await hello.clip.sent;
    const start = await firstAudio(session, since, "the reply to smalltalk.wav");
    await sleepUntil(context.clock, start.at + TIMING.bargeDelayMs);

    const sinceBarge = session.mark();
    const iya = say(session, context.fixtures.backchannel);
    await session.mic.whenStreamReaches(iya.speechStartMs + TIMING.browserDetectMs);
    session.bargeIn();
    await iya.clip.sent;
    const endAt = speechEndAt(session, iya);

    const resumed = await expectFrame(recorder, session, "resume_audio", isFrame("resume_audio"), {
      since: sinceBarge,
      timeoutMs: Math.max(500, endAt - context.clock.now()) + TIMING.resumeWithinMs,
    });
    if (resumed) {
      recorder.number("resumeAfterEndMs", resumed.at - endAt);
    }
    const stopped = session.find(isFrame("stop_audio"), sinceBarge);
    if (!resumed && !stopped && session.find(stateIs("listening"), sinceBarge)) {
      throw new SkipCase("the reply was over before the backchannel could pause it: nothing was resumed, so nothing is proven");
    }
    recorder.check("no stop_audio for a backchannel", stopped === undefined, stopped ? "the host cut the reply for an 'iya'" : undefined);

    // From the start of the turn, not from the barge: the host sends the final caption when the talker's stream
    // ends, and the talker speaks faster than the audio plays, so it can come before the person cuts in.
    await expectFrame(recorder, session, "the reply's final caption", isAssistantFinal, {
      since,
      timeoutMs: TIMING.metricsMs,
    });
    await expectFrame(recorder, session, "the saved frame", isFrame("saved"), { since: sinceBarge, timeoutMs: TIMING.savedMs });
    const reply = assistantReplies(session.timeline, since)[0];
    recorder.check(
      "the reply was not marked interrupted",
      reply?.final !== null && reply?.final?.interrupted !== true,
      reply?.final ? undefined : "no final assistant caption",
    );
    const messages = await messagesWhen(context, session.info.threadId, (rows) => rows.some((row) => row.role === "assistant"));
    const saved = messages.find((message) => message.role === "assistant");
    recorder.check(
      "the reply is saved whole",
      Boolean(saved && reply && saved.text.length >= reply.longestChars && saved.text.trim() !== ""),
      saved && reply ? describeCut(saved.text.length, reply.longestChars) : "no saved assistant message",
    );
  },
};

const pushToTalk: VoiceCase = {
  id: "push-to-talk",
  title: "In push-to-talk only commit ends the turn",
  repeatable: false,
  needsThinker: false,
  async run(context, recorder) {
    const session = await context.open({ mode: "push_to_talk" });
    await session.mic.silence(TIMING.leadInMs);
    const since = session.mark();
    const spoken = say(session, context.fixtures.smalltalk);
    await spoken.clip.sent;
    const endAt = speechEndAt(session, spoken);
    await sleepUntil(context.clock, endAt + TIMING.pushToTalkQuietMs);

    const early = session.find((rec) => isAudio(rec) || stateIs("thinking")(rec), since);
    recorder.check(
      `no reply and no thinking for ${TIMING.pushToTalkQuietMs} ms of silence without commit`,
      early === undefined,
      early ? `the host reacted ${round(early.at - endAt)} ms after the end of speech, with no commit` : undefined,
    );

    const sinceCommit = session.mark();
    const commitAt = context.clock.now();
    session.commit();
    const audio = await expectFrame(recorder, session, "the reply after commit", isAudio, {
      since: sinceCommit,
      timeoutMs: TIMING.replyStartMs,
    });
    if (audio) {
      recorder.number("commitToFirstAudioMs", audio.at - commitAt);
    }
  },
};

const turnsSaved: VoiceCase = {
  id: "turns-saved",
  title: "An answered turn is saved to the thread as text, in order",
  repeatable: false,
  needsThinker: false,
  async run(context, recorder) {
    const session = await context.open();
    await session.mic.silence(TIMING.leadInMs);
    const since = session.mark();
    const spoken = say(session, context.fixtures.smalltalk);
    await spoken.clip.sent;

    await expectFrame(recorder, session, "the saved frame", isFrame("saved"), { since, timeoutMs: TIMING.savedMs });
    const messages = await messagesWhen(context, session.info.threadId, (rows) => rows.length >= 2);
    recorder.note("threadMessages", messages.length);
    const user = messages.findIndex((message) => message.role === "user");
    const assistant = messages.findIndex((message) => message.role === "assistant");
    recorder.check(
      "the thread holds the person's words, then the agent's",
      user !== -1 && assistant !== -1 && user < assistant,
      `${messages.length} message(s): ${describeMessages(messages)}`,
    );
    recorder.check("every saved part is text", messages.length > 0 && textOnly(messages));
    const userText = messages[user]?.text ?? "";
    recorder.check(
      "the saved person's text carries what they said",
      user !== -1 && carriesText(userText, context.fixtures.smalltalk.text),
      user !== -1 ? `saved ${describeText(userText, context.policy)}` : "no saved message from the person",
    );
    const lastReply = assistantReplies(session.timeline, since).at(-1);
    const agentText = messages[assistant]?.text ?? "";
    const spoke = lastReply?.final?.text ?? "";
    recorder.check(
      "the saved agent text is what the agent said",
      assistant !== -1 &&
        agentText.trim() !== "" &&
        spoke !== "" &&
        (normalizeText(agentText).includes(normalizeText(spoke)) || normalizeText(spoke).includes(normalizeText(agentText))),
      assistant !== -1
        ? `saved ${describeText(agentText, context.policy)}, spoken ${describeText(spoke, context.policy)}`
        : "no saved message from the agent",
    );
  },
};

const secondSessionReplaces: VoiceCase = {
  id: "second-session-replaces",
  title: "A second session for the same person ends the first with 'replaced'",
  repeatable: false,
  needsThinker: false,
  async run(context, recorder) {
    const first = await context.open();
    const since = first.mark();
    const thread = await context.newThread();
    let secondId: string | null = null;
    try {
      const second = await context.client.startSession(thread);
      secondId = second.sessionId;
      recorder.check("the second H1 is accepted", true);
      const ended = await expectFrame(recorder, first, "ended on the first socket", isFrame("ended"), {
        since,
        timeoutMs: 8_000,
      });
      if (ended?.kind === "frame" && ended.frame.type === "ended") {
        recorder.check(
          "the first session ends with reason replaced",
          ended.frame.reason === "replaced",
          `reason ${ended.frame.reason}`,
        );
      }
    } catch (error) {
      if (error instanceof H1Refused) {
        recorder.check("the second H1 is accepted", false, `H1 answered ${error.status} ${error.code}`);
        return;
      }
      throw error;
    } finally {
      if (secondId) {
        await context.client.endSession(secondId).catch(() => undefined);
      }
    }
  },
};

const REFUSED: ReadonlySet<UpgradeProbe["outcome"]> = new Set(["refused", "refused-after-upgrade"]);

function describeProbe(probe: UpgradeProbe): string {
  switch (probe.outcome) {
    case "refused":
      return `refused (${probe.detail})`;
    case "refused-after-upgrade":
      return `upgraded, then closed with code ${probe.closeCode} and no frame`;
    case "accepted":
      return `ACCEPTED, ${probe.frames} frame(s) before the probe closed it`;
    case "timeout":
      return "the handshake hung";
  }
}

const upgradeNeedsOrigin: VoiceCase = {
  id: "upgrade-needs-origin",
  title: "The socket handshake is refused with no Origin and with a foreign one",
  repeatable: false,
  needsThinker: false,
  async run(context, recorder) {
    const thread = await context.newThread();
    const info = await context.client.startSession(thread);
    try {
      const without = await context.client.probeUpgrade(info, null);
      recorder.check("a handshake with no Origin is refused", REFUSED.has(without.outcome), describeProbe(without));
      const foreign = await context.client.probeUpgrade(info, "https://evil.example");
      recorder.check("a handshake with a foreign Origin is refused", REFUSED.has(foreign.outcome), describeProbe(foreign));

      // Control: the same session opens with the right Origin, so the refusals above were about the Origin.
      let opened = false;
      let detail: string | undefined;
      try {
        const session = await context.client.connect(info);
        opened = true;
        await session.end();
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
      }
      recorder.check("the same session opens with the right Origin", opened, detail);
    } finally {
      await context.client.endSession(info.sessionId).catch(() => undefined);
    }
  },
};

const endIsIdempotent: VoiceCase = {
  id: "end-is-idempotent",
  title: "Ending a session twice answers 200 both times",
  repeatable: false,
  needsThinker: false,
  async run(context, recorder) {
    const session = await context.open();
    const first = await session.endViaHttp();
    const second = await session.endViaHttp();
    const minutes = (body: unknown): number | null => {
      const value = body && typeof body === "object" ? (body as { minutes?: unknown }).minutes : undefined;
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    };
    recorder.check("the first end answers 200", first.status === 200, `HTTP ${first.status}`);
    recorder.check("the second end answers 200", second.status === 200, `HTTP ${second.status}`);
    recorder.check("both answers carry minutes", minutes(first.body) !== null && minutes(second.body) !== null);
    recorder.number("minutes", minutes(first.body));
  },
};

export const CASES: readonly VoiceCase[] = [
  latencyCase("smalltalk", { thinker: false }),
  latencyCase("fact", { thinker: true }),
  latencyCase("long", { thinker: false }),
  factRoutesToDesk,
  taskBecomesCard,
  unfinishedWaits,
  pauseMidSentence,
  bargeInStops,
  backchannelResumes,
  pushToTalk,
  turnsSaved,
  secondSessionReplaces,
  upgradeNeedsOrigin,
  endIsIdempotent,
];

export const CASE_IDS: readonly string[] = CASES.map((item) => item.id);
