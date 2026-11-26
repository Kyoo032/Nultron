/**
 * The DFIND-155 sealed write-only endpoint key: a blob opens only under the portal key that sealed
 * it, never as plaintext, and never under a different signing key or after tampering.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openGatewayKey, sealGatewayKey } from "./gateway-key";
import { keyFromSeed } from "./jwt/keys";

const portalKey = keyFromSeed(randomBytes(32));
const otherPortalKey = keyFromSeed(randomBytes(32));

describe("gateway endpoint key sealing (DFIND-155)", () => {
  it("round-trips a raw key", () => {
    const sealed = sealGatewayKey("sk-issued-for-this-endpoint", portalKey);
    expect(sealed).not.toContain("sk-issued-for-this-endpoint");
    expect(openGatewayKey(sealed, portalKey)).toBe("sk-issued-for-this-endpoint");
  });

  it("refuses a blob sealed by another portal key", () => {
    const sealed = sealGatewayKey("sk-foreign", otherPortalKey);
    expect(openGatewayKey(sealed, portalKey)).toBeNull();
  });

  it("refuses tampered, truncated and non-blob values", () => {
    const sealed = sealGatewayKey("sk-issued", portalKey);
    const envelope = JSON.parse(sealed) as { data: string };
    envelope.data = envelope.data.slice(0, -2) + "AA";
    expect(openGatewayKey(JSON.stringify(envelope), portalKey)).toBeNull();
    expect(openGatewayKey("not json", portalKey)).toBeNull();
    expect(openGatewayKey('{"v":1}', portalKey)).toBeNull();
    expect(openGatewayKey("sk-plaintext-in-column", portalKey)).toBeNull();
  });
});
