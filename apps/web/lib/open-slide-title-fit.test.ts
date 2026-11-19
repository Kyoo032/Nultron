import { afterEach, describe, expect, it, vi } from "vitest";
import { fitOpenSlideTitle } from "./open-slide-title-fit";

afterEach(() => vi.unstubAllGlobals());

function titleBox(text: string) {
  const style = { fontSize: "" };
  const element = {
    style,
    clientHeight: 120,
    clientWidth: 840,
    get scrollHeight() {
      const size = style.fontSize.endsWith("cqw") ? 70 : Number.parseFloat(style.fontSize);
      const lines = Math.ceil((text.length * size * 0.6) / this.clientWidth);
      return Math.ceil(lines * size * 1.2);
    },
    scrollWidth: 840,
    querySelector: () => null,
  };
  vi.stubGlobal("getComputedStyle", () => ({ fontSize: "70px" }));
  return element;
}

describe("cover title shrink-to-fit", () => {
  const storedSize = "7.291666666666667cqw";

  it("preserves the exact stored size when a short title fits", () => {
    const box = titleBox("Saturday pickup");
    fitOpenSlideTitle(box as unknown as HTMLElement, storedSize);
    expect(box.style.fontSize).toBe(storedSize);
  });

  it.each([
    "Nultron Workbench Quarterly Deep-Dive",
    "A Very Long Cover Title That Keeps Going And Going Beyond The Box Limits",
  ])("shrinks overflowing text until all lines fit: %s", (text) => {
    const box = titleBox(text);
    fitOpenSlideTitle(box as unknown as HTMLElement, storedSize);
    expect(Number.parseFloat(box.style.fontSize)).toBeLessThan(70);
    expect(box.scrollHeight).toBeLessThanOrEqual(box.clientHeight);
    expect(Number.parseFloat(box.style.fontSize)).toBeGreaterThan(0);
    box.clientHeight = 500;
    fitOpenSlideTitle(box as unknown as HTMLElement, storedSize);
    expect(box.style.fontSize).toBe(storedSize);
  });

  it("defers fitting a hidden box until it has dimensions", () => {
    const box = titleBox("Nultron Workbench Quarterly Deep-Dive");
    box.clientHeight = 0;
    fitOpenSlideTitle(box as unknown as HTMLElement, storedSize);
    expect(box.style.fontSize).toBe(storedSize);
  });
});
