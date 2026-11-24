/**
 * Validation and normalisation for operator-assigned per-user gateway endpoints.
 *
 * Only Nultron admins set this (via `portal:account` or `portal:invite`). Regular users can never
 * supply a gateway URL. In production only public HTTPS endpoints without credentials, query strings,
 * or fragments are accepted; non-production dev/tests may also use loopback HTTP (`127.0.0.1`,
 * `localhost`, `[::1]`) for local stand-in gateways.
 */

export const MAX_GATEWAY_ENDPOINT_LENGTH = 2048;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export interface NormaliseGatewayEndpointOptions {
  /** Allow `http://127.0.0.1` / `http://localhost` / `http://[::1]`. Defaults to `NODE_ENV !== "production"`. */
  readonly allowLoopbackHttp?: boolean;
}

export class InvalidGatewayEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGatewayEndpointError";
  }
}

export function normaliseGatewayEndpoint(
  raw: string,
  options: NormaliseGatewayEndpointOptions = {},
): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new InvalidGatewayEndpointError("Gateway endpoint cannot be empty.");
  }
  if (trimmed.length > MAX_GATEWAY_ENDPOINT_LENGTH) {
    throw new InvalidGatewayEndpointError(
      `Gateway endpoint exceeds ${MAX_GATEWAY_ENDPOINT_LENGTH} characters.`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new InvalidGatewayEndpointError(
      `--gateway-endpoint must be a valid HTTPS URL (got ${JSON.stringify(raw)}).`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new InvalidGatewayEndpointError("Gateway endpoint must not contain embedded credentials.");
  }
  if (parsed.search || parsed.hash) {
    throw new InvalidGatewayEndpointError("Gateway endpoint must not contain a query string or fragment.");
  }
  const allowLoopbackHttp = options.allowLoopbackHttp ?? process.env.NODE_ENV !== "production";
  const isHttps = parsed.protocol === "https:";
  const isLoopbackHttp =
    allowLoopbackHttp && parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  if (!isHttps && !isLoopbackHttp) {
    throw new InvalidGatewayEndpointError(
      `--gateway-endpoint must use https:// (got ${JSON.stringify(raw)}).`,
    );
  }
  if (!parsed.hostname) {
    throw new InvalidGatewayEndpointError(
      `--gateway-endpoint must include a hostname (got ${JSON.stringify(raw)}).`,
    );
  }
  const cleanPath = parsed.pathname.replace(/\/+$/, "");
  return cleanPath && cleanPath !== "/"
    ? `${parsed.protocol}//${parsed.host}${cleanPath}`
    : `${parsed.protocol}//${parsed.host}`;
}
