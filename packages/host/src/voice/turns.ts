/**
 * Turn-taking rules the host applies on top of the gateway's own speech detection (plan W2, W4).
 * Lane D owns this file. The signatures are the contract the relay codes against.
 */

/** After the gateway reports silence: answer now, or wait for more words. */
export type TurnEndVerdict = "finished" | "wait";

/** While the agent speaks and the person talks over it: carry on, or stop and cut. */
export type BargeInVerdict = "backchannel" | "interrupt";

export const TURN_TIMING = {
  /** How long the host waits for more speech after a transcript it judged unfinished. */
  waitAfterUnfinishedMs: 1_200,
  /** Silence after which a turn ends whatever the words say. */
  maxSilenceMs: 2_500,
} as const;

/** Word rules over the final transcript of one utterance, Indonesian and English. */
export function judgeTurnEnd(transcript: string): TurnEndVerdict {
  return transcript.trim() ? "finished" : "wait";
}

/** Word rules over what the person said over the agent. */
export function judgeBargeIn(transcript: string): BargeInVerdict {
  return transcript.trim() ? "interrupt" : "backchannel";
}
