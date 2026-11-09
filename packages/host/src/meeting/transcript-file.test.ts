/**
 * Meeting mode — reading a transcript from a file the owner already has. Everything is local; the Word and
 * PDF fixtures are built in-process from the libraries the host already depends on.
 */
import { describe, expect, it } from "vitest";
import { Document, Packer, Paragraph } from "docx";
import { buildGarbagePdf, buildTextPdf } from "@agentforge/core/pdf/test-fixtures";
import { TRANSCRIPT_MAX_CHARS } from "@agentforge/core/meeting";
import type { HostFile } from "../types";
import { scannedPdfFixture } from "../file-extract/test-fixtures";
import { readTranscriptFile } from "./transcript-file";

const encode = (text: string) => new TextEncoder().encode(text);

function file(filename: string, bytes: Uint8Array, mime = "application/octet-stream"): HostFile {
  return { field: "file", filename, mime, bytes };
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; status: number; message: string }> {
  try {
    await promise;
  } catch (error) {
    const { code, status, message } = error as { code: string; status: number; message: string };
    return { code, status, message };
  }
  throw new Error("expected the file to be refused");
}

const TALK = ["Dewi: we ship the checkout fix on Friday 14 March.", "Budi: I will update the runbook before 3 pm."];

describe("readTranscriptFile: text", () => {
  it("reads UTF-8 text and Markdown, trims it and tidies the line endings", async () => {
    const result = await readTranscriptFile(file("talk.txt", encode(`\r\n${TALK.join("\r\n")}\r\n\r\n`)), "en");
    expect(result).toEqual({ text: TALK.join("\n"), segments: [] });
    expect((await readTranscriptFile(file("talk.md", encode(`# Weekly\n\n${TALK[0]}`)), "en")).text).toContain(TALK[0]);
  });

  it("drops a UTF-8 byte order mark", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encode(TALK[0] as string)]);
    expect((await readTranscriptFile(file("talk.txt", bytes), "en")).text).toBe(TALK[0]);
  });

  it("reads UTF-16 with a byte order mark, as Windows notepad writes it", async () => {
    const text = TALK[0] as string;
    const little = new Uint8Array(2 + text.length * 2);
    little.set([0xff, 0xfe]);
    for (let index = 0; index < text.length; index += 1) {
      little[2 + index * 2] = text.charCodeAt(index);
    }
    expect((await readTranscriptFile(file("talk.txt", little), "en")).text).toBe(text);
  });

  it("refuses bytes that are not text, in the desk language", async () => {
    const bytes = new Uint8Array([0x80, 0x81, 0xfe, 0x82]);
    const english = await refusal(readTranscriptFile(file("talk.txt", bytes), "en"));
    expect(english).toMatchObject({ code: "invalid_request", status: 400 });
    expect(english.message).toBe("That text file is not UTF-8. Save it as UTF-8 and try again.");
    const indonesian = await refusal(readTranscriptFile(file("talk.txt", bytes), "id"));
    expect(indonesian.message).toBe("File teks itu bukan UTF-8. Simpan sebagai UTF-8 lalu coba lagi.");
  });

  it("refuses a file with no text in it, and an empty file", async () => {
    expect(await refusal(readTranscriptFile(file("talk.txt", encode("  \n\n  ")), "en"))).toMatchObject({
      status: 400,
      message: "No text could be read from that file.",
    });
    expect(await refusal(readTranscriptFile(file("talk.txt", new Uint8Array()), "en"))).toMatchObject({
      status: 400,
      message: "That file is empty.",
    });
  });

  it("caps a transcript at the character limit, and refuses a file too big to decode", async () => {
    const over = await refusal(
      readTranscriptFile(file("talk.txt", encode("a".repeat(TRANSCRIPT_MAX_CHARS + 1))), "en"),
    );
    expect(over).toMatchObject({ code: "invalid_request", status: 413 });
    expect(over.message).toContain(String(TRANSCRIPT_MAX_CHARS));
    const exactly = await readTranscriptFile(file("talk.txt", encode("a".repeat(TRANSCRIPT_MAX_CHARS))), "en");
    expect(exactly.text).toHaveLength(TRANSCRIPT_MAX_CHARS);
    const huge = await refusal(
      readTranscriptFile(file("talk.txt", new Uint8Array(TRANSCRIPT_MAX_CHARS * 4 + 1)), "id"),
    );
    expect(huge).toMatchObject({ status: 413 });
    expect(huge.message).toBe(`Transkrip itu terlalu panjang. Transkrip dibatasi ${TRANSCRIPT_MAX_CHARS} karakter.`);
  });
});

describe("readTranscriptFile: captions", () => {
  it("reads WebVTT into timed segments and the text a minutes writer reads", async () => {
    const vtt =
      "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Dewi>We ship the checkout fix on Friday.</v>\n\n00:00:05.000 --> 00:00:07.000\nBudi: I will update the runbook.\n";
    const result = await readTranscriptFile(file("zoom.vtt", encode(vtt), "text/vtt"), "en");
    expect(result.text).toBe("Dewi: We ship the checkout fix on Friday.\nBudi: I will update the runbook.");
    expect(result.segments).toEqual([
      { startSeconds: 1, speaker: "Dewi", text: "We ship the checkout fix on Friday." },
      { startSeconds: 5, speaker: "", text: "Budi: I will update the runbook." },
    ]);
  });

  it("reads SRT", async () => {
    const srt =
      "1\n00:00:01,000 --> 00:00:03,000\nHello everyone.\n\n2\n00:00:03,500 --> 00:00:05,000\nLet us begin.\n";
    const result = await readTranscriptFile(file("meet.SRT", encode(srt)), "en");
    expect(result.text).toBe("Hello everyone.\nLet us begin.");
    expect(result.segments.map((segment) => segment.startSeconds)).toEqual([1, 3.5]);
  });

  it("refuses a caption file with no cues", async () => {
    const result = await refusal(readTranscriptFile(file("empty.vtt", encode("WEBVTT\n\n")), "en"));
    expect(result).toMatchObject({ status: 400, message: "No text could be read from that file." });
  });
});

describe("readTranscriptFile: Word and PDF", () => {
  it("reads a Word transcript", async () => {
    const doc = new Document({ sections: [{ children: TALK.map((line) => new Paragraph(line)) }] });
    const bytes = new Uint8Array(await Packer.toBuffer(doc));
    const result = await readTranscriptFile(file("talk.docx", bytes), "en");
    expect(result.text).toContain("Dewi: we ship the checkout fix on Friday 14 March.");
    expect(result.text).toContain("Budi: I will update the runbook before 3 pm.");
    expect(result.segments).toEqual([]);
  });

  it("reads a PDF transcript", async () => {
    const result = await readTranscriptFile(file("talk.pdf", buildTextPdf([TALK.join(" ")])), "en");
    expect(result.text).toContain("we ship the checkout fix on Friday 14 March");
  });

  it("refuses a scanned PDF as needing OCR, says nothing left the machine, and does so in Indonesian too", async () => {
    const english = await refusal(readTranscriptFile(file("scan.pdf", scannedPdfFixture()), "en"));
    expect(english).toMatchObject({ code: "needs_ocr", status: 400 });
    expect(english.message).toContain("nothing was sent anywhere");
    const indonesian = await refusal(readTranscriptFile(file("scan.pdf", scannedPdfFixture()), "id"));
    expect(indonesian.message).toContain("tidak ada yang dikirim ke mana pun");
  });

  it("refuses a file whose name lies about what it is, and a damaged PDF", async () => {
    const liar = await refusal(readTranscriptFile(file("talk.pdf", encode("just some words, not a pdf")), "en"));
    expect(liar.status).toBe(400);
    const damaged = await refusal(readTranscriptFile(file("broken.pdf", buildGarbagePdf()), "en"));
    expect(damaged.status).toBe(400);
  });
});

describe("readTranscriptFile: what is refused before reading", () => {
  it("refuses a missing file and a file type that is not a transcript", async () => {
    expect(await refusal(readTranscriptFile(undefined, "en"))).toMatchObject({ code: "invalid_request", status: 400 });
    const mp3 = await refusal(readTranscriptFile(file("talk.mp3", new Uint8Array([1, 2, 3])), "en"));
    expect(mp3).toMatchObject({ code: "unsupported_content_type", status: 400 });
    expect(mp3.message).toBe("That file type is not a transcript. Use .txt, .md, .vtt, .srt, .docx or .pdf.");
    expect((await refusal(readTranscriptFile(file("talk.mp3", new Uint8Array([1])), "id"))).message).toBe(
      "Jenis file itu bukan transkrip. Gunakan .txt, .md, .vtt, .srt, .docx, atau .pdf.",
    );
  });
});
