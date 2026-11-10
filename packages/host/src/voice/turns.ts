/**
 * Turn-taking rules (plan W2, W4). The host has no gateway speech detection now: it finds speech
 * and silence itself (`vad.ts`) and applies these rules on top of that. Lane D owns this file. The
 * signatures are the contract the relay codes against; the bodies below are small deterministic
 * defaults a later worker replaces.
 */

export type VoiceLocale = "en" | "id";

/** After silence: answer now, or wait for more words. */
export type TurnEndVerdict = "finished" | "wait";

/** While the agent speaks and the person talks over it: carry on, or stop and cut. */
export type BargeInVerdict = "backchannel" | "interrupt";

export const TURN_TIMING = {
  /** Silence after speech at which the host sends the utterance to the talker, before the turn is confirmed. */
  earlySendMs: 300,
  /** Silence after which a turn is confirmed finished, unless the words say otherwise. */
  endSilenceMs: 700,
  /** Extra wait for more speech after a transcript judged unfinished. */
  waitAfterUnfinishedMs: 1_200,
  /** Silence after which a turn ends whatever the words say. */
  maxSilenceMs: 2_500,
  /** Speech over the agent longer than this is an interruption without reading the words. */
  interruptAfterMs: 700,
  /** How long the host waits for `played` after `stop_audio` before it trims with what it has. */
  playedWaitMs: 300,
} as const;

/** Word rules over the transcript of one utterance. */
export function judgeTurnEnd(transcript: string, _locale: VoiceLocale): TurnEndVerdict {
  return transcript.trim() ? "finished" : "wait";
}

/** Rules over what the person said over the agent. `transcript` is null while no transcript exists. */
export function judgeBargeIn(input: {
  readonly transcript: string | null;
  readonly speechMs: number;
  readonly locale: VoiceLocale;
}): BargeInVerdict {
  if (input.speechMs >= TURN_TIMING.interruptAfterMs) {
    return "interrupt";
  }
  const words = input.transcript?.trim().split(/\s+/).filter(Boolean).length ?? 0;
  return words > 2 ? "interrupt" : "backchannel";
}

/** The part of a reply the person heard, cut at a word boundary, by the share of its audio that played. */
export function trimToHeard(input: {
  readonly text: string;
  readonly playedMs: number;
  readonly totalMs: number;
}): { readonly text: string; readonly interrupted: boolean } {
  const { text, playedMs, totalMs } = input;
  if (!(playedMs < totalMs)) {
    return { text, interrupted: false };
  }
  const share = totalMs > 0 ? Math.max(0, playedMs) / totalMs : 0;
  let end = Math.floor(text.length * share);
  // A cut inside a word backs up to where that word began, so the person never "heard" half a word.
  if (end < text.length && !/\s/.test(text[end] ?? "")) {
    while (end > 0 && !/\s/.test(text[end - 1] ?? "")) {
      end -= 1;
    }
  }
  return { text: text.slice(0, end).trimEnd(), interrupted: true };
}
