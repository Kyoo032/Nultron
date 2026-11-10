/**
 * The talker: the speech model that hears the person and speaks back (plan W2, W3). The relay codes
 * against this file only. Week one's talker is HTTP speech-to-speech (`talker-omni-http.ts`), because
 * the gateway refuses realtime sockets for this account. A realtime socket can replace it behind the
 * same shape. The relay lane owns this file; it is frozen once two lanes build on it.
 */
import type { VoiceLocale } from "./turns";

/** 16-bit little-endian PCM, mono, 24 kHz, whole samples: the bytes the browser sends and plays. */
export type Pcm = Buffer;

export type TalkerUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** The part of `inputTokens` that was audio. */
  readonly inputAudioTokens: number;
  /** The part of `outputTokens` that was audio. */
  readonly outputAudioTokens: number;
};

/** What one reply yields, in order. It ends with exactly one `done`, unless it was aborted or threw. */
export type TalkerEvent =
  /** The agent's voice. */
  | { readonly type: "audio"; readonly pcm: Pcm }
  /** The words of the agent's voice as they are made. Joined, they are the reply's text. */
  | { readonly type: "text"; readonly delta: string }
  /** The talker wants the desk: run `askNultron` with this question, then call `answer`. No audio comes with it. */
  | { readonly type: "ask"; readonly callId: string; readonly question: string }
  /** The talker judged the person's sentence unfinished: keep listening and say nothing. */
  | { readonly type: "wait" }
  /** What this reply cost. Absent when the reply was aborted. */
  | { readonly type: "usage"; readonly usage: TalkerUsage }
  | { readonly type: "done" };

export type TalkerTurn = { readonly role: "user" | "assistant"; readonly text: string };

export type TalkerReplyOptions = {
  /** Aborting cuts the stream at once. No event is yielded after it, and nothing is thrown. */
  readonly signal: AbortSignal;
  /** The host will not wait any longer: the talker must speak or ask, never `wait`. */
  readonly mustAnswer?: boolean;
};

/** Why a reply failed. `unavailable`: the model or the gateway did not answer. `refused`: the gateway said no (key, quota). */
export type TalkerErrorCode = "unavailable" | "refused" | "failed";

/** Thrown while iterating `reply` or `answer` when the gateway fails. Never carries the key or audio. */
export class TalkerError extends Error {
  readonly code: TalkerErrorCode;
  constructor(code: TalkerErrorCode, message: string) {
    super(message);
    this.name = "TalkerError";
    this.code = code;
  }
}

/** One voice session's talker. The relay runs one reply at a time. */
export interface TalkerSession {
  /** Answers one finished utterance. */
  reply(utterance: Pcm, options: TalkerReplyOptions): AsyncIterable<TalkerEvent>;
  /** The second leg of an `ask`: speaks the desk's result. `text` is what `askNultron` returned. */
  answer(callId: string, text: string, options: TalkerReplyOptions): AsyncIterable<TalkerEvent>;
  /**
   * Records how the last exchange ended, so the next reply has the right history: the person's words
   * (null when there is no transcript) and what they heard of the agent's reply.
   */
  remember(turn: { readonly user: string | null; readonly assistant: string; readonly interrupted: boolean }): void;
  /** Quick, rough words for a short stretch of speech over the agent. Null when it cannot tell. Never throws. */
  hearShort(speech: Pcm, signal: AbortSignal): Promise<string | null>;
  /** The fixed acknowledgement ("Sebentar, saya cek dulu.") as ready audio, or null while none is cached. */
  acknowledgement(): { readonly pcm: Pcm; readonly text: string } | null;
  close(): void;
}

export type TalkerSessionOptions = {
  readonly locale: VoiceLocale;
  /** The last turns of the thread, oldest first, so a new session carries on from the text. */
  readonly history: readonly TalkerTurn[];
};

export interface Talker {
  readonly model: string;
  open(options: TalkerSessionOptions): TalkerSession;
}

/** Accurate words for one utterance, for the caption and the saved turn. Off the reply's critical path. */
export interface Transcriber {
  /** Null when it failed or heard no words. Never throws. `seconds` is the audio length billed. */
  transcribe(
    utterance: Pcm,
    options: { readonly locale: VoiceLocale; readonly signal: AbortSignal },
  ): Promise<{ readonly text: string; readonly seconds: number } | null>;
}
