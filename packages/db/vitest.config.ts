import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // first-desk-modes.test.ts walks every source file and takes 5.2 s alone, over the default 5 s.
    testTimeout: 30_000,
    passWithNoTests: true,
  },
});
