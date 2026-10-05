/**
 * The rail's recent-sessions block on a cold load.
 *
 * The Account group is pinned under the job modes, so whatever sits above it moves it. The session
 * rows arrive after the first frame, and on a desk with sessions `settings-link` slid 56 px down at
 * 1280 px while they did (found driving webdev, 2026-10-01). The block now draws as many placeholder
 * rows as the last load had (`lib/rail-recent-shape.ts`), and the real rows replace them in place.
 * The frames themselves are driven in a real browser (`features/rail.md`); this holds the rules and
 * the wiring, because the renderer's tests have no DOM.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RailRecentSkeleton } from "@/components/rail-recent-skeleton";
import {
  EMPTY_RECENT_SHAPE,
  RAIL_RECENT_SHAPE_KEY,
  parseRecentShape,
  readRecentShape,
  serializeRecentShape,
  shapeOfThreads,
  writeRecentShape,
} from "./rail-recent-shape";
import { RAIL_RECENT_THREADS } from "./thread-groups";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string) => readFileSync(join(webRoot, relative), "utf8").replace(/\r\n/g, "\n");

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

describe("shapeOfThreads", () => {
  it("is as many rows as the rail shows, and whether the See all row follows", () => {
    expect(shapeOfThreads(0)).toEqual({ rows: 0, more: false });
    expect(shapeOfThreads(2)).toEqual({ rows: 2, more: false });
    expect(shapeOfThreads(RAIL_RECENT_THREADS)).toEqual({ rows: RAIL_RECENT_THREADS, more: false });
    expect(shapeOfThreads(RAIL_RECENT_THREADS + 1)).toEqual({ rows: RAIL_RECENT_THREADS, more: true });
    expect(shapeOfThreads(40)).toEqual({ rows: RAIL_RECENT_THREADS, more: true });
  });

  it("reads a nonsense count as an empty block", () => {
    expect(shapeOfThreads(-3)).toEqual(EMPTY_RECENT_SHAPE);
    expect(shapeOfThreads(Number.NaN)).toEqual(EMPTY_RECENT_SHAPE);
  });
});

describe("parseRecentShape", () => {
  it("round-trips what serializeRecentShape wrote", () => {
    for (const shape of [EMPTY_RECENT_SHAPE, { rows: 3, more: false }, { rows: RAIL_RECENT_THREADS, more: true }]) {
      expect(parseRecentShape(serializeRecentShape(shape))).toEqual(shape);
    }
  });

  it("discards anything a build of this rail did not write", () => {
    for (const raw of [
      null,
      undefined,
      "",
      "not json",
      "null",
      "[]",
      '{"rows":"3","more":false}',
      '{"rows":3}',
      '{"rows":-1,"more":false}',
      '{"rows":1.5,"more":false}',
      `{"rows":${RAIL_RECENT_THREADS + 1},"more":false}`,
    ]) {
      expect(parseRecentShape(raw), String(raw)).toBeNull();
    }
  });
});

describe("the stored shape", () => {
  it("reads as an empty block when nothing is stored, the store is missing, or it throws", () => {
    expect(readRecentShape(memoryStore())).toEqual(EMPTY_RECENT_SHAPE);
    expect(readRecentShape(undefined)).toEqual(EMPTY_RECENT_SHAPE);
    expect(
      readRecentShape({
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => undefined,
      }),
    ).toEqual(EMPTY_RECENT_SHAPE);
  });

  it("is remembered for the next first frame, and a blocked store costs nothing but that", () => {
    const store = memoryStore();
    writeRecentShape(store, { rows: 3, more: true });
    expect(store.data.get(RAIL_RECENT_SHAPE_KEY)).toBe('{"rows":3,"more":true}');
    expect(readRecentShape(store)).toEqual({ rows: 3, more: true });
    expect(() => writeRecentShape(undefined, { rows: 1, more: false })).not.toThrow();
    expect(() =>
      writeRecentShape(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error("quota");
          },
        },
        { rows: 1, more: false },
      ),
    ).not.toThrow();
  });

  it("is not written again when it has not changed", () => {
    const store = memoryStore({ [RAIL_RECENT_SHAPE_KEY]: '{"rows":2,"more":false}' });
    let writes = 0;
    const counting = {
      getItem: store.getItem,
      setItem: (key: string, value: string) => {
        writes += 1;
        store.setItem(key, value);
      },
    };
    writeRecentShape(counting, { rows: 2, more: false });
    expect(writes).toBe(0);
    writeRecentShape(counting, { rows: 1, more: false });
    expect(writes).toBe(1);
  });
});

describe("RailRecentSkeleton", () => {
  it("draws the rows of the last load at the real row height, and a See all row when there was one", () => {
    const html = renderToStaticMarkup(<RailRecentSkeleton rows={3} more />);
    expect(html.match(/data-testid="rail-recent-skeleton-row"/g)).toHaveLength(3);
    expect(html).toContain('data-testid="rail-recent-skeleton-more"');
    // The rows are `h-7` (28 px) in the real block.
    expect(html.match(/\bh-7\b/g)?.length).toBe(4);
    expect(html).toContain('aria-hidden="true"');
  });

  it("draws nothing for an empty block, and no See all row without one", () => {
    expect(renderToStaticMarkup(<RailRecentSkeleton rows={0} more={false} />)).not.toContain("skeleton-row");
    expect(renderToStaticMarkup(<RailRecentSkeleton rows={2} more={false} />)).not.toContain("skeleton-more");
  });

  it("is still: no animation class", () => {
    expect(renderToStaticMarkup(<RailRecentSkeleton rows={4} more />)).not.toMatch(/animate-|pulse|shimmer/);
  });
});

describe("wiring", () => {
  const block = read("components/rail-recent-threads.tsx");
  const hook = read("lib/use-chat-threads.ts");

  it("the hook says when the first answer has come, whichever way it went", () => {
    expect(hook).toContain("loaded: boolean");
    expect(hook).toMatch(/setThreads\(rows\);\s*setError\(null\);\s*setLoaded\(true\);/);
    expect(hook).toMatch(/setError\(failure instanceof Error[^\n]*\n\s*setLoaded\(true\);/);
    expect(hook).toContain("return { threads, error, deletingId, removeThread, loaded };");
  });

  it("the block draws the skeleton until then, and remembers the shape once the rows are real", () => {
    expect(block).toContain("readRecentShape(browserShellModesStore())");
    expect(block).toContain("<RailRecentSkeleton rows={startShape.rows} more={startShape.more} />");
    expect(block).toContain("loaded");
    expect(block).toContain("writeRecentShape(browserShellModesStore(), shapeOfThreads(threads.length))");
  });

  it("keeps New chat in both frames, so only the rows below it come in", () => {
    const newChat = block.indexOf('data-testid="new-chat-link"', block.indexOf('data-testid="rail-thread-list"'));
    const skeleton = block.indexOf("<RailRecentSkeleton");
    expect(newChat).toBeGreaterThan(-1);
    expect(skeleton).toBeGreaterThan(newChat);
  });
});
