import { afterEach, describe, expect, it, vi } from "vitest";
import { boardFailureOf, MARKET_UNAVAILABLE_CODE } from "./market-board-error";
import { fetchMarketBoard, MarketRequestError, NO_TICKER_HINT, OFFLINE_HINT } from "./market-client";

const MASKED_MESSAGE = "The server could not complete this request.";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("boardFailureOf", () => {
  it("shows the unavailable notice for market_unavailable, whatever the sentence says", () => {
    expect(boardFailureOf(new MarketRequestError(MASKED_MESSAGE, MARKET_UNAVAILABLE_CODE))).toEqual({
      kind: "unavailable",
    });
    expect(
      boardFailureOf(
        new MarketRequestError("Market data could not be fetched: MU: quote: timeout", MARKET_UNAVAILABLE_CODE),
      ),
    ).toEqual({ kind: "unavailable" });
  });

  it("keeps the sentence for an internal error, as before", () => {
    expect(boardFailureOf(new MarketRequestError(MASKED_MESSAGE, "internal_error"))).toEqual({
      kind: "message",
      text: MASKED_MESSAGE,
    });
  });

  it("maps the other codes and plain errors through the plain-language hints", () => {
    expect(
      boardFailureOf(new MarketRequestError("No ticker resolved: ZZZZ: unknown symbol", "invalid_ticker")),
    ).toEqual({ kind: "message", text: NO_TICKER_HINT });
    expect(boardFailureOf(new TypeError("fetch failed"))).toEqual({ kind: "message", text: OFFLINE_HINT });
    expect(boardFailureOf(new MarketRequestError("Market data could not be fetched: MU", null))).toEqual({
      kind: "message",
      text: OFFLINE_HINT,
    });
  });

  it("uses the default sentence for a value that is not an error", () => {
    expect(boardFailureOf("boom")).toEqual({ kind: "message", text: "Could not load the watchlist" });
  });
});

describe("fetchMarketBoard", () => {
  it("carries the host code out of a masked 502, so the notice can be drawn", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ error: { code: MARKET_UNAVAILABLE_CODE, message: MASKED_MESSAGE } }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const failure = await fetchMarketBoard(["MU"]).then(
      () => null,
      (error: unknown) => boardFailureOf(error),
    );
    expect(failure).toEqual({ kind: "unavailable" });
  });
});
