/**
 * One voice socket. The host finds the end of a turn (`vad.ts`), sends the utterance to the talker,
 * and streams the reply back. A real interruption aborts that stream. The clock comes from the wiring
 * so a test can move it.
 */
import type { VoiceEndReason, VoiceHostFrame, VoiceMode, VoiceState } from "@agentforge/core/voice";
import {
  VOICE_LIMITS,
  VOICE_MAX_AUDIO_FRAME_BYTES,
  parseVoiceBrowserFrame,
} from "@agentforge/core/voice";
import { WebSocket, type RawData } from "ws";
import { log } from "../log";
import type { AskResult } from "./ask";
import { audioFasterThanRealtime, outboundBacklogTooHigh, pcmBytesForMs, pcmDurationMs } from "./pcm";
import { recentVoiceHistory, saveVoiceTurn } from "./save-turns";
import { voiceSessions } from "./sessions";
import type { TalkerEvent, TalkerSession, TalkerUsage } from "./talker";
import { TalkerError } from "./talker";
import { TURN_TIMING, judgeBargeIn, judgeTurnEnd, trimToHeard } from "./turns";
import { createVad, type Vad } from "./vad";
import type { VoiceSession } from "./sessions";
import { recordVoiceReplyUsage, recordVoiceSeconds } from "./metering";
import { voiceWiring } from "./wiring";

/** Speech this long before `speech_start` stays on the utterance. The detector itself waits 120 ms. */
const PRE_ROLL_MS = 420;
const SLICE_MS = 20;
/** About ten captions a second. */
const CAPTION_MIN_GAP_MS = 100;
/** A `barge_in` with no speech in this long is not an interruption. Not a `TURN_TIMING` field. */
const BARGE_SILENCE_MS = 600;
const FAILURES_BEFORE_END = 3;
/** Peak above the detector's floor. Silence, including the hangover, does not move the speech clock. */
const SPEECH_PEAK = 0.015 * 32768;

const PLACEHOLDER = { en: "Voice message", id: "Pesan suara" } as const;

/**
 * How long a turn that was cut (or ended) before its transcript arrived waits for it, before it is saved
 * with the placeholder. The transcriber has its own 15 s limit and two tries, so this only guards a hang.
 */
const LATE_WORDS_WAIT_MS = 20_000;

type PendingAnswer = { readonly callId: string; readonly text: string };

function asBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function sliceHasSpeech(pcm: Buffer): boolean {
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    if (Math.abs(pcm.readInt16LE(i)) > SPEECH_PEAK) return true;
  }
  return false;
}

function tail(buffer: Buffer, maxBytes: number): Buffer {
  if (buffer.length <= maxBytes) return buffer;
  let start = buffer.length - maxBytes;
  if (start % 2 === 1) start -= 1;
  return Buffer.from(buffer.subarray(start));
}

export class VoiceRelay {
  private readonly vad: Vad = createVad();
  private talkerSession: TalkerSession | null = null;
  private mode: VoiceMode;
  private started = false;
  private shut = false;
  private closedByUs = false;
  private readonly queued: Array<{ data: RawData; isBinary: boolean }> = [];
  private readonly queuedAudio: Buffer[] = [];

  /** `connecting` until `ready` has gone out: the view starts there and only a state frame moves it on. */
  private state: VoiceState = "connecting";
  private generation = 0;
  private errors = 0;
  private replyAbort: AbortController | null = null;
  private askAbort: AbortController | null = null;
  private transcribeAbort: AbortController | null = null;
  private hearAbort: AbortController | null = null;

  private utterance: Buffer | null = null;
  private rolling: Buffer = Buffer.alloc(0);
  private heardSpeech = false;
  private released = false;
  private forceRelease = false;
  private replyLive = false;
  private replyMustAnswer = false;
  private sawEvent = false;
  private heldForWait = false;
  private diverted = false;
  private pendingAnswer: PendingAnswer | null = null;
  private asked = false;
  private readonly buffered: TalkerEvent[] = [];

  private assistantText = "";
  private userText: string | null = null;
  private turn = 0;
  private idsReady = false;
  private assistantId = "";
  private userCaptionId = "";
  private ackId = "";
  private lastCaptionAt = 0;

  private talkerStartedAt: number | null = null;
  private talkerFirstAudioAt: number | null = null;
  private lastSpeechAt: number | null = null;
  private firstForwardedAt: number | null = null;
  private forwardedAudioBytes = 0;
  /** Of `forwardedAudioBytes`, the acknowledgement. It plays first and is not part of `assistantText`. */
  private ackBytes = 0;
  private pendingUsage: TalkerUsage | null = null;
  private replyFinished = false;
  private saved = false;
  private playbackElapsed = false;
  private speechEndToFirstAudioMs: number | null = null;
  private transcribeMs: number | null = null;
  private transcribeStarted = false;
  /** The words of the turn in flight, while the transcriber is still hearing them. Never rejects. */
  private transcriptWait: Promise<string | null> | null = null;
  private transcribeStartedAt: number | null = null;
  /**
   * Saving a turn goes through here, one at a time and in order. A cut turn whose words are still being
   * transcribed holds its place, so the turn after it cannot land in the thread ahead of it.
   */
  private saveChain: Promise<void> = Promise.resolve();

  private interrupting = false;
  private interruptPromise: Promise<void> | null = null;
  private overlapActive = false;
  private overlapPcm: Buffer = Buffer.alloc(0);
  /** Where the speech over the reply began, in the detector's own time. Null until it has started. */
  private overlapStartMs: number | null = null;
  private judging = false;
  /** The last 200 ms, so speech that armed the overlap is kept with it. */
  private recent: Buffer = Buffer.alloc(0);

  private idleCancel: (() => void) | null = null;
  private playbackCancel: (() => void) | null = null;
  private bargeCancel: (() => void) | null = null;
  private playedCancel: (() => void) | null = null;
  private playedWaiter: ((ms: number | null) => void) | null = null;

  private rateWindowStart = 0;
  private rateWindowBytes = 0;

  constructor(
    private readonly ws: WebSocket,
    private readonly session: VoiceSession,
  ) {
    this.mode = session.mode;
    this.ws.on("message", (data, isBinary) => {
      if (this.shut) return;
      if (!this.started) {
        this.queued.push({ data, isBinary });
        return;
      }
      this.onMessage(data, isBinary);
    });
    this.ws.on("close", () => {
      if (!this.closedByUs) this.requestEnd("dropped");
    });
    this.ws.on("error", () => {
      if (!this.closedByUs) this.requestEnd("dropped");
    });
  }

  async start(): Promise<void> {
    if (this.shut) return;
    if (!voiceSessions().attach(this.session.id, this)) {
      this.closedByUs = true;
      this.ws.close();
      return;
    }
    this.noteActivity();
    try {
      const history = await recentVoiceHistory(this.session.tenant, this.session.threadId);
      if (this.shut) return;
      this.talkerSession = this.session.talker.open({ locale: this.session.locale, history });
      this.send({
        type: "ready",
        sessionId: this.session.id,
        threadId: this.session.threadId,
        endsAt: this.session.endsAt,
      });
      this.setState("listening");
      this.started = true;
      log.info("voice_open", { voiceId: this.session.id });
      const queued = this.queued.splice(0);
      for (const item of queued) this.onMessage(item.data, item.isBinary);
    } catch {
      log.warn("voice_reply_failed", { voiceId: this.session.id, code: "failed" });
      this.requestEnd("error");
    }
  }

  /** The registry calls this. It does not call `end` again. */
  shutdown(reason: VoiceEndReason): void {
    if (this.shut) return;
    this.shut = true;
    this.generation += 1;
    // A reply was released and its transcript is still on its way: the person's words are saved when they
    // arrive, not replaced by the placeholder, so that transcription is not cut off with the rest.
    const awaitingWords = this.released && !this.saved && this.userText === null && this.transcribeStarted && !this.asked;
    this.abortWork(awaitingWords);
    this.idleCancel?.();
    this.playbackCancel?.();
    this.bargeCancel?.();
    this.playedCancel?.();
    if (this.playedWaiter) {
      const resolve = this.playedWaiter;
      this.playedWaiter = null;
      resolve(null);
    }
    const durationMs = Math.max(0, voiceWiring().clock.now() - this.session.createdAt);
    const persist = (this.released && !this.saved ? this.persistPartial() : Promise.resolve()).then(() => this.saveChain);
    void persist.finally(() => {
      this.send({ type: "ended", reason }, true);
      this.closedByUs = true;
      if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
      this.talkerSession?.close();
      voiceSessions().meter(this.session);
      log.info("voice_end", { voiceId: this.session.id, reason, durationMs });
    });
  }

  private requestEnd(reason: VoiceEndReason): void {
    if (this.shut) return;
    voiceSessions().end(this.session.id, reason);
  }

  /** `keepTranscribe`: the transcript of the turn being cut is still wanted, so only the rest is stopped. */
  private abortWork(keepTranscribe = false): void {
    this.replyAbort?.abort();
    this.askAbort?.abort();
    if (!keepTranscribe) this.transcribeAbort?.abort();
    this.hearAbort?.abort();
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    if (this.shut) return;
    if (isBinary) {
      const pcm = asBuffer(data);
      if (pcm.length % 2 !== 0) return;
      if (this.noteRate(pcm.length)) return;
      this.feed(pcm);
      return;
    }
    const frame = parseVoiceBrowserFrame(asBuffer(data).toString("utf8"));
    if (!frame) return;
    this.noteActivity();
    if (frame.type === "stop") {
      this.requestEnd("user");
      return;
    }
    if (frame.type === "mode") {
      this.mode = frame.value;
      this.session.mode = frame.value;
      return;
    }
    if (frame.type === "commit") {
      this.onCommit();
      return;
    }
    if (frame.type === "barge_in") {
      this.onBargeFrame();
      return;
    }
    if (frame.type === "played" && this.playedWaiter) {
      this.playedCancel?.();
      const resolve = this.playedWaiter;
      this.playedWaiter = null;
      resolve(frame.ms);
    }
  }

  /** True when this frame ended the session. */
  private noteRate(byteLength: number): boolean {
    const now = voiceWiring().clock.now();
    if (this.rateWindowStart === 0) this.rateWindowStart = now;
    const windowMs = now - this.rateWindowStart;
    if (windowMs >= 1000 && audioFasterThanRealtime(this.rateWindowBytes, windowMs)) {
      this.requestEnd("dropped");
      return true;
    }
    if (windowMs >= 1000) {
      this.rateWindowStart = now;
      this.rateWindowBytes = byteLength;
    } else {
      this.rateWindowBytes += byteLength;
    }
    return false;
  }

  private feed(pcm: Buffer): void {
    if (this.shut) return;
    if (this.interrupting) {
      this.queuedAudio.push(Buffer.from(pcm));
      return;
    }
    const sliceBytes = pcmBytesForMs(SLICE_MS);
    let offset = 0;
    while (offset < pcm.length) {
      if (this.interrupting) {
        const rest = Buffer.from(pcm.subarray(offset));
        if (rest.length > 0) this.queuedAudio.push(rest);
        return;
      }
      const end = Math.min(offset + sliceBytes, pcm.length);
      this.feedSlice(pcm.subarray(offset, end));
      offset = end;
    }
  }

  private feedSlice(slice: Buffer): void {
    if (this.shut || this.interrupting) return;
    const copy = Buffer.from(slice);
    const prior = this.recent;
    this.recent = tail(Buffer.concat([this.recent, copy]), pcmBytesForMs(200));
    if (sliceHasSpeech(copy)) {
      this.lastSpeechAt = voiceWiring().clock.now();
      this.noteActivity();
    }
    if (!this.released) {
      if (this.utterance) this.utterance = Buffer.concat([this.utterance, copy]);
      else this.rolling = tail(Buffer.concat([this.rolling, copy]), pcmBytesForMs(PRE_ROLL_MS));
    }
    const events = this.vad.push(copy);
    for (const event of events) {
      if (event.type === "speech_start") this.onSpeechStart(prior, event.atMs);
      else if (this.overlapActive && !this.interrupting) this.onOverlapEnd();
    }
    if (this.interrupting) return;
    if (this.overlapActive && this.vad.speaking) {
      this.overlapPcm = Buffer.concat([this.overlapPcm, copy]);
      if (this.overlapSpeechMs() >= TURN_TIMING.interruptAfterMs) {
        void this.interrupt();
        return;
      }
    }
    if (
      !this.released &&
      this.utterance &&
      pcmDurationMs(this.utterance.length) >= VOICE_LIMITS.maxUtteranceMs
    ) {
      this.onCommit();
      return;
    }
    this.consider();
  }

  private onSpeechStart(prior: Buffer, atMs: number): void {
    this.lastSpeechAt = voiceWiring().clock.now();
    this.noteActivity();
    if (!this.released) {
      if (!this.utterance) {
        this.utterance = this.rolling;
        this.rolling = Buffer.alloc(0);
      }
      if (this.replyLive) this.abortEarly();
      this.heardSpeech = true;
      this.heldForWait = false;
      this.beginTurnIds();
      this.setState("hearing");
      return;
    }
    this.armOverlap();
    this.overlapPcm = Buffer.from(prior);
    this.overlapStartMs = atMs;
  }

  private abortEarly(): void {
    this.generation += 1;
    this.replyAbort?.abort();
    this.replyAbort = null;
    this.transcribeAbort?.abort();
    this.transcribeAbort = null;
    this.transcribeStarted = false;
    this.userText = null;
    this.transcribeMs = null;
    this.replyLive = false;
    this.buffered.length = 0;
    this.sawEvent = false;
    this.pendingUsage = null;
    this.talkerFirstAudioAt = null;
  }

  private consider(): void {
    if (this.shut || this.released || this.interrupting || this.mode === "push_to_talk") return;
    if (!this.heardSpeech || !this.utterance) return;
    const silence = this.vad.silenceMs;
    // A `wait` already refused this pause. More silence must not send it again; only the cap may.
    if (this.heldForWait && !this.replyLive) {
      if (silence >= TURN_TIMING.maxSilenceMs) this.startReply(true);
      return;
    }
    if (!this.replyLive && silence >= TURN_TIMING.earlySendMs) {
      this.startReply(false);
      return;
    }
    if (this.sawEvent && this.canRelease()) this.flush();
  }

  private canRelease(): boolean {
    return this.forceRelease || (this.mode === "hands_free" && this.vad.silenceMs >= TURN_TIMING.endSilenceMs);
  }

  private onCommit(): void {
    if (this.shut || this.released || !this.heardSpeech) return;
    this.forceRelease = true;
    this.replyMustAnswer = true;
    if (!this.replyLive) this.startReply(true);
    else if (this.sawEvent) this.flush();
  }

  private startReply(mustAnswer: boolean): void {
    if (!this.talkerSession || !this.utterance || this.shut) return;
    this.replyLive = true;
    this.replyMustAnswer = mustAnswer;
    this.talkerStartedAt = voiceWiring().clock.now();
    this.talkerFirstAudioAt = null;
    const gen = this.generation;
    const ac = new AbortController();
    this.replyAbort = ac;
    const pcm = Buffer.from(this.utterance);
    const pending = this.pendingAnswer;
    this.pendingAnswer = null;
    let iterable: AsyncIterable<TalkerEvent>;
    try {
      iterable = pending
        ? this.talkerSession.answer(pending.callId, pending.text, { signal: ac.signal, mustAnswer: true })
        : this.talkerSession.reply(pcm, { signal: ac.signal, ...(mustAnswer ? { mustAnswer: true } : {}) });
    } catch (error) {
      this.failTalker(error);
      return;
    }
    queueMicrotask(() => {
      if (gen !== this.generation || ac.signal.aborted || this.shut) return;
      void this.consume(iterable, gen, ac.signal);
    });
  }

  private async consume(iterable: AsyncIterable<TalkerEvent>, gen: number, signal: AbortSignal): Promise<void> {
    const iterator = iterable[Symbol.asyncIterator]();
    let failed: unknown = null;
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done || gen !== this.generation || signal.aborted || this.shut) break;
        const diverted = this.onTalkerEvent(next.value, gen);
        if (diverted || gen !== this.generation) break;
      }
    } catch (error) {
      failed = error;
    } finally {
      try {
        await iterator.return?.();
      } catch {
        // The talker is already finished or aborted.
      }
    }
    if (failed && !signal.aborted && gen === this.generation && !this.shut) this.failTalker(failed);
  }

  /** True when this event started an `ask` and the rest of this reply must be dropped. */
  private onTalkerEvent(event: TalkerEvent, gen: number): boolean {
    if (gen !== this.generation || this.shut) return false;
    if (!this.released) {
      if (event.type === "done" && !this.sawEvent) {
        this.generation += 1;
        this.replyAbort?.abort();
        this.replyLive = false;
        this.backToListening(true);
        return false;
      }
      if (this.buffered.length === 0 && this.isUnfinished(event)) {
        if (!(this.replyMustAnswer && event.type === "wait")) {
          this.holdForWait();
          return false;
        }
      } else if (event.type !== "done" && event.type !== "wait") {
        if (event.type === "audio" && this.talkerFirstAudioAt === null) {
          this.talkerFirstAudioAt = voiceWiring().clock.now();
        }
        if (event.type === "usage") this.pendingUsage = event.usage;
        this.buffered.push(event);
        if (event.type === "audio" || event.type === "text") this.maybeTranscribe();
        if (event.type === "audio" || event.type === "text" || event.type === "ask") this.sawEvent = true;
      } else if (event.type === "done") {
        this.buffered.push(event);
      }
      if (this.sawEvent && this.canRelease()) this.flush();
      return false;
    }
    if (this.diverted) return false;
    return this.apply(event);
  }

  private isUnfinished(event: TalkerEvent): boolean {
    if (event.type === "wait") return true;
    return (
      event.type === "ask" &&
      !this.replyMustAnswer &&
      judgeTurnEnd(event.question, this.session.locale) === "wait"
    );
  }

  private holdForWait(): void {
    this.generation += 1;
    this.replyAbort?.abort();
    this.replyAbort = null;
    this.replyLive = false;
    this.buffered.length = 0;
    this.sawEvent = false;
    this.heldForWait = true;
    this.errors = 0;
    this.setState("listening");
    if (this.mode !== "push_to_talk" && this.vad.silenceMs >= TURN_TIMING.maxSilenceMs) {
      this.startReply(true);
    }
  }

  private flush(): void {
    if (this.released) return;
    this.released = true;
    this.setState("thinking");
    const events = this.buffered.splice(0);
    for (const event of events) {
      if (this.apply(event)) break;
    }
  }

  /** True when the event was an `ask` and the reply was diverted. */
  private apply(event: TalkerEvent): boolean {
    if (event.type === "audio") {
      if (this.talkerFirstAudioAt === null) this.talkerFirstAudioAt = voiceWiring().clock.now();
      this.maybeTranscribe();
      this.forwardPcm(event.pcm, true);
      return false;
    }
    if (event.type === "text") {
      this.maybeTranscribe();
      this.assistantText += event.delta;
      this.captionAssistant(false);
      return false;
    }
    if (event.type === "ask") {
      void this.handleAsk(event.callId, event.question);
      return true;
    }
    if (event.type === "usage") {
      this.pendingUsage = event.usage;
      return false;
    }
    if (event.type === "done") {
      if (!this.assistantText && !this.asked && this.forwardedAudioBytes === 0) {
        this.backToListening(true);
        return false;
      }
      this.replyFinished = true;
      this.replyLive = false;
      this.errors = 0;
      this.captionAssistant(true);
      this.schedulePlayback();
      return false;
    }
    return false;
  }

  private async handleAsk(callId: string, question: string): Promise<void> {
    this.asked = true;
    this.diverted = true;
    this.userText = question;
    this.beginTurnIds();
    this.send({ type: "caption", role: "user", id: this.userCaptionId, text: question, final: true });
    const ack = this.talkerSession?.acknowledgement() ?? null;
    if (ack) {
      this.send({ type: "caption", role: "assistant", id: this.ackId, text: ack.text, final: true });
      this.forwardPcm(ack.pcm, false);
    }
    const ac = new AbortController();
    this.askAbort = ac;
    let result: AskResult;
    try {
      result = await voiceWiring().ask({
        tenant: this.session.tenant,
        threadId: this.session.threadId,
        question,
        locale: this.session.locale,
        signal: ac.signal,
      });
    } catch {
      if (ac.signal.aborted || this.shut) return;
      this.failTalker(new TalkerError("failed", "ask"));
      return;
    }
    if (ac.signal.aborted || this.shut || this.interrupting) return;
    if (this.pendingUsage) {
      recordVoiceReplyUsage(this.session.tenant, this.session.model, this.pendingUsage);
      this.pendingUsage = null;
    }
    if (result.kind === "needs_tap") this.send({ type: "card", card: result.card });
    this.generation += 1;
    this.replyLive = false;
    this.diverted = false;
    this.replyFinished = false;
    this.pendingAnswer = { callId, text: result.text };
    this.startReply(true);
  }

  private maybeTranscribe(): void {
    if (this.asked || this.transcribeStarted || !this.utterance || !this.talkerSession) return;
    this.transcribeStarted = true;
    const gen = this.generation;
    const pcm = Buffer.from(this.utterance);
    const started = voiceWiring().clock.now();
    const ac = new AbortController();
    this.transcribeAbort = ac;
    this.transcribeStartedAt = started;
    this.transcriptWait = this.runTranscribe(pcm, gen, started, ac);
  }

  /**
   * Hears the utterance. Resolves with the words (null when it could not, or was stopped) and never rejects.
   * A turn that was cut meanwhile (`gen` moved on) still gets its words back, for its own save; they are never
   * put on the turn now in flight.
   */
  private async runTranscribe(pcm: Buffer, gen: number, started: number, ac: AbortController): Promise<string | null> {
    let text: string | null = null;
    let seconds = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (ac.signal.aborted) return null;
      try {
        const result = await this.session.transcriber.transcribe(pcm, {
          locale: this.session.locale,
          signal: ac.signal,
        });
        if (result?.text.trim()) {
          text = result.text.trim();
          seconds = result.seconds;
          break;
        }
      } catch {
        text = null;
      }
    }
    if (ac.signal.aborted) return null;
    if (text) recordVoiceSeconds(this.session.tenant, this.session.transcriberModel, seconds);
    // The turn moved on (it was cut, or the session ended): its words go back to whoever waits for them, and
    // are never put on the turn that is in flight now.
    if (gen !== this.generation || this.shut) return text;
    this.transcribeMs = Math.max(0, voiceWiring().clock.now() - started);
    this.userText = text ?? PLACEHOLDER[this.session.locale];
    this.send({ type: "caption", role: "user", id: this.userCaptionId, text: this.userText, final: true });
    this.tryFinalize();
    return text;
  }

  private forwardPcm(pcm: Buffer, fromTalker: boolean): void {
    const even = pcm.length % 2 === 0 ? pcm : pcm.subarray(0, pcm.length - 1);
    let offset = 0;
    while (offset < even.length) {
      if (this.shut) return;
      if (outboundBacklogTooHigh(this.ws.bufferedAmount)) {
        this.requestEnd("dropped");
        return;
      }
      const end = Math.min(offset + VOICE_MAX_AUDIO_FRAME_BYTES, even.length);
      const chunk = even.subarray(offset, end);
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(chunk);
      this.forwardedAudioBytes += chunk.length;
      if (!fromTalker) this.ackBytes += chunk.length;
      if (this.firstForwardedAt === null) {
        this.firstForwardedAt = voiceWiring().clock.now();
        if (this.lastSpeechAt !== null && this.speechEndToFirstAudioMs === null) {
          this.speechEndToFirstAudioMs = Math.max(0, this.firstForwardedAt - this.lastSpeechAt);
        }
        this.setState("speaking");
      }
      if (fromTalker && this.talkerFirstAudioAt === null) {
        this.talkerFirstAudioAt = voiceWiring().clock.now();
      }
      offset = end;
    }
    this.schedulePlayback();
  }

  private schedulePlayback(): void {
    if (!this.replyFinished || this.saved || this.interrupting || this.shut) return;
    this.playbackCancel?.();
    const total = pcmDurationMs(this.forwardedAudioBytes);
    const start = this.firstForwardedAt ?? voiceWiring().clock.now();
    const delay = Math.max(0, start + total - voiceWiring().clock.now());
    this.playbackCancel = voiceWiring().clock.after(delay, () => {
      this.playbackElapsed = true;
      this.tryFinalize();
    });
  }

  private tryFinalize(): void {
    if (this.saved || this.shut || this.interrupting || !this.replyFinished || this.userText === null) return;
    if (!this.playbackElapsed) {
      if (this.firstForwardedAt === null) this.playbackElapsed = true;
      else if (voiceWiring().clock.now() >= this.firstForwardedAt + pcmDurationMs(this.forwardedAudioBytes)) {
        this.playbackElapsed = true;
      }
    }
    if (!this.playbackElapsed) return;
    void this.finalize(false);
  }

  private async finalize(interrupted: boolean): Promise<void> {
    if (this.saved || this.interrupting) return;
    this.saved = true;
    this.playbackCancel?.();
    const user = this.userText?.trim() ? this.userText.trim() : "";
    const assistant = this.assistantText.trim();
    const metrics = this.metricsFrame();
    try {
      await this.saveTurn(user, assistant);
    } catch {
      // The turn still closes. A ledger or thread miss must not keep the socket in `speaking`.
    }
    this.talkerSession?.remember({ user: user || null, assistant, interrupted });
    if (this.pendingUsage && !interrupted) {
      recordVoiceReplyUsage(this.session.tenant, this.session.model, this.pendingUsage);
    }
    this.errors = 0;
    this.send({ type: "saved" });
    this.send(metrics);
    this.resetTurn();
    this.vad.reset();
    this.setState("listening");
  }

  private metricsFrame(): Extract<VoiceHostFrame, { type: "metrics" }> {
    const talkerFirstAudioMs =
      this.talkerStartedAt !== null && this.talkerFirstAudioAt !== null
        ? Math.max(0, this.talkerFirstAudioAt - this.talkerStartedAt)
        : null;
    return {
      type: "metrics",
      speechEndToFirstAudioMs: this.speechEndToFirstAudioMs,
      talkerFirstAudioMs,
      transcribeMs: this.transcribeMs,
    };
  }

  private async persistPartial(): Promise<void> {
    if (this.saved) return;
    this.saved = true;
    const assistant = this.assistantText.trim();
    let words = this.userText;
    if (words === null && !this.asked && this.transcriptWait) {
      words = await this.within(this.transcriptWait, LATE_WORDS_WAIT_MS);
    }
    const user = words?.trim() ? words.trim() : this.asked ? "" : PLACEHOLDER[this.session.locale];
    try {
      await this.saveTurn(user, assistant);
    } catch {
      // Ending still closes the socket.
    }
    this.talkerSession?.remember({ user: user || null, assistant, interrupted: true });
  }

  private onBargeFrame(): void {
    if (!this.released || this.interrupting || this.shut) return;
    this.armOverlap();
    this.bargeCancel?.();
    this.bargeCancel = voiceWiring().clock.after(BARGE_SILENCE_MS, () => {
      if (this.overlapStartMs === null && !this.vad.speaking && this.overlapActive && !this.interrupting && !this.shut) {
        this.clearOverlap();
        this.send({ type: "resume_audio" });
      }
    });
  }

  private armOverlap(): void {
    if (this.overlapActive) return;
    this.overlapActive = true;
    this.overlapPcm = Buffer.alloc(0);
    this.overlapStartMs = null;
  }

  /**
   * How long the person has really spoken over the reply: from where the detector says the speech began to
   * where it last heard speech. Not the audio kept (that starts 200 ms before the detector was sure) and not the
   * quiet the detector is still waiting out before it calls the speech over: both would make a short "iya" of
   * 0.55 s count past the 700 ms line.
   */
  private overlapSpeechMs(): number {
    return this.overlapStartMs === null ? 0 : Math.max(0, this.vad.lastSpeechMs - this.overlapStartMs);
  }

  private clearOverlap(): void {
    this.overlapActive = false;
    this.overlapPcm = Buffer.alloc(0);
    this.overlapStartMs = null;
    this.bargeCancel?.();
    this.bargeCancel = null;
  }

  private onOverlapEnd(): void {
    if (this.judging || this.interrupting) return;
    const speechMs = this.overlapSpeechMs();
    if (speechMs >= TURN_TIMING.interruptAfterMs) {
      void this.interrupt();
      return;
    }
    this.judging = true;
    const pcm = Buffer.from(this.overlapPcm);
    void this.judgeShort(pcm, speechMs);
  }

  private async judgeShort(pcm: Buffer, speechMs: number): Promise<void> {
    const ac = new AbortController();
    this.hearAbort = ac;
    let transcript: string | null = null;
    try {
      transcript = (await this.talkerSession?.hearShort(pcm, ac.signal)) ?? null;
    } catch {
      transcript = null;
    }
    this.judging = false;
    if (this.shut || this.interrupting || ac.signal.aborted) return;
    if (this.overlapSpeechMs() >= TURN_TIMING.interruptAfterMs || this.vad.speaking) return;
    const verdict = judgeBargeIn({ transcript, speechMs, locale: this.session.locale });
    if (verdict === "interrupt") {
      await this.interrupt();
      return;
    }
    this.clearOverlap();
    this.send({ type: "resume_audio" });
  }

  private interrupt(): Promise<void> {
    if (this.interruptPromise) return this.interruptPromise;
    this.interrupting = true;
    this.interruptPromise = this.doInterrupt();
    return this.interruptPromise;
  }

  private async doInterrupt(): Promise<void> {
    this.playbackCancel?.();
    this.playbackCancel = null;
    this.replyFinished = false;
    this.send({ type: "stop_audio" });
    // The person's words may still be on their way: the transcriber hears the whole utterance in 3 to 5 s and a
    // cut can come sooner. That turn is saved when they arrive, not with the placeholder.
    const words = this.userText === null && this.transcribeStarted && !this.asked ? this.transcriptWait : null;
    this.generation += 1;
    this.abortWork(words !== null);
    // The next turn's early abort must not stop it.
    if (words !== null) this.transcribeAbort = null;
    // The browser's `played` and the host's own estimate both count every millisecond of agent audio since
    // `listening`, the acknowledgement included. `assistantText` is the answer alone, so the share of it that
    // was heard is measured on the audio after the acknowledgement.
    const ackMs = pcmDurationMs(this.ackBytes);
    const allMs = pcmDurationMs(this.forwardedAudioBytes);
    const totalMs = Math.max(0, allMs - ackMs);
    const estimate =
      this.firstForwardedAt === null
        ? 0
        : Math.min(allMs, Math.max(0, voiceWiring().clock.now() - this.firstForwardedAt));
    const played = await this.waitPlayed();
    const playedMs = Math.max(0, (played ?? estimate) - ackMs);
    const trimmed =
      totalMs > 0 ? trimToHeard({ text: this.assistantText, playedMs, totalMs }) : { text: "", interrupted: true };
    this.assistantText = trimmed.text;
    this.beginTurnIds();
    this.send({
      type: "caption",
      role: "assistant",
      id: this.assistantId,
      text: trimmed.text,
      final: true,
      interrupted: true,
    });
    const overlap = Buffer.from(this.overlapPcm);
    const metrics = this.metricsFrame();
    if (words !== null && this.userText === null) {
      // The reply stays cut and the person is heard at once; the turn is saved, and its caption and `saved` sent,
      // when the transcript arrives. The talker is told only what it said: the words are not known yet.
      this.talkerSession?.remember({ user: null, assistant: trimmed.text, interrupted: true });
      this.saveCutTurnWhenHeard({
        words,
        userCaptionId: this.userCaptionId,
        assistant: trimmed.text,
        metrics,
        startedAt: this.transcribeStartedAt,
      });
    } else {
      if (this.userText === null) this.userText = PLACEHOLDER[this.session.locale];
      const user = this.userText.trim();
      try {
        await this.saveTurn(user, trimmed.text);
      } catch {
        // The socket still moves on to the overlapped speech.
      }
      this.talkerSession?.remember({ user: user || null, assistant: trimmed.text, interrupted: true });
      this.send({ type: "saved" });
      this.send(metrics);
    }
    this.saved = true;
    this.resetTurn();
    this.vad.reset();
    this.interrupting = false;
    this.interruptPromise = null;
    // The agent's turn is over, and `listening` is the one frame the browser starts counting the next reply's
    // heard milliseconds from zero on (`PlaybackQueue.endTurn`). Going straight to `hearing` would add this reply's
    // heard time to the next one's `played`, and the next cut would keep words that were never heard.
    this.setState("listening");
    if (overlap.length > 0) {
      this.utterance = overlap;
      this.heardSpeech = true;
      this.beginTurnIds();
      this.setState("hearing");
    }
    const queued = this.queuedAudio.splice(0);
    for (const chunk of queued) this.feed(chunk);
  }

  /** One save at a time, in the order the turns were asked to be saved. */
  private enqueueSave<T>(task: () => Promise<T>): Promise<T> {
    const run = this.saveChain.then(task);
    this.saveChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private saveTurn(user: string, assistant: string): Promise<void> {
    return this.enqueueSave(() => saveVoiceTurn(this.session.tenant, this.session.threadId, user, assistant));
  }

  /** The promise's value, or null once `ms` of the session clock has passed. */
  private within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    return new Promise((resolve) => {
      let settled = false;
      const cancel = voiceWiring().clock.after(ms, () => {
        if (settled) return;
        settled = true;
        resolve(null);
      });
      void promise.then((value) => {
        if (settled) return;
        settled = true;
        cancel();
        resolve(value);
      });
    });
  }

  /**
   * A cut turn whose words were still being transcribed. It takes its place in the save order now, so the turn
   * after it lands behind it, and finishes when the words are in: the person's caption, the thread rows, `saved`.
   */
  private saveCutTurnWhenHeard(input: {
    readonly words: Promise<string | null>;
    readonly userCaptionId: string;
    readonly assistant: string;
    readonly metrics: Extract<VoiceHostFrame, { type: "metrics" }>;
    readonly startedAt: number | null;
  }): void {
    const locale = this.session.locale;
    void this.enqueueSave(async () => {
      const heard = await this.within(input.words, LATE_WORDS_WAIT_MS);
      const user = heard?.trim() ? heard.trim() : PLACEHOLDER[locale];
      this.send({ type: "caption", role: "user", id: input.userCaptionId, text: user, final: true });
      try {
        await saveVoiceTurn(this.session.tenant, this.session.threadId, user, input.assistant);
      } catch {
        // The turn still closes; a thread miss must not leave the view waiting for `saved`.
      }
      const transcribeMs =
        input.startedAt === null || heard === null ? null : Math.max(0, voiceWiring().clock.now() - input.startedAt);
      this.send({ type: "saved" });
      this.send({ ...input.metrics, transcribeMs });
    });
  }

  private waitPlayed(): Promise<number | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ms: number | null) => {
        if (settled) return;
        settled = true;
        this.playedWaiter = null;
        this.playedCancel?.();
        resolve(ms);
      };
      this.playedWaiter = finish;
      this.playedCancel = voiceWiring().clock.after(TURN_TIMING.playedWaitMs, () => finish(null));
    });
  }

  private failTalker(error: unknown): void {
    if (this.shut) return;
    this.errors += 1;
    this.generation += 1;
    this.replyAbort?.abort();
    const code = error instanceof TalkerError ? error.code : "failed";
    log.warn("voice_reply_failed", { voiceId: this.session.id, code });
    this.backToListening(true);
    if (this.errors >= FAILURES_BEFORE_END) this.requestEnd("error");
  }

  /** `keepUtterance` is false: a failed reply must not immediately send the same audio again. */
  private backToListening(clearUtterance: boolean): void {
    if (clearUtterance) this.resetTurn();
    else {
      this.replyLive = false;
      this.replyFinished = false;
      this.released = false;
      this.forceRelease = false;
      this.sawEvent = false;
      this.buffered.length = 0;
    }
    this.vad.reset();
    if (!this.shut) this.setState("listening");
  }

  private captionAssistant(final: boolean): void {
    if (!this.assistantText && !final) return;
    this.beginTurnIds();
    const now = voiceWiring().clock.now();
    if (!final && this.lastCaptionAt !== 0 && now - this.lastCaptionAt < CAPTION_MIN_GAP_MS) return;
    this.lastCaptionAt = now;
    this.send({
      type: "caption",
      role: "assistant",
      id: this.assistantId,
      text: this.assistantText,
      final,
    });
  }

  private beginTurnIds(): void {
    if (this.idsReady) return;
    this.turn += 1;
    this.assistantId = `a${this.turn}`;
    this.userCaptionId = `u${this.turn}`;
    this.ackId = `ack${this.turn}`;
    this.idsReady = true;
  }

  private resetTurn(): void {
    this.utterance = null;
    this.rolling = Buffer.alloc(0);
    this.heardSpeech = false;
    this.released = false;
    this.forceRelease = false;
    this.replyLive = false;
    this.replyMustAnswer = false;
    this.sawEvent = false;
    this.heldForWait = false;
    this.diverted = false;
    this.pendingAnswer = null;
    this.asked = false;
    this.buffered.length = 0;
    this.assistantText = "";
    this.userText = null;
    this.idsReady = false;
    this.lastCaptionAt = 0;
    this.talkerStartedAt = null;
    this.talkerFirstAudioAt = null;
    this.firstForwardedAt = null;
    this.forwardedAudioBytes = 0;
    this.ackBytes = 0;
    this.pendingUsage = null;
    this.replyFinished = false;
    this.saved = false;
    this.playbackElapsed = false;
    this.speechEndToFirstAudioMs = null;
    this.transcribeMs = null;
    this.transcribeStarted = false;
    this.overlapActive = false;
    this.overlapPcm = Buffer.alloc(0);
    this.overlapStartMs = null;
    this.judging = false;
    this.recent = Buffer.alloc(0);
    this.playbackCancel?.();
    this.playbackCancel = null;
    this.bargeCancel?.();
    this.bargeCancel = null;
  }

  private setState(value: VoiceState): void {
    if (this.state === value) return;
    this.state = value;
    this.send({ type: "state", value });
  }

  private noteActivity(): void {
    this.idleCancel?.();
    this.idleCancel = voiceWiring().clock.after(VOICE_LIMITS.idleMs, () => {
      if (!this.shut) this.requestEnd("idle");
    });
  }

  private send(frame: VoiceHostFrame, allowWhenShut = false): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (!allowWhenShut && this.shut) return;
    if (outboundBacklogTooHigh(this.ws.bufferedAmount)) {
      if (!this.shut) this.requestEnd("dropped");
      return;
    }
    this.ws.send(JSON.stringify(frame));
  }
}
