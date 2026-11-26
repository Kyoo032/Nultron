/**
 * F1: resolve-and-pin for the raw-TCP connectors (PostgreSQL; MySQL behind its decision).
 *
 * HTTPS connectors get DNS pinning for free inside `fetchPublicHttps` (each hop resolves,
 * checks and hands a `pinnedLookup` to the undici agent). `pg` and `mysql2` do their own
 * `net.connect`, so this module performs the same three steps and hands the driver what it
 * can use: the operator allowlist verdict (`assertAllowedDestination`), the resolved
 * address list with private ranges refused unless the entry allows them, and either a
 * `lookup` function the driver can pin with or the first pinned address to dial directly.
 *
 * DNS-rebinding is the attack this exists for: the check happens on the addresses the
 * resolver gave THIS call, and the connection is pinned to exactly those, so a resolver
 * that answers public-then-private never gets its second answer used.
 */
import type { LookupFunction } from "node:net";
import { ApiError } from "../errors";
import { isPrivateIpAddress, parseIpAddress } from "./ip-range";
import {
  assertAllowedDestination,
  pinnedLookup,
  resolvePublicAddresses,
  type DestinationAllowlist,
  type HostLookup,
  type ResolvedAddress,
} from "./safe-fetch";

export type PinnedDestination = {
  /** What the operator allowlist decided; `allowPrivate` is true only on an explicit entry. */
  readonly allowPrivate: boolean;
  /** The addresses this call resolved and verified — connect to one of these, no other. */
  readonly addresses: readonly ResolvedAddress[];
  /** `dns.lookup`-shaped function that answers only `host` with `addresses` (pg `lookup` option). */
  readonly lookup: LookupFunction;
  /** Convenience: the first verified address, for drivers that take a bare `host`. */
  readonly address: string;
};

export async function resolvePinnedDestination(
  host: string,
  port: number,
  options: { allowlist?: DestinationAllowlist; lookupImpl?: HostLookup } = {},
): Promise<PinnedDestination> {
  const rule = assertAllowedDestination(host, port, options.allowlist);
  const name = host.trim().toLowerCase();
  const literal = parseIpAddress(name);
  let addresses: readonly ResolvedAddress[];
  if (literal) {
    if (isPrivateIpAddress(literal) && !rule.allowPrivate) {
      throw new ApiError("invalid_destination", "Destination address is not public", 400);
    }
    addresses = [{ address: name }];
  } else {
    // Every resolved address must pass — a rebinding that mixes one private answer in is refused whole.
    addresses = await resolvePublicAddresses(name, options.lookupImpl, { allowPrivate: rule.allowPrivate });
  }
  if (addresses.length === 0) {
    throw new ApiError("invalid_destination", "Could not resolve the destination host", 400);
  }
  return {
    allowPrivate: rule.allowPrivate,
    addresses,
    lookup: pinnedLookup(name, addresses),
    address: addresses[0]!.address,
  };
}
