import { describe, expect, it } from "vitest";
import { MAX_EVEN_KEYS, evenKeys, isPositionKey, keyBetween } from "./fractional";

describe("keyBetween", () => {
  it("starts an empty column in the middle of the alphabet", () => {
    expect(keyBetween(null, null)).toBe("V");
  });

  it("places before, after and between known keys", () => {
    expect(keyBetween("V", null)).toBe("W");
    expect(keyBetween("z", null)).toBe("z1");
    expect(keyBetween(null, "V")).toBe("G");
    expect(keyBetween("V", "W")).toBe("VV");
    expect(keyBetween("a", "a1")).toBe("a0V");
  });

  it("refuses keys out of order or malformed", () => {
    expect(() => keyBetween("b", "a")).toThrow("out of order");
    expect(() => keyBetween("a", "a")).toThrow("out of order");
    expect(() => keyBetween("a0", null)).toThrow("invalid position key");
    expect(() => keyBetween("a-b", null)).toThrow("invalid position key");
  });

  it("keeps a column sorted through a thousand random inserts", () => {
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const keys: string[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const at = Math.floor(random() * (keys.length + 1));
      const key = keyBetween(keys[at - 1] ?? null, keys[at] ?? null);
      expect(isPositionKey(key)).toBe(true);
      keys.splice(at, 0, key);
    }
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps keys short when cards are always appended", () => {
    let last: string | null = null;
    for (let i = 0; i < 500; i += 1) {
      last = keyBetween(last, null);
    }
    expect((last ?? "").length).toBeLessThan(15);
  });
});

describe("evenKeys (the rebalance of a column, security review of K0, M1)", () => {
  it("hands out short, valid keys in order, with room between neighbours", () => {
    for (const count of [1, 2, 61, 62, 63, 500, 5_000]) {
      const keys = evenKeys(count);
      expect(keys).toHaveLength(count);
      expect(keys.every(isPositionKey), String(count)).toBe(true);
      expect([...keys].sort(), String(count)).toEqual(keys);
      expect(new Set(keys).size).toBe(count);
      expect(Math.max(...keys.map((key) => key.length))).toBeLessThanOrEqual(5);
      for (let at = 1; at < keys.length; at += 1) {
        expect(() => keyBetween(keys[at - 1], keys[at])).not.toThrow();
      }
    }
  });

  it("leaves room before the first key and after the last", () => {
    const keys = evenKeys(10);
    expect(keyBetween(null, keys[0]) < keys[0]).toBe(true);
    expect(keyBetween(keys[9], null) > keys[9]).toBe(true);
  });

  it("refuses a count it cannot serve", () => {
    expect(() => evenKeys(0)).toThrow(RangeError);
    expect(() => evenKeys(1.5)).toThrow(RangeError);
    expect(() => evenKeys(MAX_EVEN_KEYS + 1)).toThrow(RangeError);
  });
});
