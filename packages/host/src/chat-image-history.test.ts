import { describe, expect, it, vi } from "vitest";
import { EARLIER_IMAGE_NOT_VISIBLE_NOTE, type ContentPart, type TenantContext } from "@agentforge/core";

const EARLIER_NOTE_OPENING = EARLIER_IMAGE_NOT_VISIBLE_NOTE.slice(0, 40);
import {
  assertChatImagesSendable,
  CHAT_IMAGE_REQUEST_BYTES,
  prepareChatImageHistory,
  type ChatMediaReader,
  type ChatTurn,
} from "./chat-image-history";

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org",
  workspaceId: "ws",
  userId: "user",
  role: "owner",
};

const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ID_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MIB = 1024 * 1024;
const url = (id: string) => `/api/v1/media/${id}/file`;

/** A data URL whose payload decodes to `bytes` bytes. */
function dataUrlOf(bytes: number): string {
  return `data:image/png;base64,${Buffer.alloc(bytes, 1).toString("base64")}`;
}

function image(id: string): ContentPart {
  return { type: "image_url", image_url: { url: url(id), detail: "high" } };
}

function turn(role: ChatTurn["role"], ...parts: ContentPart[]): ChatTurn {
  return { role, parts };
}

const text = (value: string): ContentPart => ({ type: "text", text: value });

/**
 * A media store holding `sizes` bytes per id, each row of the kind `kinds` names (an image by default).
 * `stat` is the row alone; `read` is the bytes, and is what must not be paid for until a row has passed.
 */
function store(sizes: Record<string, number>, kinds: Record<string, string> = {}) {
  return {
    stat: vi.fn(async (_tenant: TenantContext, id: string) =>
      id in sizes ? { kind: kinds[id] ?? "image", sizeBytes: sizes[id] as number } : null,
    ),
    read: vi.fn(async (_tenant: TenantContext, id: string) => (id in sizes ? dataUrlOf(sizes[id] as number) : null)),
  } satisfies ChatMediaReader;
}

/** The notes about an earlier image, with or without a reference (`earlierImageNote`). */
function noteCount(parts: ContentPart[]): number {
  return parts.filter((part) => part.type === "text" && part.text.startsWith(EARLIER_NOTE_OPENING)).length;
}

const gpt = (media: ChatMediaReader, extra: { budgetBytes?: number; locale?: "en" | "id" } = {}) => ({
  model: "gpt-4o",
  locale: extra.locale ?? ("en" as const),
  media,
  ...(extra.budgetBytes ? { budgetBytes: extra.budgetBytes } : {}),
});

describe("prepareChatImageHistory", () => {
  it("returns the history itself when no message carries an image", async () => {
    const history = [turn("user", text("hi")), turn("assistant", text("hello"))];
    const media = store({});
    const result = await prepareChatImageHistory(tenant, history, gpt(media));
    expect(result).toBe(history);
    expect(media.stat).not.toHaveBeenCalled();
    expect(media.read).not.toHaveBeenCalled();
  });

  it("budgets 6 MiB of image per request", () => {
    // The AI SDK sends the whole prompt again on every tool step (Chat allows 12), so the request budget is
    // a multiplier on the body the host's runtime copies, parses and sends each time.
    expect(CHAT_IMAGE_REQUEST_BYTES).toBe(6 * MIB);
  });

  it("sends the latest image as bytes and keeps its other fields", async () => {
    const media = store({ [ID_A]: 100 });
    const history = [turn("user", text("What is this?"), image(ID_A))];
    const [only] = await prepareChatImageHistory(tenant, history, gpt(media));
    expect(only?.parts[0]).toEqual(text("What is this?"));
    const sent = only?.parts[1];
    expect(sent?.type).toBe("image_url");
    if (sent?.type === "image_url") {
      expect(sent.image_url.url).toBe(dataUrlOf(100));
      expect(sent.image_url.detail).toBe("high");
    }
  });

  it("does not change the history it was given", async () => {
    const history = [turn("user", image(ID_A))];
    await prepareChatImageHistory(tenant, history, gpt(store({ [ID_A]: 10 })));
    expect(history[0]?.parts[0]).toEqual(image(ID_A));
  });

  it("keeps earlier images newest first while they fit, then says the model cannot see the rest", async () => {
    // Three images of 6 bytes against a budget of 13: the latest and the one before fit, the oldest does not.
    const history = [
      turn("user", text("first"), image(ID_A)),
      turn("assistant", text("ok")),
      turn("user", text("second"), image(ID_B)),
      turn("assistant", text("ok")),
      turn("user", text("third"), image(ID_C)),
    ];
    const media = store({ [ID_A]: 6, [ID_B]: 6, [ID_C]: 6 });
    const result = await prepareChatImageHistory(tenant, history, gpt(media, { budgetBytes: 13 }));
    const sent = (index: number) => result[index]?.parts.some((part) => part.type === "image_url");
    expect(sent(4)).toBe(true);
    expect(sent(2)).toBe(true);
    expect(sent(0)).toBe(false);
    expect(noteCount(result[0]?.parts ?? [])).toBe(1);
    // The oldest was looked up, found not to fit, and never read.
    expect(media.read.mock.calls.map((call) => call[1])).toEqual([ID_C, ID_B]);
  });

  it("does not look at an older image once a newer one did not fit", async () => {
    const history = [turn("user", image(ID_A)), turn("user", image(ID_B)), turn("user", image(ID_C))];
    const media = store({ [ID_A]: 1, [ID_B]: 50, [ID_C]: 5 });
    const result = await prepareChatImageHistory(tenant, history, gpt(media, { budgetBytes: 10 }));
    // C (latest) fits; B (50) does not; A is small enough to fit but is older than B, so its bytes are never
    // read. Its row is read once, for the reference its note names (the owner check). No bytes for any note.
    // B's row is read again for its note, because the budget check keeps no row (`prepare`).
    expect(media.stat.mock.calls.map((call) => call[1])).toEqual([ID_C, ID_B, ID_B, ID_A]);
    expect(media.read.mock.calls.map((call) => call[1])).toEqual([ID_C]);
    expect(result[2]?.parts[0]?.type).toBe("image_url");
    expect(noteCount(result[1]?.parts ?? [])).toBe(1);
    expect(noteCount(result[0]?.parts ?? [])).toBe(1);
    expect(JSON.stringify(result[0]?.parts)).toContain(`reference: ${url(ID_A)}`);
  });

  it("refuses, in words, a latest message whose own images are over the limit", async () => {
    const history = [turn("user", text("look"), image(ID_A), image(ID_B))];
    const media = store({ [ID_A]: 4 * MIB, [ID_B]: 3 * MIB });
    await expect(prepareChatImageHistory(tenant, history, gpt(media))).rejects.toThrow(
      /too large to send together \(over 6 MB\)/,
    );
    await expect(prepareChatImageHistory(tenant, history, gpt(media, { locale: "id" }))).rejects.toThrow(
      /terlalu besar untuk dikirim bersamaan \(lebih dari 6 MB\)/,
    );
  });

  it("compares the stored size to what is left before it reads any bytes", async () => {
    const history = [turn("user", image(ID_A))];
    const media = store({ [ID_A]: 7 * MIB });
    await expect(prepareChatImageHistory(tenant, history, gpt(media))).rejects.toThrow(/over 6 MB/);
    expect(media.stat).toHaveBeenCalledTimes(1);
    expect(media.read).not.toHaveBeenCalled();
  });

  it("does not read an earlier image that is over what is left, and notes it", async () => {
    const history = [turn("user", image(ID_A)), turn("assistant", text("ok")), turn("user", text("and?"), image(ID_B))];
    const media = store({ [ID_A]: 5 * MIB, [ID_B]: 2 * MIB });
    const result = await prepareChatImageHistory(tenant, history, gpt(media));
    expect(media.read.mock.calls.map((call) => call[1])).toEqual([ID_B]);
    expect(noteCount(result[0]?.parts ?? [])).toBe(1);
    expect(result[2]?.parts[1]?.type).toBe("image_url");
  });

  it("still holds the budget when the stored size understates the bytes", async () => {
    // A row's size is written once at upload; the bytes that come back are what travel.
    const media = {
      stat: vi.fn(async () => ({ kind: "image", sizeBytes: 10 })),
      read: vi.fn(async () => dataUrlOf(7 * MIB)),
    } satisfies ChatMediaReader;
    await expect(prepareChatImageHistory(tenant, [turn("user", image(ID_A))], gpt(media))).rejects.toThrow(/over 6 MB/);
  });

  it("refuses, in words, a latest image the store no longer has", async () => {
    const history = [turn("user", text("look"), image(ID_A))];
    await expect(prepareChatImageHistory(tenant, history, gpt(store({})))).rejects.toThrow(/could not be read/);
  });

  it("refuses a latest image whose bytes cannot be read, though its row is there", async () => {
    const media = { stat: vi.fn(async () => ({ kind: "image", sizeBytes: 5 })), read: vi.fn(async () => null) };
    await expect(prepareChatImageHistory(tenant, [turn("user", image(ID_A))], gpt(media))).rejects.toThrow(
      /could not be read/,
    );
  });

  it("notes an earlier image the store no longer has, and carries on", async () => {
    const history = [turn("user", image(ID_A)), turn("assistant", text("ok")), turn("user", text("and now?"))];
    const result = await prepareChatImageHistory(tenant, history, gpt(store({})));
    expect(noteCount(result[0]?.parts ?? [])).toBe(1);
  });

  it("sends no pixels to a model known to be text-only and says so for each earlier image", async () => {
    const media = store({ [ID_A]: 5, [ID_B]: 5 });
    const history = [
      turn("user", image(ID_A), image(ID_B)),
      turn("assistant", text("ok")),
      turn("user", text("summarise")),
    ];
    const result = await prepareChatImageHistory(tenant, history, { ...gpt(media), model: "glm-5.3" });
    // A note reads the row for its reference, never the bytes.
    expect(media.read).not.toHaveBeenCalled();
    // One note per picture, each with its reference, so the model can name either one to edit it.
    expect(noteCount(result[0]?.parts ?? [])).toBe(2);
    expect(JSON.stringify(result)).toContain(`reference: ${url(ID_A)}`);
    expect(JSON.stringify(result)).toContain(`reference: ${url(ID_B)}`);
    expect(JSON.stringify(result)).not.toContain("data:image");
  });

  it("names the reference of an earlier image the person owns, so the model can pass it to image_generate", async () => {
    const media = store({ [ID_A]: 5 });
    const history = [turn("user", image(ID_A)), turn("assistant", text("ok")), turn("user", text("make it brighter"))];
    const result = await prepareChatImageHistory(tenant, history, gpt(media, { budgetBytes: 4 }));
    const note = result[0]?.parts.find((part) => part.type === "text" && part.text.includes("reference:"));
    expect(note?.type === "text" ? note.text : "").toContain(`reference: ${url(ID_A)}`);
    expect(note?.type === "text" ? note.text : "").toContain("image_generate");
    expect(media.read).not.toHaveBeenCalled();
  });

  it("adds the reference beside the latest message's own picture, when it is a stored one the org owns", async () => {
    const history = [turn("user", text("edit this"), image(ID_A))];
    const result = await prepareChatImageHistory(tenant, history, gpt(store({ [ID_A]: 5 })));
    const parts = result[0]?.parts ?? [];
    const texts = parts.map((part) => (part.type === "text" ? part.text : ""));
    expect(parts.some((part) => part.type === "image_url")).toBe(true);
    expect(texts.join("\n")).toContain(`(reference: ${url(ID_A)} — pass it to image_generate to edit this image)`);
  });

  it("adds no reference for a latest picture sent as a data URL", async () => {
    const history = [turn("user", { type: "image_url", image_url: { url: dataUrlOf(4) } })];
    const result = await prepareChatImageHistory(tenant, history, gpt(store({}), { budgetBytes: 10 }));
    expect(JSON.stringify(result)).not.toContain("(reference:");
  });

  it("refuses a latest picture whose id this organization does not own, so no reference is written for it", async () => {
    await expect(prepareChatImageHistory(tenant, [turn("user", image(ID_B))], gpt(store({})))).rejects.toThrow(
      /could not be read/,
    );
  });

  it("gives no reference for an earlier image the store does not hold for this organization", async () => {
    const history = [turn("user", image(ID_A)), turn("assistant", text("ok")), turn("user", text("make it brighter"))];
    const result = await prepareChatImageHistory(tenant, history, gpt(store({}), { budgetBytes: 4 }));
    expect(JSON.stringify(result)).not.toContain("reference:");
    expect(noteCount(result[0]?.parts ?? [])).toBe(1);
  });

  it("passes a data URL through and counts its bytes", async () => {
    const small = dataUrlOf(4);
    const history = [turn("user", { type: "image_url", image_url: { url: small } })];
    const result = await prepareChatImageHistory(tenant, history, gpt(store({}), { budgetBytes: 4 }));
    expect(result[0]?.parts[0]).toEqual(history[0]?.parts[0]);
    await expect(prepareChatImageHistory(tenant, history, gpt(store({}), { budgetBytes: 3 }))).rejects.toThrow(
      /too large to send together/,
    );
  });

  it("takes a data URL for what it is, even when its text ends like a media path", async () => {
    // `new URL` gives a data URL a "pathname" that is the whole payload, so asking "is this a media
    // reference?" first would read a stored picture for a payload that merely ends in one.
    const media = store({ [ID_A]: 5 });
    const sneaky = `data:text/plain,${url(ID_A)}`;
    const history = [turn("user", { type: "image_url", image_url: { url: sneaky } })];
    const result = await prepareChatImageHistory(tenant, history, gpt(media));
    expect(result[0]?.parts[0]).toEqual(history[0]?.parts[0]);
    expect(media.stat).not.toHaveBeenCalled();
    expect(media.read).not.toHaveBeenCalled();
  });

  it("counts a data URL that is not base64 by the text it puts in the request", async () => {
    const plain = `data:image/svg+xml,${"a".repeat(100)}`;
    const history = [turn("user", { type: "image_url", image_url: { url: plain } })];
    await expect(prepareChatImageHistory(tenant, history, gpt(store({}), { budgetBytes: 100 }))).rejects.toThrow(
      /too large to send together/,
    );
    const result = await prepareChatImageHistory(tenant, history, gpt(store({}), { budgetBytes: 200 }));
    expect(result[0]?.parts[0]).toEqual(history[0]?.parts[0]);
  });

  it("refuses a latest image whose URL only this machine could open and is not a stored one", async () => {
    const history = [turn("user", { type: "image_url", image_url: { url: "http://127.0.0.1:3000/x.png" } })];
    await expect(prepareChatImageHistory(tenant, history, gpt(store({})))).rejects.toThrow(/could not be read/);
  });

  it("serves a model it has no line for, so the gateway can answer for itself", async () => {
    const media = store({ [ID_A]: 5 });
    const result = await prepareChatImageHistory(tenant, [turn("user", image(ID_A))], {
      ...gpt(media),
      model: "some-new-model-9",
    });
    expect(result[0]?.parts[0]?.type).toBe("image_url");
    expect(media.read).toHaveBeenCalledTimes(1);
  });

  describe("an image part that names a stored file which is not an image", () => {
    // The composer sends only what it uploaded as an image; a request can name any media id, though.
    for (const kind of ["video", "audio"]) {
      it(`refuses a ${kind} row as the latest turn's image without reading it`, async () => {
        const media = store({ [ID_A]: 2 * MIB }, { [ID_A]: kind });
        await expect(prepareChatImageHistory(tenant, [turn("user", image(ID_A))], gpt(media))).rejects.toThrow(
          /could not be read/,
        );
        expect(media.read).not.toHaveBeenCalled();
      });

      it(`notes a ${kind} row among earlier turns' images, without reading it`, async () => {
        const media = store({ [ID_A]: 2 * MIB, [ID_B]: 10 }, { [ID_A]: kind });
        const history = [turn("user", image(ID_A)), turn("assistant", text("ok")), turn("user", image(ID_B))];
        const result = await prepareChatImageHistory(tenant, history, gpt(media));
        expect(media.read.mock.calls.map((call) => call[1])).toEqual([ID_B]);
        expect(noteCount(result[0]?.parts ?? [])).toBe(1);
        expect(JSON.stringify(result[0])).not.toContain("data:");
      });
    }
  });

  describe("an https image link in a user turn", () => {
    const link: ContentPart = { type: "image_url", image_url: { url: "https://cdn.example/a.png" } };

    it("is refused for the latest turn, in words, in both languages, and is not sent on", async () => {
      const media = store({});
      const history = [turn("user", text("look"), link)];
      await expect(prepareChatImageHistory(tenant, history, gpt(media))).rejects.toThrow(
        "A web link to an image can't be sent to the model. Attach the image itself.",
      );
      await expect(prepareChatImageHistory(tenant, history, gpt(media, { locale: "id" }))).rejects.toThrow(
        "Link web ke gambar tidak bisa dikirim ke model. Lampirkan gambar itu sendiri.",
      );
      expect(media.read).not.toHaveBeenCalled();
    });

    it("becomes the note that the model cannot see it when it is an earlier turn's", async () => {
      const history = [turn("user", link), turn("assistant", text("ok")), turn("user", text("and now?"))];
      const result = await prepareChatImageHistory(tenant, history, gpt(store({})));
      expect(noteCount(result[0]?.parts ?? [])).toBe(1);
      expect(JSON.stringify(result)).not.toContain("https://");
    });
  });

  it("looks only at the person's turns: an assistant's picture is never read or sent", async () => {
    const media = store({ [ID_A]: 5 });
    const history = [
      turn("user", text("draw")),
      turn("assistant", text("here"), image(ID_A)),
      turn("user", text("thanks")),
    ];
    const result = await prepareChatImageHistory(tenant, history, gpt(media));
    expect(result).toBe(history);
    expect(media.stat).not.toHaveBeenCalled();
  });
});

describe("assertChatImagesSendable", () => {
  const opts = (media: ChatMediaReader, extra: { budgetBytes?: number; locale?: "en" | "id" } = {}) => ({
    locale: extra.locale ?? ("en" as const),
    media,
    ...(extra.budgetBytes ? { budgetBytes: extra.budgetBytes } : {}),
  });

  it("does nothing for a turn with no image, and never touches the store", async () => {
    const media = store({});
    await expect(assertChatImagesSendable(tenant, [text("hi")], opts(media))).resolves.toBeUndefined();
    expect(media.stat).not.toHaveBeenCalled();
  });

  it("passes a stored image from its row alone: it reads no bytes", async () => {
    const media = store({ [ID_A]: 3 * MIB });
    await assertChatImagesSendable(tenant, [text("look"), image(ID_A)], opts(media));
    expect(media.stat).toHaveBeenCalledTimes(1);
    expect(media.read).not.toHaveBeenCalled();
  });

  it("refuses what the run itself would refuse, so the turn is not stored first", async () => {
    await expect(assertChatImagesSendable(tenant, [image(ID_A)], opts(store({})))).rejects.toThrow(/could not be read/);
    await expect(
      assertChatImagesSendable(tenant, [image(ID_A)], opts(store({ [ID_A]: 100 }, { [ID_A]: "video" }))),
    ).rejects.toThrow(/could not be read/);
    await expect(
      assertChatImagesSendable(
        tenant,
        [{ type: "image_url", image_url: { url: "https://cdn.example/a.png" } }],
        opts(store({})),
      ),
    ).rejects.toThrow(/web link to an image/);
    await expect(assertChatImagesSendable(tenant, [image(ID_A)], opts(store({ [ID_A]: 7 * MIB })))).rejects.toThrow(
      /over 6 MB/,
    );
  });

  it("adds the images of one message together against the budget", async () => {
    const media = store({ [ID_A]: 4 * MIB, [ID_B]: 3 * MIB });
    await expect(assertChatImagesSendable(tenant, [image(ID_A), image(ID_B)], opts(media))).rejects.toThrow(
      /too large to send together \(over 6 MB\)/,
    );
    await expect(
      assertChatImagesSendable(tenant, [image(ID_A), image(ID_B)], opts(media, { locale: "id" })),
    ).rejects.toThrow(/terlalu besar untuk dikirim bersamaan \(lebih dari 6 MB\)/);
  });
});
