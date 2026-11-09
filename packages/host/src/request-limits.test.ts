import { marketBriefingSchema } from "@agentforge/core/artifacts";
import {
  ANALYST_KEY_POINTS_MAX,
  BRIEFING_SECTIONS_MAX,
  BRIEFING_SOURCES_MAX,
  DEBATE_POINTS_MAX,
  DEBATE_REBUTTALS_MAX,
  MARKET_ANALYSTS,
  NEWS_PER_TICKER_MAX,
  RISK_KEY_RISKS_MAX,
  RISK_LENSES,
  ROTATION_MAX,
  SIGNALS_MAX,
  SWING_POINTS_MAX,
  TEAM_ROUNDS,
  WATCHLIST_MAX,
} from "@agentforge/core/market";
import * as fixtures from "@agentforge/core/market/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  BRIEFING_LIMITS,
  CONTAINER_COST,
  REQUEST_ARRAY_MAX,
  REQUEST_COST_MAX,
  assertRequestWithin,
} from "./request-limits";

function many<T>(count: number, make: (index: number) => T): T[] {
  return Array.from({ length: count }, (_, index) => make(index));
}

const HISTORY_BARS_FULL = 756;
const CHART_POINTS = 120;

function fullestTicker(index: number) {
  const symbol = `T${index}`;
  return {
    ...fixtures.makeTickerPacket(symbol),
    history: fixtures.makeHistory(symbol, HISTORY_BARS_FULL),
    chart: {
      type: "line" as const,
      title: `${symbol} close`,
      x: { label: "date", values: many(CHART_POINTS, (point) => `2026-01-${String((point % 27) + 1).padStart(2, "0")}`) },
      series: many(3, (line) => ({ name: `series ${line}`, values: many(CHART_POINTS, (point) => point + 1) })),
    },
    news: many(NEWS_PER_TICKER_MAX, (item) =>
      fixtures.makeNews(`headline ${item}`, "Reuters", `https://example.test/${index}/${item}`),
    ),
    swings: many(SWING_POINTS_MAX, (point) => ({
      date: "2026-08-01",
      price: 100 + point,
      kind: point % 2 === 0 ? ("high" as const) : ("low" as const),
    })),
    crypto: fixtures.makeCrypto(),
    fundamentals: fixtures.makeFundamentals(),
    insiders: fixtures.makeInsiders(),
    sentiment: fixtures.makeSentiment(),
    failures: many(15, (note) => `source ${note} did not answer`),
  };
}

function fullestTeamNotes() {
  const side = (stance: "bull" | "bear") => ({
    stance,
    thesis: "thesis",
    points: many(DEBATE_POINTS_MAX, () => "point"),
    rebuttals: many(DEBATE_REBUTTALS_MAX, () => "rebuttal"),
  });
  return {
    analysts: MARKET_ANALYSTS.map((analyst) => ({
      analyst,
      summary: "summary",
      keyPoints: many(ANALYST_KEY_POINTS_MAX, () => "point"),
      confidence: "medium" as const,
    })),
    bull: side("bull"),
    bear: side("bear"),
    risk: {
      lenses: RISK_LENSES.map((lens) => ({ lens, view: "view", keyRisks: many(RISK_KEY_RISKS_MAX, () => "risk") })),
      volatility: "volatility",
      liquidity: "liquidity",
    },
    rounds: TEAM_ROUNDS,
  };
}

function fullestBriefing(): unknown {
  const base = fixtures.makeFullPacket();
  const parsed = marketBriefingSchema.parse({
    title: "Briefing",
    language: "en",
    specialist: "saham",
    depth: "team",
    generatedAt: fixtures.FIXTURE_NOW,
    sections: many(BRIEFING_SECTIONS_MAX, (section) => ({ heading: `heading ${section}`, body: "body" })),
    packet: {
      ...base,
      tickers: many(WATCHLIST_MAX, fullestTicker),
      macro: {
        quotes: many(10, (item) => ({ ...fixtures.makeQuote(`M${item}`), label: `Macro ${item}` })),
        failures: many(5, (note) => `macro ${note} failed`),
      },
      signals: many(SIGNALS_MAX, () => fixtures.FIXTURE_SIGNALS[0]),
      rotation: many(ROTATION_MAX, () => fixtures.FIXTURE_ROTATION[0]),
    },
    sources: many(BRIEFING_SOURCES_MAX, (item) => ({
      label: `source ${item}`,
      url: `https://example.test/${item}`,
      observedAt: fixtures.FIXTURE_NOW,
    })),
    team: fullestTeamNotes(),
    guardedSections: 0,
    disclaimer: "Not advice.",
  });
  return parsed;
}

describe("assertRequestWithin", () => {
  it("passes a list at the cap and refuses one past it, at any depth", () => {
    expect(() => assertRequestWithin({ a: many(REQUEST_ARRAY_MAX, () => 0) }, "body")).not.toThrow();
    expect(() => assertRequestWithin({ a: [{ b: [many(REQUEST_ARRAY_MAX + 1, () => 0)] }] }, "body")).toThrow(
      /body has a list over/,
    );
  });

  it("charges an object or a list the container cost and any other value one", () => {
    const fits = Math.floor((REQUEST_COST_MAX - CONTAINER_COST) / CONTAINER_COST);
    expect(() => assertRequestWithin(many(fits, () => ({})), "body")).not.toThrow();
    expect(() => assertRequestWithin(many(fits + 1, () => ({})), "body")).toThrow(/larger than a request/);
    expect(() => assertRequestWithin(many(REQUEST_ARRAY_MAX, () => 0), "body")).not.toThrow();
  });

  it("counts object values as well as list items", () => {
    const tight = { list: 10, cost: CONTAINER_COST + 2 };
    expect(() => assertRequestWithin({ a: 1, b: 2 }, "body", tight)).not.toThrow();
    expect(() => assertRequestWithin({ a: 1, b: 2, c: 3 }, "body", tight)).toThrow(/larger than a request/);
  });

  it("holds a body of empty objects to the number of fields they can fail, not to the number of objects", () => {
    const shapesPerSlide = 24;
    const slideCost = CONTAINER_COST + CONTAINER_COST + shapesPerSlide * CONTAINER_COST;
    const slides = Math.floor(REQUEST_COST_MAX / slideCost);
    const body = (count: number) => ({ slides: many(count, () => ({ shapes: many(shapesPerSlide, () => ({})) })) });
    expect(() => assertRequestWithin(body(slides - 1), "body")).not.toThrow();
    expect(() => assertRequestWithin(body(slides + 1), "body")).toThrow(/larger than a request/);
  });

  it("ignores scalars, null and undefined", () => {
    for (const value of [undefined, null, "text", 4, true]) {
      expect(() => assertRequestWithin(value, "body")).not.toThrow();
    }
  });
});

describe("the briefing profile", () => {
  it("admits the fullest briefing the schema accepts, which the default profile refuses", () => {
    const briefing = fullestBriefing();
    expect(() => assertRequestWithin(briefing, "briefing", BRIEFING_LIMITS)).not.toThrow();
    expect(() => assertRequestWithin({ briefing, section: 0 }, "body", BRIEFING_LIMITS)).not.toThrow();
    expect(() => assertRequestWithin(briefing, "briefing")).toThrow(/larger than a request/);
  });

  it("refuses a Market list over the briefing cap that the default cap would allow", () => {
    const list = many(BRIEFING_LIMITS.list + 1, () => 0);
    expect(() => assertRequestWithin(list, "briefing", BRIEFING_LIMITS)).toThrow(/list over/);
    expect(() => assertRequestWithin(list, "briefing")).not.toThrow();
  });
});
