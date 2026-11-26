/**
 * F1: the MAC-verified reader for `destination_allowlist` (migration 0028).
 *
 * The operator CLI (`packages/host/scripts/destination-allowlist.ts`) is the only writer; this
 * module is the only reader, installed into `@agentforge/core` by `install.ts` so
 * `assertAllowedDestination` answers from these rows. Each row's `mac` is an HMAC-SHA256 over
 * `tenant_id|host|port|allow_private` under `HKDF(wrapKey, "destination-allowlist-v1")`: a row
 * edited by hand fails the MAC and is ignored, logged as a security event (DFIND-160's same
 * tamper class). The log line carries the row id — never the key.
 */
import { createHmac, hkdfSync } from "node:crypto";
import { sql } from "@agentforge/db";
import { getLocalVaultKey } from "@agentforge/db/vault-key";
import { installDestinationAllowlist, type DestinationRule } from "@agentforge/core";

const MAC_INFO = "destination-allowlist-v1";

function allowlistKey(): Buffer {
  return Buffer.from(hkdfSync("sha256", getLocalVaultKey(), Buffer.alloc(0), MAC_INFO, 32));
}

export function destinationAllowlistMac(tenantId: string, host: string, port: number, allowPrivate: boolean): string {
  return createHmac("sha256", allowlistKey())
    .update(`${tenantId}|${host}|${port}|${allowPrivate ? 1 : 0}`)
    .digest("hex");
}

type Row = { id: string; tenant_id: string; host: string; port: number; allow_private: number; mac: string };

/** Every row of one tenant whose MAC verifies; tampered rows are skipped and logged. */
export function verifiedDestinationRules(
  tenantId: string,
): Array<{ host: string; port: number; allowPrivate: boolean }> {
  const rows = sql
    .prepare("SELECT id, tenant_id, host, port, allow_private, mac FROM destination_allowlist WHERE tenant_id = ?")
    .all(tenantId) as Row[];
  const out: Array<{ host: string; port: number; allowPrivate: boolean }> = [];
  for (const row of rows) {
    const expected = destinationAllowlistMac(row.tenant_id, row.host, row.port, row.allow_private === 1);
    if (expected !== row.mac) {
      console.warn(`security: destination_allowlist row ${row.id} failed its MAC and is ignored`);
      continue;
    }
    out.push({ host: row.host, port: row.port, allowPrivate: row.allow_private === 1 });
  }
  return out;
}

/** Install the core lookup: per-tenant verified rows, `null` when the destination is not listed. */
export function installDestinationAllowlistReader(): void {
  // The lookup core calls has no tenant argument: the rules are global per desk (one org per
  // deployment today), so the reader unions every tenant's verified rows and keys on host:port.
  installDestinationAllowlist((host, port): DestinationRule | null => {
    const rows = sql
      .prepare(
        "SELECT id, tenant_id, host, port, allow_private, mac FROM destination_allowlist WHERE host = ? AND port = ?",
      )
      .all(host, port) as Row[];
    for (const row of rows) {
      const expected = destinationAllowlistMac(row.tenant_id, row.host, row.port, row.allow_private === 1);
      if (expected !== row.mac) {
        console.warn(`security: destination_allowlist row ${row.id} failed its MAC and is ignored`);
        continue;
      }
      return { allowPrivate: row.allow_private === 1 };
    }
    return null;
  });
}
