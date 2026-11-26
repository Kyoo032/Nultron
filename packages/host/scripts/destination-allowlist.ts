#!/usr/bin/env tsx
/**
 * F1: the ONLY writer of `destination_allowlist` (migration 0028). The desk API deliberately has
 * no route for this table — a compromised session cannot point the connectors at an attacker
 * host; the operator runs this script on the box:
 *
 *   pnpm --filter @agentforge/host allowlist -- add --tenant <id> --host db.example.com --port 5432 [--allow-private]
 *   pnpm --filter @agentforge/host allowlist -- remove --tenant <id> --host db.example.com --port 5432
 *   pnpm --filter @agentforge/host allowlist -- list [--tenant <id>]
 *
 * Every write recomputes the row's MAC (`HKDF(wrapKey, "destination-allowlist-v1")`, the same key
 * `data-sources/allowlist.ts` verifies at read), and the script audits each add/remove under the
 * `operator` actor kind.
 */
import { randomUUID } from "node:crypto";
import { sql } from "@agentforge/db";
import { reportAuditEvent } from "@agentforge/core";
import "../src/audit/install";
import { destinationAllowlistMac } from "../src/data-sources/allowlist";

type Args = { command?: string; tenant?: string; host?: string; port?: number; allowPrivate?: boolean };

function parse(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      out.command = arg;
      continue;
    }
    const key = arg.slice(2);
    if (key === "allow-private") {
      out.allowPrivate = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) {
      throw new Error(`--${key} needs a value`);
    }
    if (key === "tenant") out.tenant = value;
    else if (key === "host") out.host = value;
    else if (key === "port") out.port = Number(value);
    else throw new Error(`unknown flag --${key}`);
  }
  return out;
}

function audit(tenant: string, outcome: "ok" | "denied", rule: string) {
  reportAuditEvent({
    tenantId: tenant,
    event: "data_source.change",
    actorKind: "operator",
    targetKind: "destination_allowlist",
    outcome,
    rule,
  });
}

const args = parse(process.argv.slice(2));

switch (args.command) {
  case "add": {
    if (!args.tenant || !args.host || !args.port) {
      throw new Error("add needs --tenant, --host and --port");
    }
    const host = args.host.trim().toLowerCase();
    const id = `dallow-${randomUUID()}`;
    sql
      .prepare(
        `INSERT INTO destination_allowlist (id, tenant_id, host, port, allow_private, mac, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        id,
        args.tenant,
        host,
        args.port,
        args.allowPrivate ? 1 : 0,
        destinationAllowlistMac(args.tenant, host, args.port, !!args.allowPrivate),
        Date.now(),
      );
    audit(args.tenant, "ok", `add ${host}:${args.port}`);
    console.log(`added ${host}:${args.port} for tenant ${args.tenant}`);
    break;
  }
  case "remove": {
    if (!args.tenant || !args.host || !args.port) {
      throw new Error("remove needs --tenant, --host and --port");
    }
    const host = args.host.trim().toLowerCase();
    const n = sql
      .prepare("DELETE FROM destination_allowlist WHERE tenant_id = ? AND host = ? AND port = ?")
      .run(args.tenant, host, args.port).changes;
    audit(args.tenant, "ok", `remove ${host}:${args.port}`);
    console.log(`removed ${n} row(s)`);
    break;
  }
  case "list": {
    const rows = (
      args.tenant
        ? sql
            .prepare("SELECT tenant_id, host, port, allow_private FROM destination_allowlist WHERE tenant_id = ?")
            .all(args.tenant)
        : sql.prepare("SELECT tenant_id, host, port, allow_private FROM destination_allowlist").all()
    ) as Array<{
      tenant_id: string;
      host: string;
      port: number;
      allow_private: number;
    }>;
    for (const row of rows) {
      console.log(`${row.tenant_id}  ${row.host}:${row.port}  ${row.allow_private ? "allow-private" : "public-only"}`);
    }
    break;
  }
  default:
    console.error(
      "usage: destination-allowlist.ts <add|remove|list> --tenant <id> [--host h --port p] [--allow-private]",
    );
    process.exit(2);
}
