import { defineConfig } from "vitest/config";

/**
 * The voice eval lives outside `packages/host/src`, which the package's own vitest config scopes itself to.
 * Its parts still have to be tested, so it gets its own root:
 *
 *   cd packages/host && npx vitest run --root eval/voice
 *
 * Nothing here reaches a desk or a gateway. The tests drive a fake host on a loopback port that the test
 * itself starts (`fake-host.ts`); `test-setup.ts` makes a stray call to anywhere else throw.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["*.test.ts"],
    setupFiles: ["./test-setup.ts"],
    // A case runs a whole turn at several times real speed, and the machine can be busy.
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Timing tests lose their margin when every core is busy: four workers at most.
    poolOptions: { forks: { maxForks: 4 } },
  },
});
