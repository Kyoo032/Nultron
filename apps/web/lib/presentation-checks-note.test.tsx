import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { PresentationChecksNote } from "@/components/presentation-checks-note";
import { applyLocale, resetLocaleForTests } from "./i18n";

afterEach(() => resetLocaleForTests());

describe("the checks note", () => {
  it("renders nothing when the outline passed", () => {
    expect(renderToStaticMarkup(<PresentationChecksNote notes={[]} />)).toBe("");
  });

  it("lists what is left, one line per check", () => {
    applyLocale("en");
    const markup = renderToStaticMarkup(
      <PresentationChecksNote
        notes={[
          { check: "duplicate_title", slides: [1, 3] },
          { check: "slide_fit", slides: [2] },
        ]}
      />,
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Checked, and a few things are left for you:");
    expect(markup).toContain("The same heading on slides: 2, 4");
    expect(markup).toContain("May not fit the slide when downloaded: 3");
  });
});
