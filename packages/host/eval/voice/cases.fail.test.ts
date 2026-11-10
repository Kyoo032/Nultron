/**
 * Each case against a fake host that gets exactly that thing wrong: it must fail, and for the reason the case
 * exists. `cases.pass.test.ts` is the other half: the same cases pass on a correct host.
 */
import { describe, expect, it } from "vitest";
import type { FakeBehavior } from "./fake-host";
import { failedChecks, runAgainst } from "./test-helpers";

const WRONG: ReadonlyArray<{ id: string; wrong: Partial<FakeBehavior>; why: string; failsOn: string }> = [
  { id: "latency-smalltalk", wrong: { extraReplyDelayMs: 2_500 }, why: "first audio 2.5 s late", failsOn: "p50 first audio <= 1500 ms" },
  { id: "latency-fact", wrong: { extraReplyDelayMs: 2_500 }, why: "acknowledgement 2.5 s late", failsOn: "p50 first audio <= 1500 ms" },
  { id: "latency-long", wrong: { extraReplyDelayMs: 2_500 }, why: "first audio 2.5 s late", failsOn: "p50 first audio <= 1500 ms" },
  { id: "fact-routes-to-desk", wrong: { factWithoutAck: true }, why: "a fact answered at once", failsOn: "state thinking" },
  { id: "task-becomes-card", wrong: { taskAsSpeech: true }, why: "a task answered aloud, a write saved", failsOn: "a card frame" },
  { id: "unfinished-waits", wrong: { answersUnfinished: true }, why: "the unfinished clip answered", failsOn: "no agent audio for 2000 ms" },
  { id: "pause-mid-sentence", wrong: { answersUnfinished: true }, why: "a reply in the pause", failsOn: "no reply during the pause or the second part" },
  { id: "barge-in-stops", wrong: { ignoresBargeIn: true }, why: "no stop_audio", failsOn: "stop_audio within 300 ms of the 700 ms line" },
  { id: "backchannel-resumes", wrong: { stopsOnBackchannel: true }, why: "an 'iya' cuts the reply", failsOn: "no stop_audio for a backchannel" },
  { id: "push-to-talk", wrong: { pushToTalkAutoEnds: true }, why: "a reply with no commit", failsOn: "no reply and no thinking for 3500 ms of silence without commit" },
  { id: "turns-saved", wrong: { neverSaves: true }, why: "no saved frame, nothing in the thread", failsOn: "the saved frame" },
  { id: "second-session-replaces", wrong: { neverReplaces: true }, why: "the second session is refused", failsOn: "the second H1 is accepted" },
  { id: "upgrade-needs-origin", wrong: { acceptsWithoutOrigin: true }, why: "the upgrade accepted with no Origin", failsOn: "a handshake with no Origin is refused" },
  { id: "end-is-idempotent", wrong: { endsOnceOnly: true }, why: "a second end answers 404", failsOn: "the second end answers 200" },
];

describe("every case fails on a host that gets it wrong", () => {
  for (const { id, wrong, why, failsOn } of WRONG) {
    it(`${id}: ${why}`, async () => {
      const { rows } = await runAgainst(wrong, [id]);
      const row = rows[0];
      expect(row?.status).toBe("FAIL");
      expect(failedChecks(row).join("\n")).toContain(failsOn);
    });
  }

  it("covers every case", () => {
    expect(new Set(WRONG.map((item) => item.id)).size).toBe(14);
  });
});
