import { describe, expect, it } from "vitest";
import { MIN_NODE_MAJOR, assertSupportedNode } from "./node-version";

/**
 * SH-001. better-sqlite3 13 needs Node 22 (its engines field says `>=22`), and on Node 20 loading
 * the addon segfaults with exit 139 and no message. The check runs before anything loads it, so a
 * Node 20 box gets one sentence instead. These cases run on any Node version: they call the pure
 * function with a string, never the real `process.version`.
 */

/** The message a refused version throws, or "" when the version is accepted. */
function refusalFor(version: string): string {
  try {
    assertSupportedNode(version);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("MIN_NODE_MAJOR", () => {
  it("is 22, the major that better-sqlite3 supports", () => {
    expect(MIN_NODE_MAJOR).toBe(22);
  });
});

describe("assertSupportedNode", () => {
  it("refuses Node 20 and names both the running version and the required major", () => {
    const message = refusalFor("v20.19.2");
    expect(message).toMatch(/v20\.19\.2/);
    expect(message).toMatch(/22/);
  });

  it("refuses Node 21 too, since only 22 and newer are supported", () => {
    expect(refusalFor("v21.7.3")).toMatch(/v21\.7\.3/);
  });

  it("accepts Node 22 and newer", () => {
    expect(refusalFor("v22.0.0")).toBe("");
    expect(refusalFor("v24.1.0")).toBe("");
  });

  it("refuses a value it cannot read, with the unreadable message and not the too-old one", () => {
    for (const garbage of ["garbage", "", "vNaN.0.0"]) {
      const message = refusalFor(garbage);
      expect(message).toMatch(/Could not read/);
      expect(message).not.toMatch(/it was started with/);
    }
  });
});
