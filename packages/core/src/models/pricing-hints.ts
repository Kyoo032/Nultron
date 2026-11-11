import { gatewayOriginFromBaseUrl, resolvedGatewayBaseUrl } from "../gateway";
import { assertAllowedEndpointUrl } from "../security/tls";
import { parsePricingHints, type PricingHints } from "./gateway-catalog";

/**
 * The gateway's public price list reduced to `model id -> endpoint types` (`GET <origin>/api/pricing`).
 *
 * It needs no key, so none is sent. It lives in core, not in the host's model list code, because the
 * Finance egress guard (`packages/host/src/finance-egress.test.ts`) forbids a direct network call in
 * any host file Finance can import, and that code is one of them. A failure is `null`: the catalog then
 * simply keeps the answer it had.
 */
export async function fetchPricingHints(
  input: { baseURL?: string; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<PricingHints | null> {
  try {
    const url = `${gatewayOriginFromBaseUrl(input.baseURL ?? resolvedGatewayBaseUrl())}/api/pricing`;
    assertAllowedEndpointUrl(url);
    const fetchFn = input.fetch ?? globalThis.fetch;
    const response = await fetchFn(url, {
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(input.timeoutMs ?? 5_000),
    });
    if (!response.ok) {
      return null;
    }
    const hints = parsePricingHints(await response.json());
    return Object.keys(hints).length > 0 ? hints : null;
  } catch {
    return null;
  }
}
