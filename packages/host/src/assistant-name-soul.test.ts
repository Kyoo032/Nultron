import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PRODUCT_NAME } from "@agentforge/core";
import { defaultSoul } from "./knowledge-soul";

/**
 * Who answers in the default agent's chat is the brand's own character (owner, 2026-10-09). The
 * Soul is the only place the model is told its name, so the name there follows the same setting the
 * screen reads. The names below are made up.
 */
const KEYS = ["AGENTFORGE_PRODUCT_NAME", "AGENTFORGE_ASSISTANT_NAME"] as const;

afterEach(() => {
  for (const key of KEYS) {
    delete process.env[key];
  }
});

describe("the Soul's name", () => {
  it("is the product's name when the brand names no character, exactly as before", () => {
    const soul = defaultSoul();
    expect(soul.name).toBe(DEFAULT_PRODUCT_NAME);
    expect(soul.rules).toContain(`Your name is ${DEFAULT_PRODUCT_NAME}. Introduce yourself by that name and no other.`);
  });

  it("is the character's name when the brand sets one, while the product keeps its own name", () => {
    process.env.AGENTFORGE_PRODUCT_NAME = "Acme Desk";
    process.env.AGENTFORGE_ASSISTANT_NAME = "Mika";
    const soul = defaultSoul();
    expect(soul.name).toBe("Mika");
    expect(soul.rules).toContain("Your name is Mika. Introduce yourself by that name and no other.");
    // What it runs inside is still the product.
    expect(soul.role).toContain("The Acme Desk desk on this computer.");
    expect(soul.rules.join("\n")).toContain("Acme Desk is a local desk app");
  });

  it("follows the flavor's product name when no character is set", () => {
    process.env.AGENTFORGE_PRODUCT_NAME = "Acme Desk";
    expect(defaultSoul().name).toBe("Acme Desk");
  });
});
