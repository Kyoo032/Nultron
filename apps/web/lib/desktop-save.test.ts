/**
 * What the renderer does with the shell's answer to a save.
 *
 * The shell (`host:save-bytes` in apps/desktop/main.cjs) answers `{ ok: true }`, or `{ ok: false, reason }`
 * with `forbidden`, `bad-filename`, `too-large`, `canceled` or `write-failed`. Until now the renderer
 * dropped the answer, so a disk that refused the write looked like a download that worked. A closed
 * dialog (`canceled`) is the person's choice and stays silent; every other refusal becomes a sentence in
 * their language.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DesktopSaveError, saveFailureMessage, throwIfSaveFailed } from "./desktop-save";
import { applyLocale, resetLocaleForTests } from "./i18n";

beforeEach(() => {
  applyLocale("en");
});

afterEach(() => {
  resetLocaleForTests();
});

describe("throwIfSaveFailed", () => {
  it("lets a save that worked, a closed dialog and a shell that said nothing go by", () => {
    expect(() => throwIfSaveFailed({ ok: true })).not.toThrow();
    expect(() => throwIfSaveFailed({ ok: false, reason: "canceled" })).not.toThrow();
    // An older shell answered nothing at all: there is nothing to say it failed.
    expect(() => throwIfSaveFailed(undefined)).not.toThrow();
  });

  it("throws a DesktopSaveError with the shell's reason when the write failed", () => {
    expect.assertions(3);
    try {
      throwIfSaveFailed({ ok: false, reason: "write-failed" });
    } catch (error) {
      expect(error).toBeInstanceOf(DesktopSaveError);
      expect((error as DesktopSaveError).reason).toBe("write-failed");
      expect((error as DesktopSaveError).message).toMatch(/could not be written/i);
    }
  });

  it("says a file too large to save is too large, and any other refusal in one plain sentence", () => {
    const say = (reason: string | undefined) => {
      try {
        throwIfSaveFailed({ ok: false, reason });
      } catch (error) {
        return (error as Error).message;
      }
      return "";
    };
    expect(say("too-large")).toMatch(/too large/i);
    for (const reason of ["forbidden", "bad-filename", "something-new", undefined]) {
      expect(say(reason), String(reason)).toBe("The file could not be saved. Try again.");
    }
  });

  it("writes the sentence in the owner's language", () => {
    applyLocale("id");
    try {
      throwIfSaveFailed({ ok: false, reason: "write-failed" });
    } catch (error) {
      expect((error as Error).message).toMatch(/tidak bisa disimpan/i);
      return;
    }
    throw new Error("expected a refusal");
  });
});

describe("saveFailureMessage", () => {
  it("is the sentence for a save refusal and nothing for any other error", () => {
    expect(saveFailureMessage(new DesktopSaveError("write-failed", "Could not write it."))).toBe("Could not write it.");
    expect(saveFailureMessage(new Error("Artifact not found"))).toBeNull();
    expect(saveFailureMessage("nope")).toBeNull();
    expect(saveFailureMessage(null)).toBeNull();
  });
});
