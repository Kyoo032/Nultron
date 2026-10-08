import { describe, expect, it } from "vitest";
import {
  meetingTranscriptSchema,
  transcriptFileKind,
  transcriptFromCaptions,
  transcriptPlainText,
  TRANSCRIPT_FILE_EXTENSIONS,
} from "./transcript";

const VTT = [
  "WEBVTT - Weekly",
  "",
  "NOTE this is a comment",
  "that runs two lines",
  "",
  "STYLE",
  "::cue { color: red }",
  "",
  "1",
  "00:00:01.000 --> 00:00:04.000",
  "<v Rina>We ship the checkout fix on Friday.</v>",
  "",
  "00:00:04.500 --> 00:00:08.000 align:start position:10%",
  "Sam: I will write the design document.",
  "It is due before <c.yellow>Friday</c>.",
  "",
  "00:01:00.000 --> 00:01:02.000",
  "&amp; that is &lt;all&gt;&nbsp;now",
  "",
].join("\n");

const SRT = [
  "1",
  "00:00:01,000 --> 00:00:04,000",
  "Hello there, everyone.",
  "",
  "2",
  "00:00:04,500 --> 00:00:08,000",
  "<i>Let us begin.</i>",
  "{\\an8}Top line",
  "",
  "3",
  "01:02:03,500 --> 01:02:05,000",
  "Much later.",
  "",
].join("\n");

describe("transcriptFromCaptions", () => {
  it("reads WebVTT cues: timings, voice tags, markup, entities, and skips notes and styles", () => {
    const result = transcriptFromCaptions(VTT);
    expect(result.segments).toEqual([
      { startSeconds: 1, speaker: "Rina", text: "We ship the checkout fix on Friday." },
      { startSeconds: 4.5, speaker: "", text: "Sam: I will write the design document. It is due before Friday." },
      { startSeconds: 60, speaker: "", text: "& that is <all> now" },
    ]);
    expect(result.text).toBe(
      [
        "Rina: We ship the checkout fix on Friday.",
        "Sam: I will write the design document. It is due before Friday.",
        "& that is <all> now",
      ].join("\n"),
    );
  });

  it("reads SRT cues, including the hour field and styling tags", () => {
    const result = transcriptFromCaptions(SRT);
    expect(result.segments).toEqual([
      { startSeconds: 1, speaker: "", text: "Hello there, everyone." },
      { startSeconds: 4.5, speaker: "", text: "Let us begin. Top line" },
      { startSeconds: 3723.5, speaker: "", text: "Much later." },
    ]);
  });

  it("reads WebVTT and SRT without being told which", () => {
    expect(transcriptFromCaptions(VTT).segments).toHaveLength(3);
    expect(transcriptFromCaptions(SRT).segments).toHaveLength(3);
  });

  it("reads a VTT that leaves out the hour field", () => {
    const result = transcriptFromCaptions("WEBVTT\n\n01:05.250 --> 01:08.000\nShort stamp.\n");
    expect(result.segments).toEqual([{ startSeconds: 65.25, speaker: "", text: "Short stamp." }]);
  });

  it("copes with a byte order mark and Windows line endings", () => {
    const result = transcriptFromCaptions(`\uFEFF${SRT.replace(/\n/g, "\r\n")}`);
    expect(result.segments.map((segment) => segment.text)).toEqual([
      "Hello there, everyone.",
      "Let us begin. Top line",
      "Much later.",
    ]);
  });

  it("drops a cue that only repeats the one before it", () => {
    const repeated =
      "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nSame words.\n\n00:00:02.000 --> 00:00:03.000\nSame words.\n";
    expect(transcriptFromCaptions(repeated).segments).toHaveLength(1);
  });

  it("gives nothing for a file with no cues", () => {
    expect(transcriptFromCaptions("WEBVTT\n\n")).toEqual({ text: "", segments: [] });
    expect(transcriptFromCaptions("")).toEqual({ text: "", segments: [] });
    expect(transcriptFromCaptions("just some words\nwith no timings")).toEqual({ text: "", segments: [] });
  });

  it("makes something the transcript schema and the minutes writer both read", () => {
    const result = transcriptFromCaptions(VTT);
    const transcript = meetingTranscriptSchema.parse({ ...result, source: "pasted" });
    expect(transcriptPlainText(transcript)).toContain("Rina: We ship the checkout fix on Friday.");
  });
});

describe("transcriptFileKind", () => {
  it("names the way each accepted extension is read, in any case", () => {
    expect(transcriptFileKind("talk.txt")).toBe("text");
    expect(transcriptFileKind("talk.MD")).toBe("text");
    expect(transcriptFileKind("zoom.vtt")).toBe("captions");
    expect(transcriptFileKind("meet.SRT")).toBe("captions");
    expect(transcriptFileKind("notes.docx")).toBe("document");
    expect(transcriptFileKind("notes.pdf")).toBe("document");
  });

  it("refuses the rest, including a name with no extension and a double extension that ends wrong", () => {
    for (const name of ["talk.mp3", "talk", "talk.txt.exe", "talk.", ".txt.bak", "talk.doc"]) {
      expect(transcriptFileKind(name), name).toBeNull();
    }
    expect(TRANSCRIPT_FILE_EXTENSIONS).toEqual([".txt", ".md", ".vtt", ".srt", ".docx", ".pdf"]);
  });

  it("looks only at the file name, not at a folder in its path", () => {
    expect(transcriptFileKind("C:\\notes.txt\\talk")).toBeNull();
    expect(transcriptFileKind("C:\\meetings\\talk.vtt")).toBe("captions");
  });
});
