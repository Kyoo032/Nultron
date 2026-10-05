import { describe, expect, it } from "vitest";
import { pastSessionsTool } from "./session-tools";

describe("past_sessions", () => {
  it("is user_content: it reads the owner's earlier chats, so its answer is scanned and counts as private material", () => {
    expect(pastSessionsTool.key).toBe("past_sessions");
    expect(pastSessionsTool.trust).toBe("user_content");
  });
});
