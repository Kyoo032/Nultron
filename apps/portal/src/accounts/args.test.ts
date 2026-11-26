import { describe, expect, it } from "vitest";
import { AccountArgsError, parseAccountArgs } from "./args";

describe("set-endpoint --key-stdin", () => {
  it("is a bare flag: the key is never an argument", () => {
    const command = parseAccountArgs([
      "set-endpoint",
      "--tenant",
      "acme",
      "--email",
      "person@acme.test",
      "--gateway-endpoint",
      "https://www.pusattokenai.com/v1",
      "--key-stdin",
    ]);
    expect(command).toMatchObject({ command: "set-endpoint", keyFromStdin: true });
  });

  it("never waits for a value: the next flag is not its argument", () => {
    const command = parseAccountArgs([
      "set-endpoint",
      "--tenant",
      "acme",
      "--email",
      "person@acme.test",
      "--key-stdin",
      "--gateway-endpoint",
      "https://www.pusattokenai.com/v1",
    ]);
    expect(command).toMatchObject({
      command: "set-endpoint",
      keyFromStdin: true,
      gatewayEndpoint: "https://www.pusattokenai.com/v1",
    });
  });

  it("refuses an inline value on the flag", () => {
    expect(() =>
      parseAccountArgs([
        "set-endpoint",
        "--tenant",
        "acme",
        "--email",
        "person@acme.test",
        "--gateway-endpoint",
        "https://www.pusattokenai.com/v1",
        "--key-stdin=sk-should-not-be-argv",
      ]),
    ).toThrow(AccountArgsError);
  });

  it("has no meaning next to --clear", () => {
    expect(() =>
      parseAccountArgs([
        "set-endpoint",
        "--tenant",
        "acme",
        "--email",
        "person@acme.test",
        "--clear",
        "--key-stdin",
      ]),
    ).toThrow(AccountArgsError);
  });
});
