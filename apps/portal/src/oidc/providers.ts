/**
 * The two providers F8b ships, as presets. A provider is a discovery document plus a client
 * credential and the small rules each issuer has that the generic code cannot guess: which
 * e-mail claim is the verified one, and which claims make up the verified e-mail.
 */
import type { OidcConfig, OidcProviderConfig } from "../config";

export type OidcProviderId = "google" | "microsoft";

export interface OidcProvider {
  readonly id: OidcProviderId;
  /** The discovery document's URL (RFC 8414 style `.well-known/openid-configuration`). */
  readonly discoveryUrl: string;
  /**
   * Whether an ID token's `iss` is this provider's. Google pins the exact issuer; Entra issues
   * `https://login.microsoftonline.com/<tid>/v2.0` per tenant, checked with the token's `tid`.
   */
  readonly issuerOk: (iss: string, claims: Readonly<Record<string, unknown>>) => boolean;
  readonly clientId: string;
  readonly clientSecret: string;
  /**
   * The claims that settle "this is the e-mail the seat belongs to, and the provider verified it":
   * the e-mail value itself, and whether the provider says it is verified. A provider that proves
   * an address but does not say it is verified does not sign anyone in.
   */
  readonly emailFromClaims: (claims: Readonly<Record<string, unknown>>) => string | null;
}

function claimsEmail(claims: Readonly<Record<string, unknown>>): string | null {
  const email = claims.email;
  return typeof email === "string" && email.includes("@") ? email.trim().toLowerCase() : null;
}

const GOOGLE_ISSUER = "https://accounts.google.com";
const ENTRA_ISSUER = /^https:\/\/login\.microsoftonline\.com\//;

function microsoftIssuerOk(iss: string, claims: Readonly<Record<string, unknown>>): boolean {
  const tid = claims.tid;
  return typeof tid === "string" && ENTRA_ISSUER.test(iss) && iss === `https://login.microsoftonline.com/${tid}/v2.0`;
}

const PRESETS = {
  google: {
    discoveryUrl: "https://accounts.google.com/.well-known/openid-configuration",
    issuerOk: (iss: string): boolean => iss === GOOGLE_ISSUER,
  },
  microsoft: (tenant: string) => ({
    discoveryUrl: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/v2.0/.well-known/openid-configuration`,
    issuerOk: microsoftIssuerOk,
  }),
} as const;

/**
 * The configured providers, as `providerId -> OidcProvider`. A provider absent from the config is
 * absent from the map: its routes are never registered and a crafted `provider` path segment is a
 * 404, not a half-configuration.
 */
export function oidcProviders(config: OidcConfig | undefined): ReadonlyMap<OidcProviderId, OidcProvider> {
  const map = new Map<OidcProviderId, OidcProvider>();
  if (!config) {
    return map;
  }
  if (config.google) {
    map.set("google", provider("google", PRESETS.google, config.google));
  }
  if (config.microsoft) {
    const preset = PRESETS.microsoft(config.microsoft.tenant);
    map.set("microsoft", {
      id: "microsoft",
      discoveryUrl: preset.discoveryUrl,
      issuerOk: preset.issuerOk,
      clientId: config.microsoft.clientId,
      clientSecret: config.microsoft.clientSecret,
      emailFromClaims: microsoftEmail,
    });
  }
  return map;
}

function provider(
  id: OidcProviderId,
  preset: {
    readonly discoveryUrl: string;
    readonly issuerOk: (iss: string, claims: Readonly<Record<string, unknown>>) => boolean;
  },
  config: OidcProviderConfig,
): OidcProvider {
  return {
    id,
    discoveryUrl: preset.discoveryUrl,
    issuerOk: preset.issuerOk,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    emailFromClaims: googleEmail,
  };
}

/** Google: the `email` claim, only while `email_verified` is `true`. */
function googleEmail(claims: Readonly<Record<string, unknown>>): string | null {
  return claims.email_verified === true ? claimsEmail(claims) : null;
}

/**
 * Microsoft (Entra): `email_verified` when it is present, and otherwise the tenant-verified
 * `preferred_username` -- a managed account's UPN is an address the tenant asserts, while a plain
 * `email` claim an end user typed is not.
 */
function microsoftEmail(claims: Readonly<Record<string, unknown>>): string | null {
  if (claims.email_verified === true) {
    return claimsEmail(claims);
  }
  const upn = claims.preferred_username;
  return typeof upn === "string" && upn.includes("@") ? upn.trim().toLowerCase() : null;
}
