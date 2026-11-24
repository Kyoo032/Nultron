/**
 * The one gateway this product talks to. Pinned: the owner cannot change it from Settings, and a
 * stored `openaiBaseUrl` from an older build is tolerated on read but never honoured.
 *
 * Do not import `node:crypto` here. The renderer loads this module through `@agentforge/core/gateway`.
 * Integrity of the URL string is checked in `pinned-integrity.ts` (Node/tests only).
 */
export const PINNED_GATEWAY_BASE_URL = "https://api.tokotokenai.com/v1";

/** SHA-256 (hex) of the exact `PINNED_GATEWAY_BASE_URL` string. `pinned.test.ts` recomputes it. */
export const PINNED_GATEWAY_BASE_URL_SHA256 =
  "d4721f3504d309efe1e70b32e84600c85f213156c7ff5b2720353d993d006c52";

export function pinnedGatewayBaseUrl(): string {
  return PINNED_GATEWAY_BASE_URL;
}

/** Origin for NewAPI paths like `/api/usage/token` (the pinned base without `/v1`). */
export function pinnedGatewayOrigin(): string {
  const parsed = new URL(PINNED_GATEWAY_BASE_URL);
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * True inside the packaged Electron app. `apps/desktop/main.cjs` `bootstrapPackaged()` sets
 * `AGENTFORGE_PACKAGED=1` immediately before it requires `host.cjs`; nothing else sets it, and
 * `apps/desktop/packaged-env.test.cjs` holds that line.
 */
export function isPackagedRuntime(): boolean {
  return process.env.AGENTFORGE_PACKAGED?.trim() === "1";
}

/**
 * Whether the dev/test endpoint hooks (`AGENTFORGE_GATEWAY_URL`, `AGENTFORGE_TELEGRAM_API_URL`) may
 * be read at all. They may on a developer machine and in a test, never in a packaged build and never
 * in production, so the shipped product always resolves to the pinned endpoints.
 */
export function gatewayUrlOverrideAllowed(): boolean {
  return !isPackagedRuntime() && process.env.NODE_ENV !== "production";
}

/**
 * Read at each call site by its literal name, never through a variable index:
 * `provider-env-sweep.test.ts` flags every dynamic `process.env[...]` read.
 */
function trimmedUrl(value: string | undefined): string {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

function isHttpsUrlWithoutCredentials(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

const MAX_ASSIGNED_GATEWAY_ENDPOINT_LENGTH = 2048;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Validate and normalise an operator-assigned per-user gateway base URL (delivered by the portal
 * token response; never writable by regular users). Returns `null` for empty or invalid values.
 *
 * In production and packaged builds only HTTPS URLs without credentials, query strings, or
 * fragments are accepted. In dev/test (`gatewayUrlOverrideAllowed()`), loopback HTTP is also
 * allowed so local stand-in gateways can be tested end-to-end.
 */
export function normalizeAssignedGatewayEndpoint(
  raw: unknown,
  options: { allowLoopbackHttp?: boolean } = {},
): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed || trimmed.length > MAX_ASSIGNED_GATEWAY_ENDPOINT_LENGTH) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return null;
  }
  const allowLoopbackHttp = options.allowLoopbackHttp ?? gatewayUrlOverrideAllowed();
  const isHttps = parsed.protocol === "https:";
  const isLoopbackHttp =
    allowLoopbackHttp && parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  if (!isHttps && !isLoopbackHttp) {
    return null;
  }
  const cleanPath = parsed.pathname.replace(/\/+$/, "");
  return cleanPath && cleanPath !== "/"
    ? `${parsed.protocol}//${parsed.host}${cleanPath}`
    : `${parsed.protocol}//${parsed.host}`;
}

/**
 * Host-side AsyncLocalStorage hook registered by `@agentforge/host` so per-request and per-run
 * gateway resolution sees the signed-in user's operator-assigned endpoint without importing Node
 * builtins into this browser-shared module.
 */
let assignedEndpointReader: (() => string | null) | null = null;

export function registerAssignedGatewayEndpointReader(reader: (() => string | null) | null): void {
  assignedEndpointReader = reader;
}

export function assignedGatewayEndpoint(): string | null {
  const raw = assignedEndpointReader?.() ?? null;
  return normalizeAssignedGatewayEndpoint(raw);
}

/**
 * The one gateway URL this process may use instead of `PINNED_GATEWAY_BASE_URL`, or `null` for the
 * pinned one. Two channels, never mixed:
 *
 * - **Packaged:** only the brand gateway, `AGENTFORGE_BRAND_GATEWAY_URL`. `apps/desktop/main.cjs`
 *   assigns it from the installed `brand.json` right before `host.cjs` loads, and only for a brand
 *   flavor (Kemenkeu AI, AIHub Metranet): the public Nultron build never has one. It must be https
 *   with no credentials; anything else is ignored. The dev hook is ignored, so a variable in the
 *   user's environment cannot move a packaged build, and `NODE_ENV` does not matter (the packaged
 *   bundle does not define it).
 * - **Otherwise:** the dev/test hook `AGENTFORGE_GATEWAY_URL` (a local mock, a flavor tried out on
 *   webdev), unless `NODE_ENV=production`, so the hosted app is always on the pinned gateway.
 */
export function gatewayUrlOverride(): string | null {
  if (isPackagedRuntime()) {
    const brand = trimmedUrl(process.env.AGENTFORGE_BRAND_GATEWAY_URL);
    return brand && isHttpsUrlWithoutCredentials(brand) ? brand : null;
  }
  if (!gatewayUrlOverrideAllowed()) {
    return null;
  }
  return trimmedUrl(process.env.AGENTFORGE_GATEWAY_URL) || null;
}
