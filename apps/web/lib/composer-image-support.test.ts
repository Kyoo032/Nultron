import { afterEach, describe, expect, it } from "vitest";
import {
  attachmentNotes,
  bestImageModel,
  chatModalities,
  imageRefusalMessage,
  inputTags,
  modelNameFor,
  type PickerModelLike,
} from "./composer-image-support";
import { applyLocale, resetLocaleForTests } from "./i18n";

/**
 * The owner's report: a screenshot sent on "GLM 5.3" never reached the model, and nothing said so.
 * These are the rules the composer follows now, before Send.
 */

const model = (id: string, label: string, inputModalities: string[] = ["text"]): PickerModelLike => ({
  id,
  label,
  inputModalities,
});

// What a desk lists. Note the cached modalities are the old prefix table's: GLM 5.3 tagged "image", GPT 6 not.
const LIST: PickerModelLike[] = [
  model("glm-5.3", "GLM 5.3", ["text", "image"]),
  model("gpt-6-luna", "GPT-6 Luna", ["text"]),
  model("claude-sonnet-5-5", "Claude Sonnet 5.5", ["text", "image"]),
  model("hy3", "HY3", ["text"]),
  model("deepseek-v4-pro", "DeepSeek V4 Pro", ["text", "image"]),
];

afterEach(() => resetLocaleForTests());

describe("attachmentNotes", () => {
  it("says nothing for a model that reads images", () => {
    expect(attachmentNotes({ kinds: ["image"], model: "gpt-6-luna", models: LIST })).toEqual([]);
  });

  it("says nothing when no image is attached, whatever the model", () => {
    expect(attachmentNotes({ kinds: ["text"], model: "glm-5.3", models: LIST })).toEqual([]);
    expect(attachmentNotes({ kinds: [], model: "glm-5.3", models: LIST })).toEqual([]);
  });

  it("tells the owner's case, GLM 5.3, that it cannot read the image, and offers the best model that can", () => {
    const [note] = attachmentNotes({ kinds: ["image"], model: "glm-5.3", models: LIST });
    expect(note).toMatchObject({ kind: "image", support: "no", modelName: "GLM 5.3" });
    // The Chat default order puts GPT-6 Luna first among the models that read images.
    expect(note && note.kind === "image" ? note.alternative : undefined).toEqual({
      id: "gpt-6-luna",
      name: "GPT-6 Luna",
    });
  });

  it("says a model it has no line for is unconfirmed, not refused", () => {
    const [note] = attachmentNotes({ kinds: ["image"], model: "hy3", models: LIST });
    expect(note).toMatchObject({ kind: "image", support: "unknown", modelName: "HY3" });
  });

  it("offers no switch when the desk lists no model that reads images", () => {
    const [note] = attachmentNotes({
      kinds: ["image"],
      model: "glm-5.3",
      models: [model("glm-5.3", "GLM 5.3"), model("hy3", "HY3")],
    });
    expect(note && note.kind === "image" ? note.alternative : "missing").toBeNull();
  });

  it("says video is not read, for every model", () => {
    expect(attachmentNotes({ kinds: ["video"], model: "gemini-3.5-flash", models: LIST })).toEqual([{ kind: "video" }]);
  });

  it("says nothing before a model is chosen", () => {
    expect(attachmentNotes({ kinds: ["image"], model: undefined, models: LIST })).toEqual([]);
    expect(attachmentNotes({ kinds: ["image"], model: "  ", models: LIST })).toEqual([]);
  });
});

describe("bestImageModel", () => {
  it("follows the Chat default order and skips the model being replaced", () => {
    expect(bestImageModel(LIST, "glm-5.3")?.id).toBe("gpt-6-luna");
    expect(bestImageModel(LIST, "gpt-6-luna")?.id).toBe("claude-sonnet-5-5");
  });

  it("uses the picker's friendly name when it has one", () => {
    const named = [{ ...model("gpt-6-luna", "gpt-6-luna"), friendlyLabel: "GPT 6 Luna" }];
    expect(bestImageModel(named)).toEqual({ id: "gpt-6-luna", name: "GPT 6 Luna" });
  });

  it("is null when nothing known reads images", () => {
    expect(bestImageModel([model("hy3", "HY3"), model("glm-5.3", "GLM 5.3")])).toBeNull();
  });
});

describe("chatModalities", () => {
  const agent = ["text", "image", "video"];

  it("offers image for a model that reads images even when the cached list forgot it", () => {
    expect(chatModalities(agent, { id: "gpt-6-luna", inputModalities: ["text"] })).toEqual(["text", "image"]);
  });

  it("withholds image from a model known to be text-only even when the cached list says it reads them", () => {
    expect(chatModalities(agent, { id: "glm-5.3", inputModalities: ["text", "image"] })).toEqual(["text"]);
  });

  it("offers image for a model it has no line for, so the person can try", () => {
    expect(chatModalities(agent, { id: "hy3", inputModalities: ["text"] })).toEqual(["text", "image"]);
  });

  it("keeps video as the host listed it, and honours an agent that takes no images", () => {
    expect(chatModalities(agent, { id: "gemini-3.5-flash", inputModalities: ["text", "image", "video"] })).toEqual([
      "text",
      "image",
      "video",
    ]);
    expect(chatModalities(["text"], { id: "gpt-6-luna", inputModalities: ["text"] })).toEqual(["text"]);
  });

  it("offers text only before the model list has loaded", () => {
    expect(chatModalities(agent, undefined)).toEqual(["text"]);
  });
});

describe("inputTags", () => {
  it("tags image from what the app knows, not from a stale cached list", () => {
    expect(inputTags({ id: "glm-5.3", inputModalities: ["text", "image"] })).toEqual([]);
    expect(inputTags({ id: "gpt-6-luna", inputModalities: ["text"] })).toEqual(["image"]);
    expect(inputTags({ id: "gemini-3.5-flash", inputModalities: ["text", "image", "video"] })).toEqual([
      "image",
      "video",
    ]);
  });

  it("keeps the host's own answer for a model it has no line for", () => {
    expect(inputTags({ id: "hy3", inputModalities: ["text", "image"] })).toEqual(["image"]);
    expect(inputTags({ id: "hy3", inputModalities: ["text"] })).toEqual([]);
  });
});

describe("imageRefusalMessage", () => {
  it("names the model when it is the model that cannot read images", () => {
    applyLocale("en");
    expect(imageRefusalMessage("glm-5.3", LIST)).toBe(
      "GLM 5.3 can't read images. Switch to a model that can, or remove the image.",
    );
  });

  it("says it in Bahasa Indonesia on an Indonesian desk", () => {
    applyLocale("id");
    expect(imageRefusalMessage("glm-5.3", LIST)).toBe(
      "GLM 5.3 tidak dapat membaca gambar. Ganti ke model yang bisa, atau hapus gambarnya.",
    );
  });

  it("falls back to the agent sentence when the model is fine and the agent is not", () => {
    applyLocale("en");
    expect(imageRefusalMessage("gpt-6-luna", LIST)).toBe("This agent or model does not accept image input");
  });
});

describe("modelNameFor", () => {
  it("reads the picker's name, or the id when the list has not loaded it", () => {
    expect(modelNameFor("glm-5.3", LIST)).toBe("GLM 5.3");
    expect(modelNameFor("unlisted-9", LIST)).toBe("unlisted-9");
  });
});
