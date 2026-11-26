import { lookup as dnsLookup } from "node:dns/promises";
import { type LookupFunction, isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { ApiError } from "../errors";
import { isPrivateHostname, isPrivateIpAddress, parseIpAddress } from "./ip-range";
import { assertSendableUrl } from "./outbound-guard";

export const SAFE_FETCH_MAX_HOPS = 5;
export const SAFE_FETCH_DEFAULT_MAX_BYTES = 1_500_000;
export const SAFE_FETCH_DEFAULT_TIMEOUT_MS = 15_000;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const USER_AGENT = "Nultron/1.0 (local research reader)";

/** What `dns.lookup(host, { all: true })` hands back; narrowed to the one field this file reads. */
export type ResolvedAddress = { readonly address: string };

/** Injected by the tests so a suite never depends on a resolver being reachable. */
export type HostLookup = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export type SafeFetchOptions = {
  fetchImpl?: typeof fetch;
  lookupImpl?: HostLookup;
  /**
   * Skip the private-range refusal for this call's literal host and its resolved addresses.
   * Set only by the F1 connector path when the operator's destination allowlist row for this
   * `host:port` carries `allow_private` (`assertAllowedDestination` below); anything else that
   * passes it would punch the SSRF wall this file exists for.
   */
  allowPrivate?: boolean;
  maxHops?: number;
  maxBytes?: number;
  oversize?: "throw" | "truncate";
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Caller's abort signal (a cancelled job); combined with the timeout. */
  signal?: AbortSignal;
  /**
   * Who wrote the URL. `"model"` (the default) is checked by the run's outbound guard
   * (`./outbound-guard.ts`) before anything is sent. `"host"` is an address the host or the gateway
   * produced, such as a signed media link, and is not: a model did not write it, and its signature would
   * read as a credential.
   */
  urlSource?: "model" | "host";
};

export type SafeFetchResult = {
  finalUrl: string;
  status: number;
  contentType: string;
  body: Buffer;
  truncated: boolean;
};

/**
 * The literal half of the check: an address the server must not reach, or a name that by convention
 * points at this machine or this network.
 *
 * Address ranges live in `./ip-range`, on bytes rather than on text. The list of string prefixes
 * this used to be had two holes that a prefix list cannot close: `[::ffff:127.0.0.1]` and
 * `[::ffff:169.254.169.254]` (IPv4-mapped IPv6, which the stack connects to the embedded IPv4
 * address) read as public, and so did 100.64.0.0/10, where a cloud provider's internal endpoints
 * live. It also refused the public domain `fdic.gov` for starting with `fd`.
 */
function isPrivateHost(hostname: string): boolean {
  const address = parseIpAddress(hostname);
  return address ? isPrivateIpAddress(address) : isPrivateHostname(hostname);
}

/**
 * Public HTTPS only: no credentials, no loopback, no private ranges. Applied to every redirect hop.
 */
export function assertPublicHttpsUrl(url: string, options: { allowPrivate?: boolean } = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiError("invalid_endpoint", "URL is not valid", 400);
  }
  if (parsed.protocol !== "https:") {
    throw new ApiError("invalid_endpoint", "URL must use HTTPS", 400);
  }
  if (parsed.username || parsed.password) {
    throw new ApiError("invalid_endpoint", "URL must not contain credentials", 400);
  }
  if (!options.allowPrivate && isPrivateHost(parsed.hostname)) {
    throw new ApiError("invalid_endpoint", "URL must point at a public host", 400);
  }
  return parsed;
}

/** Resolve a redirect target against the hop it came from, then re-validate it. */
export function nextHopUrl(from: string, location: string | null): string | null {
  if (!location) {
    return null;
  }
  return assertPublicHttpsUrl(new URL(location, from).toString()).toString();
}

const defaultLookup: HostLookup = (hostname) => dnsLookup(hostname, { all: true });

const UNRESOLVED_MESSAGE = "Could not resolve this URL's host";
const NOT_PUBLIC_MESSAGE = "URL must point at a public host";

export async function resolvePublicAddresses(
  hostname: string,
  lookupImpl: HostLookup = defaultLookup,
  options: { allowPrivate?: boolean } = {},
): Promise<readonly ResolvedAddress[]> {
  if (parseIpAddress(hostname)) {
    return [];
  }
  let resolved: readonly ResolvedAddress[];
  try {
    resolved = await lookupImpl(hostname);
  } catch (lookupError) {
    const refusal = new ApiError("invalid_endpoint", UNRESOLVED_MESSAGE, 400);
    refusal.cause = lookupError;
    throw refusal;
  }
  if (resolved.length === 0) {
    throw new ApiError("invalid_endpoint", UNRESOLVED_MESSAGE, 400);
  }
  for (const { address } of resolved) {
    const parsed = parseIpAddress(address);
    if (!parsed || (!options.allowPrivate && isPrivateIpAddress(parsed))) {
      throw new ApiError("invalid_endpoint", NOT_PUBLIC_MESSAGE, 400);
    }
  }
  return resolved;
}

export async function assertResolvesPublic(hostname: string, lookupImpl: HostLookup = defaultLookup): Promise<void> {
  await resolvePublicAddresses(hostname, lookupImpl);
}

type PinnedAnswer = { readonly address: string; readonly family: 4 | 6 };

function wantedFamily(family: unknown): 4 | 6 | null {
  if (family === 4 || family === "IPv4") {
    return 4;
  }
  if (family === 6 || family === "IPv6") {
    return 6;
  }
  return null;
}

export function pinnedLookup(pinnedHost: string, addresses: readonly ResolvedAddress[]): LookupFunction {
  const answers: readonly PinnedAnswer[] = addresses.map(({ address }) => ({
    address,
    family: isIP(address) === 4 ? 4 : 6,
  }));
  return (hostname, options, callback) => {
    const family = wantedFamily(options.family);
    const matching =
      hostname.toLowerCase() === pinnedHost.toLowerCase()
        ? answers.filter((answer) => family === null || answer.family === family)
        : [];
    const first = matching[0];
    if (!first) {
      callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }), "");
      return;
    }
    if (options.all) {
      callback(
        null,
        matching.map(({ address, family: answerFamily }) => ({ address, family: answerFamily })),
      );
      return;
    }
    callback(null, first.address, first.family);
  };
}

export const SAFE_FETCH_TLS_OPTIONS = Object.freeze({
  minVersion: "TLSv1.2" as const,
  rejectUnauthorized: true,
});

export function pinnedAgent(hostname: string, addresses: readonly ResolvedAddress[]): Agent {
  return new Agent({
    connect: {
      lookup: pinnedLookup(hostname, addresses),
      ...SAFE_FETCH_TLS_OPTIONS,
    },
  });
}

export const defaultFetch = undiciFetch as unknown as typeof fetch;

/* ------------------------------------------------------------------ the destination allowlist */

/**
 * F1: the per-org `host:port` allowlist every connector goes through before a byte leaves.
 *
 * The rows live in the desk's own SQLite (`destination_allowlist`, host migration 0028), which
 * core cannot read — so the host installs this lookup the same way it installs the audit writer
 * (`packages/host/src/data-sources/install.ts`, imported by `router.ts`). With nothing installed
 * the default is to refuse: a connector that cannot read its policy never guesses.
 */
export type DestinationRule = {
  /** True when the operator marked this entry reachable over a private address (an internal MinIO). */
  readonly allowPrivate: boolean;
};
/**
 * Answers the rule for one `host` (lowercase) + `port` + `tenantId`, or `null` when there is none.
 * The allowlist is per tenant: a `null`/`undefined` `tenantId` must fail closed.
 */
export type DestinationAllowlist = (host: string, port: number, tenantId?: string | null) => DestinationRule | null;

let destinationAllowlist: DestinationAllowlist = () => null;

/** Host-side install point; `null` restores refuse-all (tests). */
export function installDestinationAllowlist(next: DestinationAllowlist | null): void {
  destinationAllowlist = next ?? (() => null);
}

/** The currently installed lookup; `null` answer means the destination is refused. */
export function currentDestinationAllowlist(): DestinationAllowlist {
  return destinationAllowlist;
}

/**
 * Refuse a `host:port` a connector was pointed at unless the operator's allowlist names it.
 * Throws `invalid_destination` (400) — an operator fix, not a caller's bug — and returns the
 * rule so the caller knows whether private addresses are permitted for this entry.
 */
export function assertAllowedDestination(
  host: string,
  port: number,
  lookup: DestinationAllowlist = destinationAllowlist,
  tenantId?: string | null,
): DestinationRule {
  const name = host.trim().toLowerCase();
  if (!name || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ApiError("invalid_destination", "Destination host or port is not valid", 400);
  }
  const rule = lookup(name, port, tenantId);
  if (!rule) {
    throw new ApiError("invalid_destination", "This destination is not on the operator's host:port allowlist", 400);
  }
  return rule;
}

async function readCapped(
  response: Response,
  maxBytes: number,
  oversize: "throw" | "truncate",
): Promise<{ body: Buffer; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    return { body: Buffer.alloc(0), truncated: false };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    if (total + value.byteLength > maxBytes) {
      await reader.cancel();
      if (oversize === "throw") {
        throw new ApiError(
          "invalid_request",
          `URL body exceeds ${Math.round((maxBytes / 1_000_000) * 10) / 10} MB`,
          400,
        );
      }
      chunks.push(value.subarray(0, maxBytes - total));
      return { body: Buffer.concat(chunks), truncated: true };
    }
    total += value.byteLength;
    chunks.push(value);
  }
  return { body: Buffer.concat(chunks), truncated: false };
}

function linkSignals(options: SafeFetchOptions): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? SAFE_FETCH_DEFAULT_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });
  return {
    controller,
    dispose: () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onOuterAbort);
    },
  };
}

/**
 * Fetch a public HTTPS URL, following redirects manually so every hop passes the
 * same host/protocol checks, with a timeout and a byte cap on the body.
 */
export async function fetchPublicHttps(url: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  if (options.urlSource !== "host") {
    // The first address only: a redirect hop is the server's answer, not text the model wrote.
    assertSendableUrl(url.trim());
  }
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const maxHops = options.maxHops ?? SAFE_FETCH_MAX_HOPS;
  const maxBytes = options.maxBytes ?? SAFE_FETCH_DEFAULT_MAX_BYTES;
  const { controller, dispose } = linkSignals(options);
  try {
    let parsed = assertPublicHttpsUrl(url.trim(), { allowPrivate: options.allowPrivate });
    let current = parsed.toString();
    for (let hop = 0; hop <= maxHops; hop += 1) {
      const addresses = await resolvePublicAddresses(parsed.hostname, options.lookupImpl, {
        allowPrivate: options.allowPrivate,
      });
      const agent = pinnedAgent(parsed.hostname, addresses);
      try {
        const response = await fetchImpl(current, {
          redirect: "manual",
          signal: controller.signal,
          headers: { "User-Agent": USER_AGENT, ...options.headers },
          dispatcher: agent,
        } as RequestInit);
        if (REDIRECT_STATUSES.has(response.status)) {
          const next = nextHopUrl(current, response.headers.get("location"));
          if (!next) {
            throw new ApiError("invalid_request", `Redirect without a location (${response.status})`, 400);
          }
          current = next;
          parsed = new URL(next);
          continue;
        }
        const read = await readCapped(response, maxBytes, options.oversize ?? "throw");
        return {
          finalUrl: current,
          status: response.status,
          contentType: response.headers.get("content-type") ?? "",
          body: read.body,
          truncated: read.truncated,
        };
      } finally {
        await agent.destroy().catch(() => undefined);
      }
    }
    throw new ApiError("invalid_request", `Too many redirects (more than ${maxHops})`, 400);
  } catch (error) {
    if (options.signal?.aborted) {
      throw new ApiError("aborted", "URL fetch cancelled", 499);
    }
    if (controller.signal.aborted) {
      throw new ApiError("invalid_request", "URL fetch timed out", 400);
    }
    throw error;
  } finally {
    dispose();
  }
}
