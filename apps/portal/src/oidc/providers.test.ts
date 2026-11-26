/**
 * The Microsoft claim rules without a server: `emailFromClaims` on the configured shapes of
 * `PORTAL_OIDC_MICROSOFT_TENANT` -- a tenant GUID, a tenant domain (resolved to its directory
 * GUID by the discovery document's `issuer`), and the multi-tenant `common`, under which no
 * tenant's `preferred_username` is ever trusted.
 */
import { describe, expect, it } from "vitest";
import type { OidcDiscovery } from "./discovery";
import { oidcProviders } from "./providers";

function microsoft(tenant: string) {
  const provider = oidcProviders({
    google: null,
    microsoft: { clientId: "m-client", clientSecret: "m-secret", tenant },
  }).get("microsoft");
  if (!provider) {
    throw new Error("microsoft provider missing");
  }
  return provider;
}

function doc(issuer: string): OidcDiscovery {
  return {
    issuer,
    authorizationEndpoint: "https://login.microsoftonline.com/x/oauth2/v2.0/authorize",
    tokenEndpoint: "https://login.microsoftonline.com/x/oauth2/v2.0/token",
    jwksUri: "https://login.microsoftonline.com/x/discovery/v2.0/keys",
  };
}

const GUID = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const OTHER_GUID = "9122040d-6c67-4c5b-b112-36a304b66dad";

function upnClaims(tid: string, upn = "person@contoso.test") {
  return {
    sub: "msub-1",
    iss: `https://login.microsoftonline.com/${tid}/v2.0`,
    tid,
    preferred_username: upn,
  };
}

describe("microsoftEmail", () => {
  it("returns the verified e-mail whatever the tenant", () => {
    const provider = microsoft("common");
    expect(
      provider.emailFromClaims(
        { email: "Person@Contoso.TEST", email_verified: true, tid: "anything" },
        doc("https://login.microsoftonline.com/{tenantid}/v2.0"),
      ),
    ).toBe("person@contoso.test");
  });

  it("trusts the UPN when the configured tenant GUID is the token's tid", () => {
    const provider = microsoft(GUID);
    expect(provider.emailFromClaims(upnClaims(GUID), doc("https://login.microsoftonline.com/{tenantid}/v2.0"))).toBe(
      "person@contoso.test",
    );
    expect(provider.emailFromClaims(upnClaims(OTHER_GUID), doc("https://login.microsoftonline.com/{tenantid}/v2.0"))).toBeNull();
  });

  it("resolves a configured domain to the directory GUID the discovery issuer names", () => {
    const provider = microsoft("contoso.onmicrosoft.com");
    const document = doc(`https://login.microsoftonline.com/${GUID}/v2.0`);
    expect(provider.emailFromClaims(upnClaims(GUID), document)).toBe("person@contoso.test");
    expect(provider.emailFromClaims(upnClaims(OTHER_GUID), document)).toBeNull();
  });

  it("trusts no UPN under a multi-tenant authority", () => {
    const provider = microsoft("common");
    const document = doc("https://login.microsoftonline.com/{tenantid}/v2.0");
    expect(provider.emailFromClaims(upnClaims(GUID), document)).toBeNull();
  });
});
