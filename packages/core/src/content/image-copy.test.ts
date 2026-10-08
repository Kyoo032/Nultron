import { describe, expect, it } from "vitest";
import {
  imageRemoteLinkMessage,
  imageRejectedMessage,
  imageUnreadableMessage,
  imagesTooLargeMessage,
} from "./image-copy";

describe("the sentences a person reads about an image that did not reach the model", () => {
  it("says a web link to an image cannot be sent, and what to do instead, in both languages", () => {
    expect(imageRemoteLinkMessage("en")).toBe(
      "A web link to an image can't be sent to the model. Attach the image itself.",
    );
    expect(imageRemoteLinkMessage("id")).toBe(
      "Tautan web ke gambar tidak dapat dikirim ke model. Lampirkan gambar itu sendiri.",
    );
  });

  it("falls back to English for a locale it does not know, as every other sentence does", () => {
    expect(imageRemoteLinkMessage("xx" as never)).toBe(imageRemoteLinkMessage("en"));
  });

  it("keeps the other sentences it already had", () => {
    expect(imageUnreadableMessage("en")).toMatch(/could not be read/);
    expect(imagesTooLargeMessage(6, "en")).toMatch(/over 6 MB/);
    expect(imageRejectedMessage(413, "", "en")).toMatch(/status_code=413/);
  });
});
