import { describe, expect, it } from "vitest";
import { localMediaId } from "@agentforge/core";

describe("inline local media helpers", () => {
  it("extracts the media id the gateway tried to download from localhost", () => {
    expect(localMediaId("http://127.0.0.1:3000/api/v1/media/f66a438a-781a-478b-8e67-c19be7771c20/file")).toBe(
      "f66a438a-781a-478b-8e67-c19be7771c20",
    );
  });
});
