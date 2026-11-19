import { draftOpenSlideDeck } from "@agentforge/core/open-slide";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OpenSlideStage } from "@/components/open-slide-stage";

describe("Open Slide cover titles", () => {
  it("fits two title lines inside the fixed block, including its borders", () => {
    const deck = draftOpenSlideDeck({ prompt: "A two-line cover title for Saturday pickup", locale: "en" });
    const markup = renderToStaticMarkup(<OpenSlideStage deck={deck} onChange={() => {}} />);
    expect(markup).toContain("font-size:min(7.291666666666667cqw, calc((12.5cqw - 4px) / 2.4))");
    expect(markup).toContain("A two-line cover title for Saturday pickup");
    expect(markup).toContain("font-size:2.083333333333333cqw");
  });

  it("renders no stage for an empty deck", () => {
    const deck = draftOpenSlideDeck({ prompt: "Saturday pickup", locale: "en" });
    expect(renderToStaticMarkup(<OpenSlideStage deck={{ ...deck, pages: [] }} onChange={() => {}} />)).toBe("");
  });

  it("does not apply cover fitting to other pages", () => {
    const deck = draftOpenSlideDeck({ prompt: "Saturday pickup", locale: "en" });
    const markup = renderToStaticMarkup(
      <OpenSlideStage deck={{ ...deck, pages: deck.pages.slice(1) }} onChange={() => {}} />,
    );
    expect(markup).not.toContain("font-size:min(");
  });
});
