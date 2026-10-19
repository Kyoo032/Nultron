import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarketBoard } from "@/components/market-board";
import { applyLocale, resetLocaleForTests } from "./i18n";
import { OFFLINE_HINT } from "./market-client";

const BASE = { board: null, loading: false, tickers: ["MU"], onRefresh: () => {} };

describe("MarketBoard failure notice", () => {
  beforeEach(() => {
    applyLocale("en");
  });

  afterEach(() => {
    resetLocaleForTests();
  });

  it("draws the unavailable copy and a Try again button, not the generic sentence", () => {
    const html = renderToStaticMarkup(<MarketBoard {...BASE} error={{ kind: "unavailable" }} />);
    expect(html).toContain('data-testid="market-board-unavailable"');
    expect(html).toContain('data-testid="market-board-retry"');
    expect(html).toContain("Try again");
    expect(html).toContain("Price data could not be reached right now");
    expect(html).not.toContain('data-testid="market-board-error"');
    expect(html).not.toContain("The server could not complete this request.");
  });

  it("keeps the plain sentence in the error line for every other failure", () => {
    const html = renderToStaticMarkup(<MarketBoard {...BASE} error={{ kind: "message", text: OFFLINE_HINT }} />);
    expect(html).toContain('data-testid="market-board-error"');
    expect(html).toContain(OFFLINE_HINT);
    expect(html).not.toContain('data-testid="market-board-unavailable"');
  });

  it("draws no notice when there is no error", () => {
    const html = renderToStaticMarkup(<MarketBoard {...BASE} error={null} />);
    expect(html).not.toContain("market-board-unavailable");
    expect(html).not.toContain("market-board-error");
  });
});
