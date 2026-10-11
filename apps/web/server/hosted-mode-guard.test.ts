import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertHostedEnvComplete, assertHostedModeCoherent, HOSTED_MODE_REQUIRED } from "./hosted-mode-guard";

const serverSource = readFileSync(fileURLToPath(new URL("../server.ts", import.meta.url)), "utf8");
const composeSource = readFileSync(
  fileURLToPath(new URL("../../../webapp-deploy/compose.yml", import.meta.url)),
  "utf8",
);

describe("assertHostedModeCoherent", () => {
  it("refuses a production boot with no server flag", () => {
    expect(() => assertHostedModeCoherent({ NODE_ENV: "production" })).toThrow(/AGENTFORGE_SERVER/);
    expect(() => assertHostedModeCoherent({ NODE_ENV: "production" })).toThrow(HOSTED_MODE_REQUIRED);
  });

  it("refuses a production boot with a falsy server flag", () => {
    expect(() => assertHostedModeCoherent({ NODE_ENV: "production", AGENTFORGE_SERVER: "0" })).toThrow();
    expect(() => assertHostedModeCoherent({ NODE_ENV: "production", AGENTFORGE_SERVER: "false" })).toThrow();
    expect(() => assertHostedModeCoherent({ NODE_ENV: "production", AGENTFORGE_SERVER: "" })).toThrow();
    expect(() => assertHostedModeCoherent({ NODE_ENV: "production", AGENTFORGE_SERVER: "yes" })).toThrow();
  });

  it("allows the hosted deployment", () => {
    expect(() => assertHostedModeCoherent({ NODE_ENV: "production", AGENTFORGE_SERVER: "1" })).not.toThrow();
    expect(() => assertHostedModeCoherent({ NODE_ENV: "production", AGENTFORGE_SERVER: " TRUE " })).not.toThrow();
  });

  it("leaves webdev, the e2e run and a bare env alone", () => {
    expect(() => assertHostedModeCoherent({})).not.toThrow();
    expect(() => assertHostedModeCoherent({ NODE_ENV: "development" })).not.toThrow();
    expect(() => assertHostedModeCoherent({ NODE_ENV: "test" })).not.toThrow();
  });

  it("is not fooled by whitespace around the mode name", () => {
    expect(() => assertHostedModeCoherent({ NODE_ENV: " production " })).toThrow();
    expect(() => assertHostedModeCoherent({ NODE_ENV: " production ", AGENTFORGE_SERVER: "1" })).not.toThrow();
  });
});

describe("the guard is actually wired into the boot path", () => {
  it("server.ts calls it inside main()", () => {
    expect(serverSource).toContain("assertHostedModeCoherent(process.env)");
  });

  it("calls it before the listener is opened", () => {
    expect(serverSource.indexOf("assertHostedModeCoherent(process.env)")).toBeLessThan(
      serverSource.indexOf("server.listen("),
    );
  });
});

/**
 * SR-04. The rules themselves are `packages/host/src/hosted-env.ts` and are covered by
 * `hosted-env.test.ts` — thirty-two cases, one per variable and one per local mode. What belongs
 * here is the half that file cannot see: that the second guard is reached from this module and
 * actually runs at boot, beside the first one and ahead of `server.listen`.
 */
describe("the hosted environment check runs at the same boot site", () => {
  it("server.ts calls it inside main()", () => {
    expect(serverSource).toContain("assertHostedEnvComplete(process.env)");
  });

  it("calls it after the mode check and before the listener is opened", () => {
    const mode = serverSource.indexOf("assertHostedModeCoherent(process.env)");
    const env = serverSource.indexOf("assertHostedEnvComplete(process.env)");
    expect(mode).toBeGreaterThan(-1);
    expect(env).toBeGreaterThan(mode);
    expect(env).toBeLessThan(serverSource.indexOf("server.listen("));
  });

  it("refuses a hosted boot with nothing configured, naming the variables", () => {
    let message = "";
    try {
      assertHostedEnvComplete({ NODE_ENV: "production", AGENTFORGE_SERVER: "1" }, () => {});
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("AGENTFORGE_SECRETS_KEY");
    expect(message).toContain("AGENTFORGE_TRUSTED_ORIGINS");
    expect(message).toContain("AGENTFORGE_PORTAL_URL");
  });

  it("leaves webdev and the desktop alone, which is why it can sit on the boot path", () => {
    expect(() => assertHostedEnvComplete({}, () => {})).not.toThrow();
    expect(() => assertHostedEnvComplete({ NODE_ENV: "development" }, () => {})).not.toThrow();
  });
});

/**
 * SR-25. The two describes above prove the guards are called inside `main()` and ahead of
 * `server.listen(`, which is not early enough: `server.ts`'s imports are evaluated before `main()`
 * is called at all, and `@agentforge/db` creates the data dir, applies a queued wipe and opens
 * SQLite when it is imported. The guards therefore run from `server-env.ts`, the first import.
 *
 * `boot-order.test.ts` is the proof — it runs the real entry and inspects the disk. These are the
 * cheap structural checks beside it, so that a reorder fails here with a sentence rather than only
 * there with a 20-second spawn.
 */
describe("the guards also run from server-env.ts, ahead of the host and the database (SR-25)", () => {
  const envSource = readFileSync(fileURLToPath(new URL("../server-env.ts", import.meta.url)), "utf8");

  /** `import` statements only, so a comment that names a package is not mistaken for one. */
  function importSpecifiers(source: string): string[] {
    return [...source.matchAll(/^import\s+(?:[^;"]*?\sfrom\s+)?"([^"]+)";?$/gm)].map((match) => match[1] ?? "");
  }

  it("makes server-env the first import of server.ts", () => {
    expect(importSpecifiers(serverSource)[0]).toBe("./server-env");
  });

  it("imports the Node version check first, then the guard module, and nothing that reaches the database", () => {
    expect(importSpecifiers(envSource)).toEqual(["./lib/node-version-boot", "./server/hosted-mode-guard"]);
  });

  it("runs the mode check, then the environment check, at module scope", () => {
    const mode = envSource.indexOf("assertHostedModeCoherent(process.env);");
    const env = envSource.indexOf("assertHostedEnvComplete(process.env,");
    expect(mode).toBeGreaterThan(-1);
    expect(env).toBeGreaterThan(mode);
  });

  it("opts in to applying a queued wipe only after both guards have passed", () => {
    const optIn = envSource.indexOf('process.env.AGENTFORGE_APPLY_PENDING_RESET = "1"');
    expect(optIn).toBeGreaterThan(envSource.indexOf("assertHostedEnvComplete(process.env,"));
  });

  it("keeps the main() calls, which cover what a dotenv file supplies and print the warnings once", () => {
    expect(serverSource).toContain("assertHostedModeCoherent(process.env)");
    expect(serverSource).toContain("assertHostedEnvComplete(process.env)");
  });
});

describe("the hosted compose file pins the flag rather than relying on the optional .env", () => {
  it("sets AGENTFORGE_SERVER in the app service environment block", () => {
    expect(composeSource).toMatch(/^\s+AGENTFORGE_SERVER:\s*"1"\s*$/m);
  });

  it("still declares .env optional, which is why the pin has to be here", () => {
    expect(composeSource).toContain("required: false");
  });
});
