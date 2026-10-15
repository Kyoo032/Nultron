import { afterEach, describe, expect, it } from "vitest";
import { applyLocale, resetLocaleForTests } from "./i18n";
import { personName, shortPersonCode } from "./people-names";

afterEach(() => {
  resetLocaleForTests();
});

const UNNAMED = { userId: "0f1c2a3b-0000-4000-8000-00000000000d", name: null };

describe("the name a colleague is shown by", () => {
  it("is the name the host sent when there is one", () => {
    expect(personName({ userId: "u-ana", name: "Ana Putri" })).toBe("Ana Putri");
  });

  it("is the neutral label and a short code from the id when there is no name, in both locales", () => {
    expect(personName(UNNAMED)).toBe("Colleague 0F1C2A");
    applyLocale("id");
    expect(personName(UNNAMED)).toBe("Rekan 0F1C2A");
  });

  it("takes its short code from the id's letters and digits, six at most, in capitals", () => {
    expect(shortPersonCode("u-ana")).toBe("UANA");
    expect(shortPersonCode("0f1c2a3b-0000-4000-8000-00000000000d")).toBe("0F1C2A");
  });
});
