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
    expect(html).toContain("GLM 5.3 tidak bisa membaca gambar. Pakai model lain yang bisa membaca gambar, atau hapus gambarnya.");
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

// Tester code (chat-first): the composer has no model picker, only the tier picker, so it knows no model
// name. It still draws the video note (no model in Chat takes video) and never an image note or a switch.
describe("ChatComposer carries the note", () => {
  beforeEach(() => {
    resetComposerDraftForTests();
    writeComposerDraft(null, {
      text: "",
      files: [
        {
          id: "f1",
          file: new File([new Uint8Array([1, 2, 3])], "clip.mp4", { type: "video/mp4" }),
          kind: "video",
        },
      ],
    });
  });
  afterEach(() => resetComposerDraftForTests());

  it("shows the video note under the chip and never a model switch", () => {
    applyLocale("en");
    const html = renderToStaticMarkup(
      <ChatComposer
        threadId={null}
        modalities={["text", "image"]}
        onDelta={() => {}}
        onComplete={() => {}}
      />,
    );
    expect(html).toContain("clip.mp4");
    expect(html).toContain('data-testid="composer-video-note"');
    expect(html).not.toContain("composer-image-switch");
  });

  it("clears the refusal sentence when the tier changes, so a stale refusal does not stay standing", () => {
    // React state cannot be driven here (no DOM), so the rule is read from the composer's source: when the
    // tier prop is no longer the one the error was written for, the error goes.
    expect(composerSource).toMatch(
      /const \[shownTier, setShownTier\] = useState\(tier\);\s+if \(shownTier !== tier\) \{[^}]*setShownTier\(tier\);[^}]*setError\(null\);/,
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
