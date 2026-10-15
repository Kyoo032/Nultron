import type Database from "better-sqlite3";

export const GATEWAY_TOKEN_TABLES = ["gateway_managed_tokens"] as const;

export function ensureGatewayTokenTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS gateway_managed_tokens (
      organization_id text NOT NULL REFERENCES organizations(id) ON DELETE cascade,
      gateway_token_id text NOT NULL,
      name text NOT NULL,
      created_at integer NOT NULL,
      PRIMARY KEY (organization_id, gateway_token_id)
    );
  `);
}
