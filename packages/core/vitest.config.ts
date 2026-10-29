import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The default 5 s fails the tests that read every source file whenever the machine is busy.
    testTimeout: 30_000,
  },
});
