import { describe, expect, it } from "vitest";
import {
  historyHasImage,
  imagePartForProvider,
  isUnreachableProviderMediaUrl,
  localMediaId,
  rewriteUnreachableMediaInJson,
  scrubUnreachableMediaArgs,
} from "./provider-media";

describe("localMediaId", () => {
  it("reads ids from relative and loopback media URLs", () => {
    expect(localMediaId("/api/v1/media/f66a438a-781a-478b-8e67-c19be7771c20/file")).toBe(
      "f66a438a-781a-478b-8e67-c19be7771c20",
    );
    expect(localMediaId("http://127.0.0.1:3000/api/v1/media/f66a438a-781a-478b-8e67-c19be7771c20/file")).toBe(
      "f66a438a-781a-478b-8e67-c19be7771c20",
    );
  });

  it("returns null for remote urls", () => {
    expect(localMediaId("https://cdn.example/a.png")).toBeNull();
    expect(localMediaId("data:image/png;base64,abc")).toBeNull();
  });
});

describe("isUnreachableProviderMediaUrl", () => {
  it("flags loopback and relative media", () => {
    expect(isUnreachableProviderMediaUrl("/api/v1/media/f66a438a-781a-478b-8e67-c19be7771c20/file")).toBe(true);
    expect(
      isUnreachableProviderMediaUrl("http://127.0.0.1:3000/api/v1/media/f66a438a-781a-478b-8e67-c19be7771c20/file"),
    ).toBe(true);
    expect(isUnreachableProviderMediaUrl("http://localhost:3000/x.png")).toBe(true);
  });

  it("allows https and data urls", () => {
    expect(isUnreachableProviderMediaUrl("https://cdn.example/a.png")).toBe(false);
    expect(isUnreachableProviderMediaUrl("data:image/png;base64,abc")).toBe(false);
  });
});

describe("imagePartForProvider", () => {
  it("sends https and data urls as images", () => {
    expect(imagePartForProvider("https://cdn.example/a.png")).toEqual({
      type: "image",
      image: "https://cdn.example/a.png",
    });
    expect(imagePartForProvider("data:image/png;base64,abc")).toEqual({
      type: "image",
      image: "data:image/png;base64,abc",
    });
  });

  it("does not send loopback urls to the provider, and does not pretend an image was sent", () => {
    expect(() =>
      imagePartForProvider("http://127.0.0.1:3000/api/v1/media/f66a438a-781a-478b-8e67-c19be7771c20/file"),
    ).toThrow(/could not be read/);
    expect(() => imagePartForProvider("/api/v1/media/f66a438a-781a-478b-8e67-c19be7771c20/file")).toThrow(
      /could not be read/,
    );
  });

  it("says so in the desk's language", () => {
    expect(() => imagePartForProvider("/api/v1/media/f66a438a-781a-478b-8e67-c19be7771c20/file", "id")).toThrow(
      /tidak bisa dibaca/,
    );
  });
});

describe("historyHasImage", () => {
  it("is true only when some message carries an image part", () => {
    const text = { role: "user", parts: [{ type: "text" }] };
    const image = { role: "user", parts: [{ type: "text" }, { type: "image_url" }] };
    expect(historyHasImage([text])).toBe(false);
    expect(historyHasImage([text, image])).toBe(true);
    expect(historyHasImage([])).toBe(false);
  });

  it("counts the person's images only: an assistant's picture is never sent, so it is not 'the image you attached'", () => {
    const generated = { role: "assistant", parts: [{ type: "text" }, { type: "image_url" }] };
    const question = { role: "user", parts: [{ type: "text" }] };
    expect(historyHasImage([question, generated, question])).toBe(false);
    expect(historyHasImage([generated, { role: "user", parts: [{ type: "image_url" }] }])).toBe(true);
  });
});

describe("scrubUnreachableMediaArgs", () => {
  it("drops loopback image_url so the gateway is not asked to download localhost", () => {
    expect(
      scrubUnreachableMediaArgs({
        prompt: "edit this",
        image_url: "http://127.0.0.1:3000/api/v1/media/f66a438a-781a-478b-8e67-c19be7771c20/file",
      }),
    ).toEqual({ prompt: "edit this" });
  });
});

describe("rewriteUnreachableMediaInJson", () => {
  it("rewrites chat image_url parts that point at the local app", () => {
    expect(
      rewriteUnreachableMediaInJson({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: "http://127.0.0.1:3000/api/v1/media/f66a438a-781a-478b-8e67-c19be7771c20/file",
                },
              },
            ],
          },
        ],
      }),
    ).toEqual({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "[Image attached in the local app. It is already shown to the user.]" }],
        },
      ],
    });
  });

  it("scrubs loopback urls inside JSON tool-call argument strings", () => {
    const rewritten = rewriteUnreachableMediaInJson({
      arguments: JSON.stringify({
        prompt: "edit this",
        image_url: "http://127.0.0.1:3000/api/v1/media/f66a438a-781a-478b-8e67-c19be7771c20/file",
      }),
    }) as { arguments: string };
    expect(JSON.parse(rewritten.arguments)).toEqual({ prompt: "edit this" });
  });

  it("leaves https image urls alone", () => {
    const body = {
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://cdn.example/a.png" } }] }],
    };
    expect(rewriteUnreachableMediaInJson(body)).toEqual(body);
  });
});

/**
 * On the Anthropic and Gemini wires a picture travels as raw base64, with no `data:` prefix, so the matcher
 * saw megabytes of it as a candidate address and `new URL` read every character, twice, to say it was not
 * one (measured: about 65 ms per call on a 6 MiB picture, once per tool step). An address needs a scheme
 * (`http:`) or is the app's own relative media path; a string with neither is not one, and is not parsed.
 */
describe("isUnreachableProviderMediaUrl on a string that cannot be an address", () => {
  const ID = "f66a438a-781a-478b-8e67-c19be7771c20";
  const HUGE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB".repeat(256 * 1024); // 8 MiB, colon-free

  /** The matcher as it was before the shortcut: the reference every answer is held to. */
  function reference(url: string): boolean {
    const trimmed = url.trim();
    if (trimmed.startsWith("data:")) {
      return false;
    }
    if (localMediaId(trimmed)) {
      return true;
    }
    try {
      const host = new URL(trimmed).hostname.toLowerCase();
      return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
    } catch {
      return false;
    }
  }

  function countUrlParses<T>(run: () => T): { result: T; parses: number } {
    const Original = globalThis.URL;
    let parses = 0;
    class Counting extends Original {
      constructor(...args: ConstructorParameters<typeof URL>) {
        parses += 1;
        super(...args);
      }
    }
    globalThis.URL = Counting as typeof URL;
    try {
      return { result: run(), parses };
    } finally {
      globalThis.URL = Original;
    }
  }

  it("does not parse a colon-free string as a URL", () => {
    const { result, parses } = countUrlParses(() => isUnreachableProviderMediaUrl(HUGE_BASE64));
    expect(result).toBe(false);
    expect(parses).toBe(0);
  });

  it("does not parse a JPEG's base64, which begins with a slash, either", () => {
    const jpeg = `/9j/4AAQSkZJRgABAQEAYABgAAD${HUGE_BASE64}`;
    const { result, parses } = countUrlParses(() => isUnreachableProviderMediaUrl(jpeg));
    expect(result).toBe(false);
    expect(parses).toBe(0);
  });

  it("still parses anything that has a scheme, so the answers below do not change", () => {
    const { result, parses } = countUrlParses(() => isUnreachableProviderMediaUrl("http://127.0.0.1:3000/x.png"));
    expect(result).toBe(true);
    expect(parses).toBeGreaterThan(0);
  });

  it("answers exactly as the matcher did, for every kind of string", () => {
    const corpus = [
      "",
      "   ",
      "localhost",
      "127.0.0.1",
      "127.0.0.1:3000/x.png",
      "localhost:3000/x.png",
      "javascript:alert(1)",
      "mailto:someone@example.com",
      "ht\ntp://localhost/x.png",
      "ht\ttp://127.0.0.1/x.png",
      "http://127.0.0.1/x.png",
      "  http://LOCALHOST:3000/x.png  ",
      "http://2130706433/x.png",
      "http://[::1]:3000/",
      "https://cdn.example/a.png",
      "data:image/png;base64,AAAA",
      `/api/v1/media/${ID}/file`,
      `/api/v1/media/${ID}/file/`,
      `/API/V1/MEDIA/${ID.toUpperCase()}/FILE`,
      `  /api/v1/media/${ID}/file  `,
      `http://127.0.0.1:3000/api/v1/media/${ID}/file`,
      `https://elsewhere.example/api/v1/media/${ID}/file`,
      "/api/v1/media/not-an-id/file",
      "/api/v1/mediaX",
      "/9j/4AAQSkZJRgAB",
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
      "plain words with no scheme",
      "Note: this has a colon but is not an address",
      HUGE_BASE64.slice(0, 5000),
    ];
    for (const value of corpus) {
      expect(isUnreachableProviderMediaUrl(value), JSON.stringify(value.slice(0, 60))).toBe(reference(value));
    }
  });

  it("lets the rewriter walk a raw-base64 body without parsing the picture as a URL", () => {
    const anthropic = {
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", data: HUGE_BASE64 } }] }],
    };
    const gemini = {
      contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: HUGE_BASE64 } }] }],
    };
    for (const body of [anthropic, gemini]) {
      const { result, parses } = countUrlParses(() => rewriteUnreachableMediaInJson(body));
      expect(result).toEqual(body);
      expect(parses).toBe(0);
    }
  });

  it("looks at a string's key before the string, and still drops a local address under a URL key", () => {
    const local = "http://127.0.0.1:3000/x.png";
    const body = {
      url: local,
      image: local,
      image_url: local,
      imageUrl: local,
      note: local,
      data: local,
      https: "https://cdn.example/a.png",
    };
    expect(rewriteUnreachableMediaInJson(body)).toEqual({
      note: local,
      data: local,
      https: "https://cdn.example/a.png",
    });
    // A huge string under a key that is not a URL key is never read.
    const { parses } = countUrlParses(() => rewriteUnreachableMediaInJson({ data: `http:${HUGE_BASE64}` }));
    expect(parses).toBe(0);
  });
});
