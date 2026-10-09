/**
 * What the Meeting desk does with a file that is dropped on it, before any request is made.
 *
 * A drop is free: it creates the meeting and uploads the file, and nothing is paid until the owner presses
 * Run. These are the pure decisions: which route a file goes to, what the meeting is called, and what
 * `prompt` the run carries.
 */
import { describe, expect, it } from "vitest";
import {
  MEETING_FILE_ACCEPT,
  MEETING_TITLE_MAX,
  classifyMeetingFile,
  promptForRun,
  titleFromFileName,
  titleFromTranscript,
  wordCount,
} from "./meeting-intake";

const file = (name: string, type = "") => ({ name, type });

describe("classifyMeetingFile", () => {
  it("sends a transcript file to the transcript route, by its name alone", () => {
    for (const name of ["notes.txt", "minutes.md", "call.vtt", "call.srt", "Weekly.docx", "weekly.pdf", "NOTES.TXT"]) {
      expect(classifyMeetingFile(file(name)), name).toBe("transcript");
    }
  });

  it("does not let a transcript's mime type decide: a .pdf is a transcript, an .mp4 a recording", () => {
    expect(classifyMeetingFile(file("weekly.pdf", "application/pdf"))).toBe("transcript");
    expect(classifyMeetingFile(file("weekly.mp4", "video/mp4"))).toBe("recording");
  });

  it("sends audio and video to the recording route, by mime or by a media extension", () => {
    expect(classifyMeetingFile(file("call", "audio/mpeg"))).toBe("recording");
    expect(classifyMeetingFile(file("call", "video/webm"))).toBe("recording");
    expect(classifyMeetingFile(file("call.m4a"))).toBe("recording");
    expect(classifyMeetingFile(file("call.WAV"))).toBe("recording");
  });

  it("refuses what is neither, so the owner is told before anything is sent", () => {
    expect(classifyMeetingFile(file("slides.pptx", "application/vnd.ms-powerpoint"))).toBe("unsupported");
    expect(classifyMeetingFile(file("photo.png", "image/png"))).toBe("unsupported");
    expect(classifyMeetingFile(file("noextension"))).toBe("unsupported");
  });
});

describe("MEETING_FILE_ACCEPT", () => {
  it("lets the file picker offer a recording and every transcript type", () => {
    const parts = MEETING_FILE_ACCEPT.split(",");
    expect(parts).toContain("audio/*");
    expect(parts).toContain("video/*");
    for (const extension of [".txt", ".md", ".vtt", ".srt", ".docx", ".pdf"]) {
      expect(parts, extension).toContain(extension);
    }
  });
});

describe("titleFromFileName", () => {
  it("is the file's stem", () => {
    expect(titleFromFileName("Checkout weekly.mp3", "Meeting")).toBe("Checkout weekly");
    expect(titleFromFileName("notes.v2.txt", "Meeting")).toBe("notes.v2");
  });

  it("drops a folder from a path", () => {
    expect(titleFromFileName("C:\\Users\\rina\\Calls\\sync.m4a", "Meeting")).toBe("sync");
    expect(titleFromFileName("calls/sync.m4a", "Meeting")).toBe("sync");
  });

  it("falls back when there is no stem", () => {
    expect(titleFromFileName(".txt", "Meeting")).toBe("Meeting");
    expect(titleFromFileName("   ", "Meeting")).toBe("Meeting");
  });

  it("stays inside the host's title length", () => {
    expect(titleFromFileName(`${"a".repeat(500)}.mp3`, "Meeting").length).toBe(MEETING_TITLE_MAX);
  });
});

describe("titleFromTranscript", () => {
  it("is the first line that says something, cut short", () => {
    expect(titleFromTranscript("\n\n  Rina: let's start.\nBudi: ok", "Meeting")).toBe("Rina: let's start.");
    expect(titleFromTranscript(`${"word ".repeat(60)}`, "Meeting").length).toBeLessThanOrEqual(MEETING_TITLE_MAX);
  });

  it("falls back on an empty transcript", () => {
    expect(titleFromTranscript("  \n ", "Meeting")).toBe("Meeting");
  });
});

describe("promptForRun", () => {
  it("is absent when the owner typed nothing, so every mode runs its default", () => {
    expect(promptForRun("")).toBeUndefined();
    expect(promptForRun("   \n")).toBeUndefined();
  });

  it("is the trimmed words otherwise", () => {
    expect(promptForRun("  Minutes and who does what ")).toBe("Minutes and who does what");
  });

  it("is cut to the length the host accepts", () => {
    expect(promptForRun("x".repeat(5000))?.length).toBe(2000);
  });
});

describe("wordCount", () => {
  it("counts words, not characters or lines", () => {
    expect(wordCount("Rina: we ship on Friday.\nBudi: ok")).toBe(7);
    expect(wordCount("  \n ")).toBe(0);
    expect(wordCount("")).toBe(0);
  });
});
