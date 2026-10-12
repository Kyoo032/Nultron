import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PRODUCT_NAME, resolvedAssistantName, resolvedProductName } from "./gateway";

/**
 * The default virtual agent is the brand's own character (owner, 2026-10-09): the public product's
 * carries the product's name, and a white label whose character has another name sets it beside its
 * product name. The names used below are made up; no brand's character is typed into the code.
 */
const KEYS = ["AGENTFORGE_PRODUCT_NAME", "AGENTFORGE_ASSISTANT_NAME"] as const;

describe("the default agent's name", () => {
  const previous: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of KEYS) {
      previous[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  });

  it("is the product's own name when the brand names no character", () => {
    expect(resolvedAssistantName()).toBe(DEFAULT_PRODUCT_NAME);
    expect(resolvedAssistantName()).toBe(resolvedProductName());
  });

  it("follows a flavor's product name when that is all the flavor sets", () => {
    process.env.AGENTFORGE_PRODUCT_NAME = "Acme Desk";
    expect(resolvedAssistantName()).toBe("Acme Desk");
  });

  it("is the character's name when the brand sets one, and the product keeps its own", () => {
    process.env.AGENTFORGE_PRODUCT_NAME = "Acme Desk";
    process.env.AGENTFORGE_ASSISTANT_NAME = " Mika ";
    expect(resolvedAssistantName()).toBe("Mika");
    expect(resolvedProductName()).toBe("Acme Desk");
  });

  it("reads a blank setting as no setting", () => {
    process.env.AGENTFORGE_ASSISTANT_NAME = "   ";
    expect(resolvedAssistantName()).toBe(DEFAULT_PRODUCT_NAME);
  });
});
