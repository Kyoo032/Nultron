import { describe, expect, it } from "vitest";
import { CHAT_DOCUMENT_EXTENSIONS, CHAT_DOCUMENT_MAX_BYTES } from "@agentforge/core/chat-documents";
import {
  CHAT_IMAGE_MAX_BYTES,
  CHAT_VIDEO_MAX_BYTES,
  COMPOSER_FILE_ACCEPT,
  attachmentOverCap,
  classifyAttachment,
  isRenderableImageUrl,
  isRenderableVideoUrl,
  pastedFiles,
  routeDecision,
} from "./composer-attach";

describe("classifyAttachment", () => {
  it("classifies image MIME types", () => {
    expect(classifyAttachment({ name: "a.png", type: "image/png" })).toBe("image");
    expect(classifyAttachment({ name: "a.jpg", type: "image/jpeg" })).toBe("image");
    expect(classifyAttachment({ name: "a.webp", type: "image/webp" })).toBe("image");
    expect(classifyAttachment({ name: "a.gif", type: "image/gif" })).toBe("image");
  });

  it("classifies video MIME types", () => {
    expect(classifyAttachment({ name: "a.mp4", type: "video/mp4" })).toBe("video");
    expect(classifyAttachment({ name: "a.webm", type: "video/webm" })).toBe("video");
    expect(classifyAttachment({ name: "a.mov", type: "video/quicktime" })).toBe("video");
  });

  it("classifies text by MIME or extension", () => {
    expect(classifyAttachment({ name: "notes.txt", type: "text/plain" })).toBe("text");
    expect(classifyAttachment({ name: "doc.md", type: "text/markdown" })).toBe("text");
    expect(classifyAttachment({ name: "data.csv", type: "text/csv" })).toBe("text");
    expect(classifyAttachment({ name: "payload.json", type: "application/json" })).toBe("text");
    expect(classifyAttachment({ name: "readme.MD", type: "" })).toBe("text");
    expect(classifyAttachment({ name: "sheet.csv", type: "application/octet-stream" })).toBe("text");
  });

  it("marks unknown types unsupported", () => {
    expect(classifyAttachment({ name: "a.pages", type: "application/vnd.apple.pages" })).toBe("unsupported");
    expect(classifyAttachment({ name: "a.bin", type: "application/octet-stream" })).toBe("unsupported");
  });

  it("refuses images over 10 MB and video over the 26 MB body cap", () => {
    expect(CHAT_IMAGE_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(CHAT_VIDEO_MAX_BYTES).toBe(26 * 1024 * 1024);
    expect(attachmentOverCap("image", CHAT_IMAGE_MAX_BYTES)).toBe(false);
    expect(attachmentOverCap("image", CHAT_IMAGE_MAX_BYTES + 1)).toBe(true);
    expect(attachmentOverCap("video", CHAT_VIDEO_MAX_BYTES)).toBe(false);
    expect(attachmentOverCap("video", 40 * 1024 * 1024)).toBe(true);
    expect(attachmentOverCap("text", 80 * 1024 * 1024)).toBe(false);
    expect(attachmentOverCap("unsupported", 1)).toBe(false);
  });
});

describe("documents", () => {
  it("classifies every format the host reads as a document", () => {
    for (const extension of CHAT_DOCUMENT_EXTENSIONS) {
      expect(classifyAttachment({ name: `file.${extension}`, type: "application/octet-stream" }), extension).toBe(
        "document",
      );
    }
    expect(classifyAttachment({ name: "a.pdf", type: "application/pdf" })).toBe("document");
    expect(classifyAttachment({ name: "Laporan.DOCX", type: "" })).toBe("document");
  });

  it("reads an rtf as a document even though its MIME type says text", () => {
    expect(classifyAttachment({ name: "a.rtf", type: "text/rtf" })).toBe("document");
    expect(classifyAttachment({ name: "a.rtf", type: "application/rtf" })).toBe("document");
  });

  it("keeps csv and plain text on the text route", () => {
    expect(classifyAttachment({ name: "data.csv", type: "text/csv" })).toBe("text");
    expect(classifyAttachment({ name: "notes.txt", type: "text/plain" })).toBe("text");
  });

  it("puts every document extension on the file input accept list", () => {
    const accept = COMPOSER_FILE_ACCEPT.split(",");
    for (const extension of CHAT_DOCUMENT_EXTENSIONS) {
      expect(accept, extension).toContain(`.${extension}`);
    }
    expect(accept).toContain("image/png");
    expect(accept).toContain(".txt");
  });

  it("caps a document at the host reader's byte limit", () => {
    expect(attachmentOverCap("document", CHAT_DOCUMENT_MAX_BYTES)).toBe(false);
    expect(attachmentOverCap("document", CHAT_DOCUMENT_MAX_BYTES + 1)).toBe(true);
  });

  it("sends a document with text and with media like a text file", () => {
    expect(routeDecision(["document"])).toEqual({ route: "text" });
    expect(routeDecision(["document", "text"])).toEqual({ route: "text" });
    expect(routeDecision(["document", "image"])).toEqual({ route: "image" });
  });
});

describe("pastedFiles", () => {
  const file = (name: string, type = "") => ({ name, type }) as File;
  const clipboard = (files: File[], text = "") => ({
    files,
    getData: (kind: string) => (kind === "text/plain" ? text : ""),
  });

  it("returns files pasted on their own, so a pasted file takes the picker's route", () => {
    const pdf = file("a.pdf", "application/pdf");
    expect(pastedFiles(clipboard([pdf]))).toEqual([pdf]);
  });

  it("leaves a paste that carries text alone, so a table copied from a sheet still pastes as text", () => {
    const sheet = ["a", "b"].join("\t");
    expect(pastedFiles(clipboard([file("image.png", "image/png")], sheet))).toEqual([]);
  });

  it("returns nothing for an empty or missing clipboard", () => {
    expect(pastedFiles(clipboard([]))).toEqual([]);
    expect(pastedFiles(null)).toEqual([]);
  });
});

describe("routeDecision", () => {
  it("routes empty or text-only to text", () => {
    expect(routeDecision([])).toEqual({ route: "text" });
    expect(routeDecision(["text"])).toEqual({ route: "text" });
    expect(routeDecision(["text", "text"])).toEqual({ route: "text" });
  });

  it("routes images (with optional text files) to image", () => {
    expect(routeDecision(["image"])).toEqual({ route: "image" });
    expect(routeDecision(["image", "image"])).toEqual({ route: "image" });
    expect(routeDecision(["text", "image"])).toEqual({ route: "image" });
  });

  it("routes video (with optional text files) to video", () => {
    expect(routeDecision(["video"])).toEqual({ route: "video" });
    expect(routeDecision(["text", "video"])).toEqual({ route: "video" });
  });

  it("errors when image and video are mixed", () => {
    expect(routeDecision(["image", "video"])).toEqual({
      route: "error",
      message: "Send image and video attachments separately",
    });
  });

  it("errors on unsupported kinds", () => {
    expect(routeDecision(["unsupported"])).toEqual({
      route: "error",
      message: "Unsupported file type",
    });
    expect(routeDecision(["text", "unsupported"])).toEqual({
      route: "error",
      message: "Unsupported file type",
    });
  });
});

describe("isRenderableMediaUrl", () => {
  it("accepts host media and inline raster data URLs for images, never a remote one", () => {
    expect(isRenderableImageUrl("data:image/png;base64,aaa")).toBe(true);
    expect(isRenderableImageUrl("/api/v1/media/abc/file")).toBe(true);
    expect(isRenderableImageUrl("agentforge://media/abc")).toBe(true);
    expect(isRenderableImageUrl("https://cdn.example/a.png")).toBe(false);
    expect(isRenderableImageUrl("http://127.0.0.1/a.png")).toBe(false);
    expect(isRenderableImageUrl("ftp://x")).toBe(false);
    expect(isRenderableImageUrl("/other/path")).toBe(false);
  });

  it("accepts host media only for videos", () => {
    expect(isRenderableVideoUrl("/api/v1/media/abc/file")).toBe(true);
    expect(isRenderableVideoUrl("agentforge://media/abc")).toBe(true);
    expect(isRenderableVideoUrl("https://cdn.example/a.mp4")).toBe(false);
    expect(isRenderableVideoUrl("http://127.0.0.1/a.mp4")).toBe(false);
    expect(isRenderableVideoUrl("data:video/mp4;base64,aaa")).toBe(false);
    expect(isRenderableVideoUrl("data:image/png;base64,aaa")).toBe(false);
    expect(isRenderableVideoUrl("/other/path")).toBe(false);
  });
});
