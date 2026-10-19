import { friendlyMarketError, MarketRequestError } from "./market-client";

export const MARKET_UNAVAILABLE_CODE = "market_unavailable";

export type BoardFailure = { kind: "unavailable" } | { kind: "message"; text: string };

export function boardFailureOf(error: unknown): BoardFailure {
  if (error instanceof MarketRequestError && error.code === MARKET_UNAVAILABLE_CODE) {
    return { kind: "unavailable" };
  }
  const message = error instanceof Error ? error.message : "Could not load the watchlist";
  return { kind: "message", text: friendlyMarketError(message) };
}
