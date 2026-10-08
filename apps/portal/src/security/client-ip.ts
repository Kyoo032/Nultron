/**
 * Which address a request came from, and when the portal is allowed to believe the header.
 *
 * `X-Forwarded-For` is trusted **only** when `PORTAL_TRUST_PROXY=1` is set. Without that flag it
 * is ignored entirely, because every rate-limit bucket in `src/security/rate-limit.ts` is keyed on
 * this value and a header anyone can send is a header anyone can use to evade one -- or to exhaust
 * someone else's window.
 *
 * The flag itself is read and validated by `loadConfig` and arrives here as `trustProxy` on the
 * runtime (SR-33). This module reads no environment of its own: a typo in the variable used to
 * mean "off", silently, and now it is a boot error.
 *
 * **One trusted hop: the RIGHT-most entry, and only that one.** The header is a chain, and the
 * client writes its start. The proxy in front (Caddy, `webapp-deploy/Caddyfile`) either replaces
 * the header with the peer it saw, or appends that peer to whatever the client sent. Either way,
 * the last entry is the only one this deployment's own proxy wrote. Reading the left-most entry, as
 * this used to, let a caller pick a fresh rate-limit bucket per request by rotating a forged
 * prefix, or pick somebody else's bucket to exhaust. When the last entry is not an address
 * (a proxy that writes `ip:port`, say), the answer is the socket peer, **never** an entry further
 * left: those are the client's. The host keys its own limiter the same way
 * (`packages/host/src/rate-limit.ts`, `clientIp`). A second appending proxy in front of the first
 * moves the client one hop left, so this rule changes whenever the proxy chain does.
 *
 * The value also reaches `audit_log.ip` and `device_codes.created_ip`, which are `inet` columns, so
 * anything that is not an address becomes `null` rather than a failed INSERT.
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** `::ffff:127.0.0.1` is the same address as `127.0.0.1`, and `inet` prefers the short form. */
function normalise(value: string): string | null {
  const trimmed = value.trim().replace(/^\[|\]$/g, "");
  if (trimmed === "") {
    return null;
  }
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  const candidate = mapped ? mapped[1] : trimmed;

  const v4 = IPV4.exec(candidate);
  if (v4) {
    return v4.slice(1).every((octet) => Number(octet) <= 255) ? candidate : null;
  }
  // A conservative IPv6 shape: hex groups and colons only. `inet` rejects anything else anyway,
  // but a `null` here is a missing audit field rather than a 500 on the login path.
  return /^[0-9a-f:]+$/i.test(candidate) && candidate.includes(":") ? candidate : null;
}

export interface ClientIpInput {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** `request.ip` from `src/server.ts` -- the socket's own peer address. */
  readonly socketIp: string | null;
  readonly trustProxy: boolean;
}

export function clientIp(input: ClientIpInput): string | null {
  if (input.trustProxy) {
    const header = input.headers["x-forwarded-for"];
    // Repeated header lines are one chain in order; node joins them with ", " itself.
    const raw = Array.isArray(header) ? header.join(",") : header;
    // The last entry is the one the proxy in front wrote. Nothing to its left is trusted.
    const lastHop = raw?.split(",").at(-1);
    const forwarded = lastHop ? normalise(lastHop) : null;
    if (forwarded) {
      return forwarded;
    }
  }
  return input.socketIp ? normalise(input.socketIp) : null;
}

/** A stable bucket key: the address when there is one, a single shared bucket when there is not. */
export function rateLimitKey(ip: string | null): string {
  return ip ?? "unknown-ip";
}

/** The eight 16-bit groups of an IPv6 address, or `null` when it is not one (an IPv4 address, or junk). */
function ipv6Groups(address: string): readonly number[] | null {
  if (!address.includes(":")) {
    return null;
  }
  const halves = address.split("::");
  if (halves.length > 2) {
    return null;
  }
  const parse = (part: string): number[] | null => {
    if (part === "") {
      return [];
    }
    const groups = part.split(":");
    if (!groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) {
      return null;
    }
    return groups.map((group) => Number.parseInt(group, 16));
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (head === null || tail === null) {
    return null;
  }
  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  // `::` stands for at least one group of zeros.
  const missing = 8 - head.length - tail.length;
  return missing >= 1 ? [...head, ...Array.from({ length: missing }, () => 0), ...tail] : null;
}

/**
 * How many leading bits of an IPv6 address name the source a password sign-in is counted against.
 *
 * A /56 is 256 /64s. It is not a /64, because one routed /48 is 65,536 of those, and every one of them
 * would be a source of its own with the whole per-source budget: enough requests to hold every
 * password-derivation permit (`PasswordHasher.admit`) and answer `503` to everybody. A /48 is 256
 * of these. The cost is that everyone inside one /56 (a home, an office) is one source.
 */
export const IPV6_SOURCE_PREFIX_BITS = 56;

/** The address's first `IPV6_SOURCE_PREFIX_BITS` bits, every other bit zero, as the eight groups it is made of. */
function ipv6Prefix(groups: readonly number[]): string {
  return groups
    .map((group, index) => {
      const kept = Math.max(0, Math.min(16, IPV6_SOURCE_PREFIX_BITS - index * 16));
      const mask = (0xffff << (16 - kept)) & 0xffff;
      return (group & mask).toString(16);
    })
    .join(":");
}

/**
 * The source a password sign-in is counted against: an IPv4 address as it is, an IPv6 address as its
 * `/56` (`IPV6_SOURCE_PREFIX_BITS`).
 *
 * A customer that is given an IPv6 network is given at least a `/64`, which is 2^64 addresses, so
 * keyed on the whole address every request can arrive from a "new" source and no per-source limit
 * ever fires. A `/64` is what one subscriber is, but one routed `/48` is 65,536 of them, so the unit
 * is the `/56` (see the constant). An IPv4-mapped address in either spelling is the IPv4 address it
 * wraps (not the shared `::/56`, which would put every such client in one bucket). An address that is
 * not known is the one shared bucket, as `rateLimitKey` has it.
 *
 * **Only the password routes use this.** `rateLimitKey` keeps the whole address, because the limits of
 * the e-mailed-code sign-in count exactly what they always have and that mode does not change.
 * The lockout's record of sources (`security/password-attempts.ts`) is fed the same value on purpose:
 * one function says what a source is. Anything that is neither an IPv4 address nor parseable as IPv6
 * is returned as it came: it cannot come from a socket, and an odd key only ever lands in a bucket of
 * its own.
 */
export function sourceBucket(ip: string | null): string {
  if (ip === null) {
    return rateLimitKey(null);
  }
  // The dotted spelling, which `clientIp` has already unwrapped; handled here too so that no caller
  // can reach the shared `::/56` bucket by handing this the address as the socket spelled it.
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (dotted) {
    return dotted[1];
  }
  const groups = ipv6Groups(ip);
  if (groups === null) {
    return ip;
  }
  const isMapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (isMapped) {
    const [high, low] = [groups[6], groups[7]];
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return `${ipv6Prefix(groups)}/${IPV6_SOURCE_PREFIX_BITS}`;
}
