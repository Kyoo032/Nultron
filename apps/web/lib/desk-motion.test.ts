import { describe, expect, it } from "vitest";
import {
  attachDeskMotion,
  type DeskLayer,
  type DeskMotionEnv,
  type DeskShape,
  type DeskSurface,
  GRID_SHIFT_PX,
  GRID_STEP_MS,
  MEASURE_TTL_MS,
  POINTER_ATTR,
  repelOffset,
  SHAPE_PUSH_PX,
  SHAPE_REACH_PX,
  WRITE_INTERVAL_MS,
} from "./desk-motion";

/**
 * The desk's pointer rules run against a fake canvas and a fake browser, because the environment is node.
 * What is asserted is what the page does with them: which listeners exist, how often a burst of pointer
 * movement writes, which shapes are touched, and what a press does. The live drive is in
 * `.cursor/skills/verify-agentforge/features/chat.md`, "Desk background".
 */

type Listener = (event: Event) => void;
type ShapeSpec = { x: number; y: number; size?: number; hidden?: boolean };

function fakeShape(spec: ShapeSpec, container: { left: number; top: number }) {
  const properties = new Map<string, string>();
  const size = spec.size ?? 20;
  let writes = 0;
  const shape: DeskShape = {
    offsetLeft: spec.x,
    offsetTop: spec.y,
    offsetWidth: spec.hidden ? 0 : size,
    offsetHeight: spec.hidden ? 0 : size,
    offsetParent: { getBoundingClientRect: () => ({ ...container, width: 200, height: 100 }) },
    style: {
      setProperty: (name, value) => {
        writes += 1;
        properties.set(name, value);
      },
      removeProperty: (name) => void properties.delete(name),
    },
  };
  return { shape, properties, writes: () => writes };
}

function fakeDesk(options: { rect?: { left: number; top: number; width: number; height: number }; shapes?: ShapeSpec[] } = {}) {
  const rect = options.rect ?? { left: 100, top: 50, width: 400, height: 300 };
  const listeners = new Map<string, Listener>();
  const captured = new Map<string, boolean>();
  const attributes = new Map<string, string>();
  const properties = new Map<string, string>();
  let rectReads = 0;
  let shapeQueries = 0;
  // The shapes sit in a container at the canvas' top left corner.
  const container = { left: rect.left, top: rect.top };
  const shapes = (options.shapes ?? []).map((spec) => fakeShape(spec, container));
  const layer: DeskLayer = {
    style: {
      setProperty: (name, value) => void properties.set(name, value),
      removeProperty: (name) => void properties.delete(name),
    },
    setAttribute: (name, value) => void attributes.set(name, value),
    removeAttribute: (name) => void attributes.delete(name),
  };
  const desk: DeskSurface = {
    getBoundingClientRect: () => {
      rectReads += 1;
      return rect;
    },
    addEventListener: (type, listener, opts) => {
      listeners.set(type, listener);
      captured.set(type, opts?.capture === true);
    },
    removeEventListener: (type, listener) => {
      if (listeners.get(type) === listener) {
        listeners.delete(type);
        captured.delete(type);
      }
    },
    querySelectorAll: () => {
      shapeQueries += 1;
      return shapes.map((entry) => entry.shape);
    },
  };
  const fire = (type: string, event: object = {}) => (listeners.get(type) as ((e: object) => void) | undefined)?.(event);
  const move = (clientX: number, clientY: number, pointerType = "mouse") => fire("pointermove", { clientX, clientY, pointerType });
  const press = (clientX: number, clientY: number, extra: object = {}) =>
    fire("pointerdown", { clientX, clientY, target: { tag: "bare" }, isPrimary: true, button: 0, ...extra });
  return {
    desk,
    layer,
    rect,
    listeners,
    captured,
    attributes,
    properties,
    shapes,
    move,
    press,
    leave: () => fire("pointerleave"),
    scroll: () => fire("scroll"),
    rectReads: () => rectReads,
    shapeQueries: () => shapeQueries,
  };
}

type Query = { matches: boolean; handlers: Set<() => void>; fire: () => void };

function fakeEnv(options: { reduced?: boolean; fine?: boolean; paused?: boolean; background?: boolean } = {}) {
  const queries = new Map<string, Query>();
  const query = (text: string, matches: boolean) => {
    const handlers = new Set<() => void>();
    const entry: Query = {
      matches,
      handlers,
      fire: () => {
        for (const handler of handlers) {
          handler();
        }
      },
    };
    queries.set(text, entry);
    return entry;
  };
  const reduced = query("(prefers-reduced-motion: reduce)", options.reduced ?? false);
  const fine = query("(hover: hover) and (pointer: fine)", options.fine ?? true);

  const frames: (() => void)[] = [];
  let cancelled = 0;
  let clock = 0;
  const state = { paused: options.paused ?? false, background: options.background ?? true };
  const rings: { x: number; y: number }[] = [];
  const asked: { target: unknown; x: number; y: number }[] = [];
  let disposed = 0;

  const env: DeskMotionEnv = {
    matchMedia: (text) => {
      const entry = queries.get(text);
      if (!entry) {
        throw new Error(`unexpected media query ${text}`);
      }
      return {
        get matches() {
          return entry.matches;
        },
        addEventListener: (_type, listener) => void entry.handlers.add(listener),
        removeEventListener: (_type, listener) => void entry.handlers.delete(listener),
      };
    },
    requestAnimationFrame: (callback) => frames.push(callback),
    cancelAnimationFrame: () => {
      cancelled += 1;
    },
    now: () => clock,
    paused: () => state.paused,
    isBackground: (target, x, y) => {
      asked.push({ target, x, y });
      return state.background;
    },
    ripple: (x, y) => void rings.push({ x, y }),
    dispose: () => {
      disposed += 1;
    },
  };

  return {
    env,
    reduced,
    fine,
    state,
    rings,
    asked,
    frames: () => frames.length,
    runFrame: () => frames.shift()?.(),
    cancelled: () => cancelled,
    disposed: () => disposed,
    setNow: (value: number) => {
      clock = value;
    },
  };
}

describe("repelOffset", () => {
  it("pushes a shape directly away from the pointer", () => {
    const right = repelOffset(40, 0);
    expect(right.x).toBeGreaterThan(0);
    expect(right.y).toBeCloseTo(0, 6);
    const up = repelOffset(0, -40);
    expect(up.y).toBeLessThan(0);
    expect(up.x).toBeCloseTo(0, 6);
    const diagonal = repelOffset(-30, 30);
    expect(diagonal.x).toBeLessThan(0);
    expect(diagonal.y).toBeGreaterThan(0);
  });

  it("is zero at and beyond the reach, and never more than the push", () => {
    expect(repelOffset(SHAPE_REACH_PX, 0)).toEqual({ x: 0, y: 0 });
    expect(repelOffset(300, 300)).toEqual({ x: 0, y: 0 });
    const close = repelOffset(0.001, 0);
    expect(Math.hypot(close.x, close.y)).toBeLessThanOrEqual(SHAPE_PUSH_PX);
  });

  it("falls off the further the shape is", () => {
    const near = Math.hypot(...Object.values(repelOffset(20, 0)));
    const mid = Math.hypot(...Object.values(repelOffset(70, 0)));
    const far = Math.hypot(...Object.values(repelOffset(120, 0)));
    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
  });

  it("sends a shape exactly under the pointer the same way every time", () => {
    const first = repelOffset(0, 0);
    expect(first).toEqual(repelOffset(0, 0));
    expect(Math.hypot(first.x, first.y)).toBeCloseTo(SHAPE_PUSH_PX, 6);
  });
});

describe("attachDeskMotion: binding", () => {
  it("binds movement, leaving, scrolling and presses on a fine pointer", () => {
    const { desk, layer, listeners, captured } = fakeDesk();
    attachDeskMotion(desk, layer, fakeEnv().env);
    expect([...listeners.keys()].sort()).toEqual(["pointerdown", "pointerleave", "pointermove", "scroll"]);
    expect(captured.get("scroll")).toBe(true);
  });

  it("binds nothing under reduced motion", () => {
    const { desk, layer, listeners, properties } = fakeDesk();
    attachDeskMotion(desk, layer, fakeEnv({ reduced: true }).env);
    expect(listeners.size).toBe(0);
    expect(properties.size).toBe(0);
  });

  it("keeps only the tap ring on a coarse pointer", () => {
    const { desk, layer, listeners } = fakeDesk();
    attachDeskMotion(desk, layer, fakeEnv({ fine: false }).env);
    expect([...listeners.keys()]).toEqual(["pointerdown"]);
  });

  it("follows the preference when it changes while mounted", () => {
    const { desk, layer, listeners, properties, move } = fakeDesk();
    const sim = fakeEnv();
    attachDeskMotion(desk, layer, sim.env);
    move(300, 150);
    sim.runFrame();
    expect(properties.get("--pointer-x")).not.toBeUndefined();

    sim.reduced.matches = true;
    sim.reduced.fire();
    expect(listeners.size).toBe(0);
    expect(properties.size).toBe(0);

    sim.reduced.matches = false;
    sim.reduced.fire();
    expect(listeners.has("pointermove")).toBe(true);
    expect(listeners.has("pointerdown")).toBe(true);
  });

  it("drops the move listener but keeps the ring when the pointer stops being fine", () => {
    const { desk, layer, listeners } = fakeDesk();
    const sim = fakeEnv();
    attachDeskMotion(desk, layer, sim.env);
    sim.fine.matches = false;
    sim.fine.fire();
    expect([...listeners.keys()]).toEqual(["pointerdown"]);
  });
});

describe("attachDeskMotion: the light and the grid", () => {
  it("coalesces a burst of moves into one frame and one write of the latest point, to a whole pixel", () => {
    const { desk, layer, properties, attributes, move } = fakeDesk({
      rect: { left: 100, top: 50, width: 400, height: 300 },
    });
    const sim = fakeEnv();
    attachDeskMotion(desk, layer, sim.env);
    for (let i = 0; i < 40; i += 1) {
      move(100 + i + 0.4, 100);
    }
    expect(sim.frames()).toBe(1);
    sim.runFrame();
    expect(properties.get("--pointer-x")).toBe("39px");
    expect(properties.get("--pointer-y")).toBe("50px");
    expect(attributes.get(POINTER_ATTR)).toBe("in");
  });

  it("writes the light at most every WRITE_INTERVAL_MS, and keeps the newest point while it waits", () => {
    const { desk, layer, properties, move } = fakeDesk({ rect: { left: 0, top: 0, width: 400, height: 300 } });
    const sim = fakeEnv();
    attachDeskMotion(desk, layer, sim.env);
    move(10, 10);
    sim.runFrame();
    expect(properties.get("--pointer-x")).toBe("10px");

    sim.setNow(WRITE_INTERVAL_MS - 1);
    move(50, 10);
    move(60, 10);
    sim.runFrame(); // too soon: asks for a later frame and writes nothing
    expect(properties.get("--pointer-x")).toBe("10px");
    expect(sim.frames()).toBeGreaterThan(0);

    sim.setNow(WRITE_INTERVAL_MS);
    sim.runFrame();
    expect(properties.get("--pointer-x")).toBe("60px");
  });

  it("steps the grid one pixel every GRID_STEP_MS toward the pointer's side, and no further than GRID_SHIFT_PX", () => {
    const { desk, layer, properties, move } = fakeDesk({ rect: { left: 0, top: 0, width: 400, height: 300 } });
    const sim = fakeEnv();
    attachDeskMotion(desk, layer, sim.env);
    move(400, 300); // the bottom right corner: unit (1, 1)
    const seen: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      sim.setNow(i * GRID_STEP_MS);
      sim.runFrame();
      seen.push(Number(properties.get("--grid-x")));
    }
    expect(seen.slice(0, GRID_SHIFT_PX)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(Math.max(...seen)).toBe(GRID_SHIFT_PX);
    expect(sim.frames()).toBe(0); // arrived: nothing left to schedule
  });

  it("does not step the grid sooner than GRID_STEP_MS, however many frames come", () => {
    const { desk, layer, properties, move } = fakeDesk({ rect: { left: 0, top: 0, width: 400, height: 300 } });
    const sim = fakeEnv();
    attachDeskMotion(desk, layer, sim.env);
    move(400, 300);
    sim.runFrame();
    expect(properties.get("--grid-x")).toBe("1");
    for (let at = 1; at < GRID_STEP_MS; at += 8) {
      sim.setNow(at);
      sim.runFrame();
    }
    expect(properties.get("--grid-x")).toBe("1");
    sim.setNow(GRID_STEP_MS);
    sim.runFrame();
    expect(properties.get("--grid-x")).toBe("2");
  });

  it("asks for no frame once the grid has arrived, so a still pointer costs nothing", () => {
    const { desk, layer, move } = fakeDesk({ rect: { left: 0, top: 0, width: 400, height: 300 } });
    const sim = fakeEnv();
    attachDeskMotion(desk, layer, sim.env);
    move(200, 150); // the centre: unit (0, 0), so the grid has nowhere to go
    sim.runFrame();
    expect(sim.frames()).toBe(0);
  });

  it("writes only what changed", () => {
    const { desk, layer, move } = fakeDesk({ rect: { left: 0, top: 0, width: 400, height: 300 } });
    const writes: string[] = [];
    const style = layer.style.setProperty;
    layer.style.setProperty = (name, value) => {
      writes.push(name);
      style(name, value);
    };
    const sim = fakeEnv();
    attachDeskMotion(desk, layer, sim.env);
    move(200, 150);
    sim.runFrame();
    writes.length = 0;
    sim.setNow(100);
    move(200.4, 150.4); // the same whole pixel
    sim.runFrame();
    expect(writes).toEqual([]);
  });

  it("measures the canvas and the shapes once per burst of movement, not once per event", () => {
    const { desk, layer, move, rectReads, shapeQueries } = fakeDesk({ shapes: [{ x: 10, y: 10 }] });
    const sim = fakeEnv();
    attachDeskMotion(desk, layer, sim.env);
    for (let step = 0; step < 5; step += 1) {
      sim.setNow(step * WRITE_INTERVAL_MS);
      move(150 + step, 80);
      sim.runFrame();
    }
    expect(rectReads()).toBe(1); // the canvas, once
    expect(shapeQueries()).toBe(1);
    sim.setNow(MEASURE_TTL_MS + 100);
    move(150, 80);
    sim.runFrame();
    expect(shapeQueries()).toBe(2);
  });

  it("measures again after a scroll, because the shapes moved under a still pointer", () => {
    const { desk, layer, move, scroll, shapeQueries } = fakeDesk({ shapes: [{ x: 10, y: 10 }] });
    const sim = fakeEnv();
    attachDeskMotion(desk, layer, sim.env);
    move(150, 80);
    sim.runFrame();
    expect(shapeQueries()).toBe(1);
    sim.setNow(WRITE_INTERVAL_MS);
    scroll();
    move(152, 80);
    sim.runFrame();
    expect(shapeQueries()).toBe(2);
  });

  it("ignores touch pointers", () => {
    const { desk, layer, move, properties } = fakeDesk();
    const sim = fakeEnv();
    attachDeskMotion(desk, layer, sim.env);
    move(200, 100, "touch");
    expect(sim.frames()).toBe(0);
    expect(properties.size).toBe(0);
  });

  it("does no work while the window is paused: no frame is asked for, and a queued one writes nothing", () => {
    const { desk, layer, move, properties, rectReads } = fakeDesk();
    const sim = fakeEnv({ paused: true });
    attachDeskMotion(desk, layer, sim.env);
    move(200, 100);
    expect(sim.frames()).toBe(0);

    sim.state.paused = false;
    move(200, 100);
    expect(sim.frames()).toBe(1);
    sim.state.paused = true;
    sim.runFrame();
    expect(properties.size).toBe(0);
    expect(rectReads()).toBe(0);
  });

  it("puts the light out when the pointer leaves, and walks the grid home one pixel a frame", () => {
    const { desk, layer, attributes, properties, move, leave } = fakeDesk({
      rect: { left: 0, top: 0, width: 400, height: 300 },
    });
    const sim = fakeEnv();
    attachDeskMotion(desk, layer, sim.env);
    move(400, 300);
    for (let i = 0; i < 4; i += 1) {
      sim.setNow(i * GRID_STEP_MS);
      sim.runFrame();
    }
    expect(attributes.get(POINTER_ATTR)).toBe("in");
    expect(properties.get("--grid-x")).toBe("4");

    leave();
    expect(attributes.has(POINTER_ATTR)).toBe(false);
    const home: number[] = [];
    for (let i = 4; i < 12 && sim.frames() > 0; i += 1) {
      sim.setNow(i * GRID_STEP_MS);
      sim.runFrame();
      home.push(Number(properties.get("--grid-x")));
    }
    expect(home).toEqual([3, 2, 1, 0]);
    expect(sim.frames()).toBe(0);
  });
});

describe("attachDeskMotion: shapes", () => {
  const field = { rect: { left: 0, top: 0, width: 800, height: 600 } };

  it("pushes a shape near the pointer away from it, and leaves a far one alone", () => {
    const { desk, layer, shapes, move } = fakeDesk({
      ...field,
      // Centres at (110, 110) and (700, 500); the pointer is at (90, 100).
      shapes: [
        { x: 100, y: 100 },
        { x: 690, y: 490 },
      ],
    });
    const sim = fakeEnv();
    attachDeskMotion(desk, layer, sim.env);
    move(90, 100);
    sim.runFrame();
    const near = shapes[0];
    expect(Number(near?.properties.get("--rx"))).toBeGreaterThan(0);
    expect(Number(near?.properties.get("--ry"))).toBeGreaterThan(0);
    expect(shapes[1]?.writes()).toBe(0);
  });

  it("does not write a push that has not changed", () => {
    const { desk, layer, shapes, move } = fakeDesk({ ...field, shapes: [{ x: 100, y: 100 }] });
    const sim = fakeEnv();
    attachDeskMotion(desk, layer, sim.env);
    move(90, 100);
    sim.runFrame();
    const first = shapes[0]?.writes() ?? 0;
    sim.setNow(100);
    move(90, 100);
    sim.runFrame();
    expect(shapes[0]?.writes()).toBe(first);
  });

  it("sends a shape back to rest once the pointer moves beyond its reach", () => {
    const { desk, layer, shapes, move } = fakeDesk({ ...field, shapes: [{ x: 100, y: 100 }] });
    const sim = fakeEnv();
    attachDeskMotion(desk, layer, sim.env);
    move(90, 100);
    sim.runFrame();
    expect(Number(shapes[0]?.properties.get("--rx"))).not.toBe(0);
    sim.setNow(100);
    move(700, 500);
    sim.runFrame();
    expect(shapes[0]?.properties.get("--rx")).toBe("0.00");
    expect(shapes[0]?.properties.get("--ry")).toBe("0.00");
  });

  it("skips a shape that is not drawn", () => {
    const { desk, layer, shapes, move } = fakeDesk({ ...field, shapes: [{ x: 100, y: 100, hidden: true }] });
    const sim = fakeEnv();
    attachDeskMotion(desk, layer, sim.env);
    move(110, 110);
    sim.runFrame();
    expect(shapes[0]?.writes()).toBe(0);
  });

  it("resets a pushed shape when the pointer leaves", () => {
    const { desk, layer, shapes, move, leave } = fakeDesk({ ...field, shapes: [{ x: 100, y: 100 }] });
    const sim = fakeEnv();
    attachDeskMotion(desk, layer, sim.env);
    move(90, 100);
    sim.runFrame();
    leave();
    expect(shapes[0]?.properties.get("--rx")).toBe("0");
    expect(shapes[0]?.properties.get("--ry")).toBe("0");
  });
});

describe("attachDeskMotion: presses", () => {
  it("draws a ring where an empty-desk press landed, in the desk's own coordinates", () => {
    const { desk, layer, press } = fakeDesk({ rect: { left: 100, top: 50, width: 400, height: 300 } });
    const sim = fakeEnv({ background: true });
    attachDeskMotion(desk, layer, sim.env);
    press(250, 180);
    expect(sim.rings).toEqual([{ x: 150, y: 130 }]);
    expect(sim.asked).toEqual([{ target: { tag: "bare" }, x: 250, y: 180 }]);
  });

  it("draws nothing for a press on content", () => {
    const { desk, layer, press } = fakeDesk();
    const sim = fakeEnv({ background: false });
    attachDeskMotion(desk, layer, sim.env);
    press(250, 180);
    expect(sim.rings).toEqual([]);
  });

  it("ignores a secondary button and a non-primary pointer", () => {
    const { desk, layer, press } = fakeDesk();
    const sim = fakeEnv({ background: true });
    attachDeskMotion(desk, layer, sim.env);
    press(250, 180, { button: 2 });
    press(250, 180, { isPrimary: false });
    expect(sim.rings).toEqual([]);
    expect(sim.asked).toEqual([]);
  });

  it("does no work while the window is paused", () => {
    const { desk, layer, press } = fakeDesk();
    const sim = fakeEnv({ background: true, paused: true });
    attachDeskMotion(desk, layer, sim.env);
    press(250, 180);
    expect(sim.rings).toEqual([]);
    expect(sim.asked).toEqual([]);
  });

  it("rings for a finger, which has no move listener", () => {
    const { desk, layer, press, listeners } = fakeDesk();
    const sim = fakeEnv({ background: true, fine: false });
    attachDeskMotion(desk, layer, sim.env);
    expect(listeners.has("pointermove")).toBe(false);
    press(250, 180, { pointerType: "touch" });
    expect(sim.rings).toHaveLength(1);
  });
});

describe("attachDeskMotion: teardown", () => {
  it("removes every listener, property and attribute it added, cancels its frame and cleans up the environment", () => {
    const { desk, layer, listeners, attributes, properties, shapes, move } = fakeDesk({
      rect: { left: 0, top: 0, width: 800, height: 600 },
      shapes: [{ x: 100, y: 100 }],
    });
    const sim = fakeEnv();
    const detach = attachDeskMotion(desk, layer, sim.env);
    move(90, 100);
    sim.runFrame();
    move(700, 500);
    expect(attributes.size).toBeGreaterThan(0);
    detach();

    expect(listeners.size).toBe(0);
    expect(attributes.size).toBe(0);
    expect(properties.size).toBe(0);
    expect(shapes[0]?.properties.size).toBe(0);
    expect(sim.cancelled()).toBeGreaterThan(0);
    expect(sim.disposed()).toBe(1);
    expect(sim.reduced.handlers.size).toBe(0);
    expect(sim.fine.handlers.size).toBe(0);
  });
});
