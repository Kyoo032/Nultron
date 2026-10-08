/**
 * What the Meeting desk reads from `GET /api/v1/meetings` (`packages/host/src/meeting/records.ts`).
 *
 * The renderer must not import the host, so the shapes are restated here, narrowed to the fields a
 * component uses. Every field the host added later (`checks`, and on a decision or an action item `quote`,
 * `evidence`, `edited`) is optional: a record saved before it existed still renders.
 */
import type { AppLocale } from "@agentforge/core/locale";
import type { MeetingMinutes, MeetingTranscript } from "@agentforge/core/meeting";
import type { MeetingChecksWire } from "./meeting-checks";

export type MinutesRecord = {
  locale: AppLocale;
  minutes: MeetingMinutes;
  artifactId: string;
  model: string;
  unverifiedNames: string[];
  /** What the checks made of the first-language minutes; null for a translation and for older records. */
  checks?: MeetingChecksWire | null;
};

export type Meeting = {
  id: string;
  title: string;
  locale: AppLocale;
  status: "new" | "recorded" | "transcribed" | "minuted";
  recording: { name: string; bytes: number } | null;
  transcript: MeetingTranscript | null;
  transcriptArtifactId: string;
  minutes: MinutesRecord | null;
  translation: MinutesRecord | null;
};

export type Capability = {
  available: boolean;
  model: string | null;
  reason: "ok" | "no_model" | "no_key";
  ffmpeg: boolean;
};

export type MeetingTab = "transcript" | "minutes" | "translation";
