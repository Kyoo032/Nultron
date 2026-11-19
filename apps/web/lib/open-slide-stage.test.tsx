import { draftOpenSlideDeck } from "@agentforge/core/open-slide";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OpenSlideStage } from "@/components/open-slide-stage";

describe("Open Slide cover titles", () => {
  it.each([
    "Saturday pickup",
    "Nultron Workbench Quarterly Deep-Dive",
    "A Very Long Cover Title That Keeps Going And Going Beyond The Box Limits",
  ])("renders the full title at its stored size before measuring: %s", (prompt) => {
    const deck = draftOpenSlideDeck({ prompt, locale: "en" });
    const markup = renderToStaticMarkup(<OpenSlideStage deck={deck} onChange={() => {}} />);
    expect(markup).toContain("font-size:7.291666666666667cqw");
    expect(markup).toContain(prompt);
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
    expect(markup).not.toContain("overflow-wrap:anywhere");
  });
});
