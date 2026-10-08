import { z } from "zod";

export const transcriptSegmentSchema = z.object({
  /** Offset from the start of the recording, in seconds. Absent when the backend gave no timings. */
  startSeconds: z.number().nonnegative().optional(),
  /** As the transcript labelled the voice, when it labelled one at all. */
  speaker: z.string().default(""),
  text: z.string().min(1),
});

export const meetingTranscriptSchema = z.object({
  text: z.string().default(""),
  segments: z.array(transcriptSegmentSchema).default([]),
  /** BCP-47-ish hint the caller passed to the backend, e.g. "en" or "id". Empty means auto. */
  language: z.string().default(""),
  /** How the text was produced, so the UI can say "typed" rather than imply a machine heard it. */
  source: z.enum(["gateway", "pasted"]).default("pasted"),
  model: z.string().default(""),
});

export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;
export type MeetingTranscript = z.infer<typeof meetingTranscriptSchema>;

export const TRANSCRIPT_MAX_CHARS = 600_000;

function stamp(seconds: number): string {
  const whole = Math.floor(seconds);
  const hh = Math.floor(whole / 3600);
  const mm = Math.floor((whole % 3600) / 60);
  const ss = whole % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

export function transcriptSegmentLine(segment: TranscriptSegment): string {
  const time = segment.startSeconds === undefined ? "" : `[${stamp(segment.startSeconds)}] `;
  const speaker = segment.speaker.trim() ? `**${segment.speaker.trim()}:** ` : "";
  return `${time}${speaker}${segment.text.trim()}`;
}

export function meetingTranscriptToMarkdown(transcript: MeetingTranscript, title: string): string {
  const body =
    transcript.segments.length > 0
      ? transcript.segments.map(transcriptSegmentLine).join("\n\n")
      : transcript.text.trim();
  return `${[`# ${title}`, "", body].join("\n").trim()}\n`;
}

/** The plain text a minutes writer or a guard reads, whichever shape the transcript arrived in. */
export function transcriptPlainText(transcript: MeetingTranscript): string {
  if (transcript.text.trim()) {
    return transcript.text.trim();
  }
  return transcript.segments
    .map((segment) => (segment.speaker.trim() ? `${segment.speaker.trim()}: ${segment.text}` : segment.text))
    .join("\n")
    .trim();
}

// -- transcript files --------------------------------------------------------------------------------

/** The files a transcript can be read from, in the order the file picker lists them. */
export const TRANSCRIPT_FILE_EXTENSIONS = [".txt", ".md", ".vtt", ".srt", ".docx", ".pdf"] as const;

export type TranscriptFileKind = "text" | "captions" | "document";

const KIND_BY_EXTENSION: Readonly<Record<string, TranscriptFileKind>> = {
  txt: "text",
  md: "text",
  vtt: "captions",
  srt: "captions",
  docx: "document",
  pdf: "document",
};

/** How a transcript file is read, from its name alone (the last extension, in any case); null when it is not one. */
export function transcriptFileKind(filename: string): TranscriptFileKind | null {
  const name = filename.trim().split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot === -1) {
    return null;
  }
  return KIND_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

const CAPTION_TIMING = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->/;
const CAPTION_BLOCK_SKIP = /^(?:NOTE|STYLE|REGION)(?:\s|$)/;
const BLOCK_BREAK = /\n[ \t]*\n/;
const STYLING_BRACES = /\{\\[^}]*\}/g;
const VOICE_TAG = /<v(?:\.[^\s>]*)?\s+([^>]+)>/;
const ANY_TAG = /<[^>]*>/g;
const ENTITY = /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|lrm|rlm);/gi;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  lrm: "",
  rlm: "",
};

function decodeEntity(match: string, body: string): string {
  const key = body.toLowerCase();
  if (key.startsWith("#x")) {
    return safeCodePoint(Number.parseInt(key.slice(2), 16), match);
  }
  if (key.startsWith("#")) {
    return safeCodePoint(Number.parseInt(key.slice(1), 10), match);
  }
  return NAMED_ENTITIES[key] ?? match;
}

function safeCodePoint(code: number, fallback: string): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
}

function captionSeconds(match: RegExpMatchArray): number {
  const [, hours = "0", minutes = "0", seconds = "0", fraction = "0"] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(fraction) / 10 ** fraction.length;
}

type Cue = { readonly start: number; readonly speaker: string; readonly text: string };

function cueOf(block: string): Cue | null {
  const lines = block.split("\n");
  if (CAPTION_BLOCK_SKIP.test(lines[0] ?? "")) {
    return null;
  }
  const at = lines.findIndex((line) => CAPTION_TIMING.test(line));
  if (at === -1) {
    return null;
  }
  const timing = (lines[at] ?? "").match(CAPTION_TIMING);
  if (!timing) {
    return null;
  }
  const payload = lines
    .slice(at + 1)
    .join(" ")
    .replace(STYLING_BRACES, " ");
  const speaker = payload.match(VOICE_TAG)?.[1]?.trim() ?? "";
  const text = payload.replace(ANY_TAG, "").replace(ENTITY, decodeEntity).replace(/\s+/g, " ").trim();
  return text === "" ? null : { start: captionSeconds(timing), speaker, text };
}

/**
 * A WebVTT or SRT file as a transcript: one segment per cue with its start time, and the text a minutes
 * writer reads, one cue per line as "Speaker: words" (a `<v Name>` voice tag is the speaker; a "Name:" the
 * speakers' tool already wrote stays in the words). Cue markup, styling and entities are removed, notes and
 * styles are skipped, and a cue that only repeats the one before it is dropped. A file with no cues gives
 * an empty transcript. Pure; the format is told from the cue timings, so neither is named.
 */
export function transcriptFromCaptions(raw: string): { text: string; segments: TranscriptSegment[] } {
  const normalised = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const segments: TranscriptSegment[] = [];
  for (const block of normalised.split(BLOCK_BREAK)) {
    const cue = cueOf(block.trim());
    const previous = segments[segments.length - 1];
    if (!cue || (previous && previous.text === cue.text && previous.speaker === cue.speaker)) {
      continue;
    }
    segments.push({ startSeconds: cue.start, speaker: cue.speaker, text: cue.text });
  }
  const text = segments
    .map((segment) => (segment.speaker ? `${segment.speaker}: ${segment.text}` : segment.text))
    .join("\n");
  return { text, segments };
}
