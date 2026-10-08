/**
 * The note under an attached image, as the person reads it before pressing Send.
 *
 * The owner sent a screenshot on "GLM 5.3" and the model answered that it never received it. The
 * composer now says, on the attachment, that the model cannot read images, in both languages, and
 * offers the best model that can. This package's vitest run has no DOM, so `renderToStaticMarkup` runs no
 * effects and no clicks: the note is a hook-free component whose tree is read and whose button is called
 * directly, the composer's markup says whether the button is drawn, and the one rule that lives in React
 * state (the refusal clears when the model changes) is read from the composer's source.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatComposer } from "@/components/chat-composer";
import { ComposerAttachmentNotes } from "@/components/composer-attachment-notes";
import type { ChatModel } from "@/components/model-picker";
import { resetComposerDraftForTests, writeComposerDraft } from "./composer-draft";
import { applyLocale, resetLocaleForTests } from "./i18n";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const composerSource = readFileSync(join(web, "components", "chat-composer.tsx"), "utf8");

const MODELS: ChatModel[] = [
  { id: "glm-5.3", label: "GLM 5.3", inputModalities: ["text", "image"] },
  { id: "gpt-6-luna", label: "GPT-6 Luna", inputModalities: ["text"] },
  { id: "hy3", label: "HY3", inputModalities: ["text"] },
];

/** The first element in a rendered tree with this testid. `ComposerAttachmentNotes` has no hooks, so it can be called. */
function findByTestId(node: ReactNode, testId: string): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByTestId(child, testId);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (!isValidElement(node)) {
    return null;
  }
  const props = node.props as { children?: ReactNode; "data-testid"?: string };
  return props["data-testid"] === testId ? node : findByTestId(props.children, testId);
}

function note(kinds: Array<"image" | "video" | "text">, model: string): string {
  return renderToStaticMarkup(
    <ComposerAttachmentNotes kinds={kinds} model={model} models={MODELS} onSwitch={() => {}} />,
  );
}

afterEach(() => resetLocaleForTests());

describe("ComposerAttachmentNotes", () => {
  it("is empty for a model that reads images", () => {
    expect(note(["image"], "gpt-6-luna")).toBe("");
  });

  it("says GLM 5.3 cannot read images, in English, and offers the switch", () => {
    applyLocale("en");
    const html = note(["image"], "glm-5.3");
    expect(html).toContain('data-testid="composer-image-note"');
    expect(html).toContain('data-state="no"');
    expect(html).toContain("GLM 5.3 can&#x27;t read images. Switch to a model that can, or remove the image.");
    expect(html).toContain('data-testid="composer-image-switch"');
    expect(html).toContain('data-model="gpt-6-luna"');
    expect(html).toContain("Use GPT-6 Luna");
  });

  it("says it in Bahasa Indonesia", () => {
    applyLocale("id");
    const html = note(["image"], "glm-5.3");
    expect(html).toContain("GLM 5.3 tidak dapat membaca gambar. Ganti ke model yang bisa, atau hapus gambarnya.");
    expect(html).toContain("Pakai GPT-6 Luna");
  });

  it("says an unlisted model is unconfirmed, and that the image is still sent", () => {
    applyLocale("en");
    const html = note(["image"], "hy3");
    expect(html).toContain('data-state="unknown"');
    expect(html).toContain("We can&#x27;t confirm that HY3 reads images. The image is sent anyway.");
  });

  it("says in both languages that Chat cannot pass video to a model", () => {
    applyLocale("en");
    expect(note(["video"], "gemini-3.5-flash")).toContain("Models can&#x27;t watch video in Chat yet.");
    applyLocale("id");
    expect(note(["video"], "gemini-3.5-flash")).toContain("Model belum bisa menonton video di Chat.");
    expect(note(["video"], "gemini-3.5-flash")).toContain('data-testid="composer-video-note"');
  });

  it("draws no switch button when the composer has no model picker to move", () => {
    const html = renderToStaticMarkup(<ComposerAttachmentNotes kinds={["image"]} model="glm-5.3" models={MODELS} />);
    expect(html).toContain('data-testid="composer-image-note"');
    expect(html).not.toContain("composer-image-switch");
  });
});

describe("ChatComposer carries the note", () => {
  beforeEach(() => {
    resetComposerDraftForTests();
    writeComposerDraft(null, {
      text: "",
      files: [
        {
          id: "f1",
          file: new File([new Uint8Array([1, 2, 3])], "screenshot.png", { type: "image/png" }),
          kind: "image",
        },
      ],
    });
  });
  afterEach(() => resetComposerDraftForTests());

  function composer(model: string): string {
    return renderToStaticMarkup(
      <ChatComposer
        threadId={null}
        modalities={["text", "image"]}
        model={model}
        models={MODELS}
        onModelChange={() => {}}
        onReasoningEffortChange={() => {}}
        onDelta={() => {}}
        onComplete={() => {}}
      />,
    );
  }

  it("shows the note under the chip of an attached screenshot on GLM 5.3", () => {
    applyLocale("en");
    const html = composer("glm-5.3");
    expect(html).toContain("screenshot.png");
    expect(html.indexOf('data-testid="composer-attachment"')).toBeLessThan(
      html.indexOf('data-testid="composer-image-note"'),
    );
    expect(html).toContain('data-testid="composer-image-switch"');
  });

  it("shows no note on a model that reads images", () => {
    applyLocale("en");
    expect(composer("gpt-6-luna")).not.toContain("composer-image-note");
  });

  it("offers the switch only when the composer has a model picker to move", () => {
    applyLocale("en");
    const withPicker = composer("glm-5.3");
    expect(withPicker).toContain('data-testid="composer-image-switch"');
    const withoutPicker = renderToStaticMarkup(
      <ChatComposer
        threadId={null}
        modalities={["text", "image"]}
        model="glm-5.3"
        models={MODELS}
        onReasoningEffortChange={() => {}}
        onDelta={() => {}}
        onComplete={() => {}}
      />,
    );
    expect(withoutPicker).toContain('data-testid="composer-image-note"');
    expect(withoutPicker).not.toContain("composer-image-switch");
  });

  it("clears the refusal sentence when the model changes, so the switch button does not leave it standing", () => {
    // React state cannot be driven here (no DOM), so the rule is read from the composer's source: when the
    // model prop is no longer the one the error was written for, the error goes.
    expect(composerSource).toMatch(
      /const \[shownModel, setShownModel\] = useState\(model\);\s+if \(shownModel !== model\) \{[^}]*setShownModel\(model\);[^}]*setError\(null\);/,
    );
  });
});

describe("the switch button", () => {
  it("moves the picker to the model the note offers", () => {
    const moved: string[] = [];
    const tree = ComposerAttachmentNotes({
      kinds: ["image"],
      model: "glm-5.3",
      models: MODELS,
      onSwitch: (id) => moved.push(id),
    });
    const button = findByTestId(tree, "composer-image-switch");
    expect(button, "the note offers a switch").not.toBeNull();
    const props = button?.props as { onClick: () => void; "data-model": string };
    expect(props["data-model"]).toBe("gpt-6-luna");
    props.onClick();
    expect(moved).toEqual(["gpt-6-luna"]);
  });
});
