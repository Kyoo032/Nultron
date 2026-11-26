import { describe, expect, it } from "vitest";
import { ApiError } from "../errors";
import { resolvePinnedDestination } from "./tcp-pin";
import type { DestinationAllowlist } from "./safe-fetch";

const publicRule: DestinationAllowlist = (host) =>
  host === "db.example.com" || host === "minio.internal" ? { allowPrivate: false } : null;
const privateRule: DestinationAllowlist = (host) => (host === "minio.internal" ? { allowPrivate: true } : null);
const lookup = (addrs: string[]) => async () => addrs.map((address) => ({ address }));

describe("resolvePinnedDestination", () => {
  it("refuses a host:port with no allowlist row before resolving", async () => {
    let resolved = false;
    await expect(
      resolvePinnedDestination("evil.example.com", 443, {
        allowlist: () => null,
        lookupImpl: async () => {
          resolved = true;
          return [{ address: "1.1.1.1" }];
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_destination" });
    expect(resolved).toBe(false);
  });

  it("pins to the verified addresses and serves only that host", async () => {
    const pinned = await resolvePinnedDestination("db.example.com", 5432, {
      allowlist: publicRule,
      lookupImpl: lookup(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]),
    });
    expect(pinned.address).toBe("93.184.216.34");
    const result = await new Promise((resolve, reject) =>
      pinned.lookup("db.example.com", {}, (err, address) => (err ? reject(err) : resolve(address))),
    );
    expect(result).toBe("93.184.216.34");
    await expect(
      new Promise((resolve, reject) =>
        pinned.lookup("other.example.com", {}, (err, address) => (err ? reject(err) : resolve(address))),
      ),
    ).rejects.toMatchObject({ code: "ENOTFOUND" });
  });

  it("refuses a rebinded answer that resolves private after the allowlist check", async () => {
    await expect(
      resolvePinnedDestination("db.example.com", 5432, {
        allowlist: publicRule,
        lookupImpl: lookup(["10.0.0.7"]),
      }),
    ).rejects.toMatchObject({ code: "invalid_endpoint" });
  });

  it("refuses a literal private IP unless the entry allows private", async () => {
    await expect(
      resolvePinnedDestination("minio.internal", 9000, {
        allowlist: privateRule,
        lookupImpl: lookup(["10.1.2.3"]),
      }),
    ).resolves.toMatchObject({ allowPrivate: true, address: "10.1.2.3" });
    await expect(
      resolvePinnedDestination("10.0.0.9", 5432, { allowlist: () => ({ allowPrivate: false }) }),
    ).rejects.toMatchObject({ code: "invalid_destination" });
    await expect(
      resolvePinnedDestination("10.0.0.9", 5432, { allowlist: () => ({ allowPrivate: true }) }),
    ).resolves.toMatchObject({
      address: "10.0.0.9",
    });
  });

  it("refuses unresolvable names and bad ports without leaking DNS errors", async () => {
    await expect(
      resolvePinnedDestination("db.example.com", 5432, {
        allowlist: publicRule,
        lookupImpl: async () => {
          throw new Error("ENOTFOUND internals db.example.com");
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_endpoint", message: expect.not.stringContaining("internals") });
    await expect(resolvePinnedDestination("db.example.com", 70000, { allowlist: publicRule })).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});
