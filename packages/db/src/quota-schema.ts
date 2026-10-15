import type Database from "better-sqlite3";

export const QUOTA_TABLES = [
  "company_quota_settings",
  "company_groups",
  "company_group_members",
  "quota_allocations",
  "quota_allocation_models",
  "quota_assignments",
  "quota_person_usage",
  "quota_holds",
  "quota_audit",
] as const;

export const QUOTA_AUDIT_ACTIONS = [
  "quota.enable",
  "quota.disable",
  "quota.cap",
  "allocation.create",
  "allocation.update",
  "allocation.pause",
  "allocation.resume",
  "allocation.archive",
  "allocation.assign",
  "allocation.unassign",
  "group.create",
  "group.delete",
  "group.member.add",
  "group.member.remove",
] as const;

const MICROS_MAX = 1_000_000_000_000;
const MICROS = `BETWEEN 0 AND ${MICROS_MAX}`;

const TENANT_USAGE_QUOTA_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["allocation_id", "text"],
  ["purpose", "text"],
  ["hold_id", "text"],
  ["agent_id", "text"],
  ["project_id", "text"],
];

const TENANT_GUARDED_TABLES = [
  "company_quota_settings",
  "company_groups",
  "quota_allocations",
  "quota_holds",
  "quota_audit",
] as const;

function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

const QUOTA_DDL = `
    CREATE TABLE IF NOT EXISTS company_quota_settings (
      organization_id text PRIMARY KEY NOT NULL REFERENCES organizations(id) ON DELETE cascade,
      tenant_id text NOT NULL,
      enabled integer DEFAULT 0 NOT NULL,
      enabled_at integer,
      enabled_by text,
      company_cap_micros integer,
      version integer DEFAULT 1 NOT NULL,
      CONSTRAINT company_quota_settings_enabled_check CHECK (enabled IN (0, 1)),
      CONSTRAINT company_quota_settings_cap_check CHECK (company_cap_micros IS NULL OR company_cap_micros ${MICROS}),
      CONSTRAINT company_quota_settings_version_check CHECK (version >= 1)
    );
    CREATE TABLE IF NOT EXISTS company_groups (
      id text PRIMARY KEY NOT NULL,
      organization_id text NOT NULL REFERENCES organizations(id) ON DELETE cascade,
      tenant_id text NOT NULL,
      name text NOT NULL,
      created_by text NOT NULL,
      created_at integer NOT NULL,
      archived_at integer,
      CONSTRAINT company_groups_name_check CHECK (length(trim(name)) > 0)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS company_groups_org_name ON company_groups (organization_id, lower(name));
    CREATE TABLE IF NOT EXISTS company_group_members (
      group_id text NOT NULL REFERENCES company_groups(id) ON DELETE cascade,
      user_id text NOT NULL,
      added_by text NOT NULL,
      added_at integer NOT NULL,
      PRIMARY KEY (group_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS company_group_members_user_idx ON company_group_members (user_id);
    CREATE TABLE IF NOT EXISTS quota_allocations (
      id text PRIMARY KEY NOT NULL,
      organization_id text NOT NULL REFERENCES organizations(id) ON DELETE cascade,
      tenant_id text NOT NULL,
      name text NOT NULL,
      scope_kind text NOT NULL,
      limit_micros integer NOT NULL,
      per_person_limit_micros integer,
      period_kind text NOT NULL,
      period_start integer,
      spent_micros integer DEFAULT 0 NOT NULL,
      held_micros integer DEFAULT 0 NOT NULL,
      models_mode text DEFAULT 'all' NOT NULL,
      priority integer DEFAULT 0 NOT NULL,
      status text DEFAULT 'active' NOT NULL,
      gateway_token_id text,
      version integer DEFAULT 1 NOT NULL,
      created_by text NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      CONSTRAINT quota_allocations_scope_check CHECK (scope_kind IN ('everyone', 'groups', 'people', 'admins')),
      CONSTRAINT quota_allocations_limit_check CHECK (limit_micros ${MICROS}),
      CONSTRAINT quota_allocations_per_person_check CHECK (per_person_limit_micros IS NULL OR per_person_limit_micros ${MICROS}),
      CONSTRAINT quota_allocations_period_check CHECK (period_kind IN ('lifetime', 'monthly')),
      CONSTRAINT quota_allocations_spent_check CHECK (spent_micros >= 0),
      CONSTRAINT quota_allocations_held_check CHECK (held_micros >= 0),
      CONSTRAINT quota_allocations_models_check CHECK (models_mode IN ('all', 'list')),
      CONSTRAINT quota_allocations_status_check CHECK (status IN ('active', 'paused', 'archived')),
      CONSTRAINT quota_allocations_version_check CHECK (version >= 1)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS quota_allocations_live_everyone ON quota_allocations (organization_id)
      WHERE scope_kind = 'everyone' AND status <> 'archived';
    CREATE UNIQUE INDEX IF NOT EXISTS quota_allocations_live_admins ON quota_allocations (organization_id)
      WHERE scope_kind = 'admins' AND status <> 'archived';
    CREATE INDEX IF NOT EXISTS quota_allocations_org_status_idx ON quota_allocations (organization_id, status);
    CREATE TABLE IF NOT EXISTS quota_allocation_models (
      allocation_id text NOT NULL REFERENCES quota_allocations(id) ON DELETE cascade,
      model_id text NOT NULL,
      PRIMARY KEY (allocation_id, model_id),
      CONSTRAINT quota_allocation_models_normal_check CHECK (model_id = lower(trim(model_id)) AND length(model_id) > 0)
    );
    CREATE TABLE IF NOT EXISTS quota_assignments (
      allocation_id text NOT NULL REFERENCES quota_allocations(id) ON DELETE cascade,
      subject_kind text NOT NULL,
      subject_id text NOT NULL,
      PRIMARY KEY (allocation_id, subject_kind, subject_id),
      CONSTRAINT quota_assignments_kind_check CHECK (subject_kind IN ('person', 'group'))
    );
    CREATE INDEX IF NOT EXISTS quota_assignments_subject_idx ON quota_assignments (subject_kind, subject_id);
    CREATE TABLE IF NOT EXISTS quota_person_usage (
      allocation_id text NOT NULL REFERENCES quota_allocations(id) ON DELETE cascade,
      user_id text NOT NULL,
      period_start integer NOT NULL,
      spent_micros integer DEFAULT 0 NOT NULL,
      held_micros integer DEFAULT 0 NOT NULL,
      PRIMARY KEY (allocation_id, user_id, period_start),
      CONSTRAINT quota_person_usage_spent_check CHECK (spent_micros >= 0),
      CONSTRAINT quota_person_usage_held_check CHECK (held_micros >= 0)
    );
    CREATE TABLE IF NOT EXISTS quota_holds (
      id text PRIMARY KEY NOT NULL,
      allocation_id text NOT NULL REFERENCES quota_allocations(id) ON DELETE cascade,
      organization_id text NOT NULL REFERENCES organizations(id) ON DELETE cascade,
      tenant_id text NOT NULL,
      user_id text NOT NULL,
      run_id text NOT NULL,
      seq integer NOT NULL,
      boot_id text NOT NULL,
      kind text NOT NULL,
      model text NOT NULL,
      amount_micros integer NOT NULL,
      state text DEFAULT 'open' NOT NULL,
      settled_micros integer,
      cost_basis text,
      created_at integer NOT NULL,
      expires_at integer NOT NULL,
      closed_at integer,
      CONSTRAINT quota_holds_kind_check CHECK (kind IN ('text', 'image', 'video', 'music', 'audio')),
      CONSTRAINT quota_holds_amount_check CHECK (amount_micros ${MICROS}),
      CONSTRAINT quota_holds_state_check CHECK (state IN ('open', 'settled', 'released', 'expired')),
      CONSTRAINT quota_holds_settled_check CHECK (settled_micros IS NULL OR settled_micros ${MICROS}),
      CONSTRAINT quota_holds_cost_basis_check CHECK (cost_basis IS NULL OR cost_basis IN ('reported', 'list_price', 'estimated', 'expired_charge')),
      CONSTRAINT quota_holds_seq_check CHECK (seq >= 0)
    );
    CREATE INDEX IF NOT EXISTS quota_holds_allocation_state_idx ON quota_holds (allocation_id, state);
    CREATE INDEX IF NOT EXISTS quota_holds_run_idx ON quota_holds (run_id, seq);
    CREATE INDEX IF NOT EXISTS quota_holds_state_expiry_idx ON quota_holds (state, expires_at);
    CREATE INDEX IF NOT EXISTS quota_holds_boot_idx ON quota_holds (boot_id, state);
    CREATE TABLE IF NOT EXISTS quota_audit (
      id text PRIMARY KEY NOT NULL,
      organization_id text NOT NULL REFERENCES organizations(id) ON DELETE cascade,
      tenant_id text NOT NULL,
      actor_user_id text NOT NULL,
      action text NOT NULL,
      allocation_id text,
      detail text,
      at integer NOT NULL,
      CONSTRAINT quota_audit_action_check CHECK (action IN (${inList(QUOTA_AUDIT_ACTIONS)}))
    );
    CREATE INDEX IF NOT EXISTS quota_audit_org_at_idx ON quota_audit (organization_id, at);
  `;

function tenantGuards(table: string): string {
  const mismatch = `NEW.tenant_id IS NOT (SELECT o.tenant_id FROM organizations o WHERE o.id = NEW.organization_id)`;
  return `
    CREATE TRIGGER IF NOT EXISTS ${table}_tenant_insert_guard BEFORE INSERT ON ${table}
      WHEN ${mismatch} BEGIN SELECT RAISE(ABORT, 'quota_tenant_mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_tenant_update_guard BEFORE UPDATE OF tenant_id, organization_id ON ${table}
      WHEN ${mismatch} BEGIN SELECT RAISE(ABORT, 'quota_tenant_mismatch'); END;`;
}

const GROUP_MEMBER_NOT_IN_ORGANIZATION = `NOT EXISTS (
        SELECT 1 FROM company_groups g
          JOIN organization_members m ON m.organization_id = g.organization_id
         WHERE g.id = NEW.group_id AND m.user_id = NEW.user_id)`;

const PERSON_SUBJECT_NOT_MEMBER = `NEW.subject_kind = 'person' AND NOT EXISTS (
        SELECT 1 FROM quota_allocations a
          JOIN organization_members m ON m.organization_id = a.organization_id
         WHERE a.id = NEW.allocation_id AND m.user_id = NEW.subject_id)`;

const GROUP_SUBJECT_OUTSIDE_ORGANIZATION = `NEW.subject_kind = 'group' AND NOT EXISTS (
        SELECT 1 FROM quota_allocations a
          JOIN company_groups g ON g.organization_id = a.organization_id
         WHERE a.id = NEW.allocation_id AND g.id = NEW.subject_id)`;

const MEMBERSHIP_GUARDS = `
    CREATE TRIGGER IF NOT EXISTS company_group_members_member_insert_guard BEFORE INSERT ON company_group_members
      WHEN ${GROUP_MEMBER_NOT_IN_ORGANIZATION}
      BEGIN SELECT RAISE(ABORT, 'quota_group_member_not_in_organization'); END;
    CREATE TRIGGER IF NOT EXISTS company_group_members_member_update_guard BEFORE UPDATE OF group_id, user_id ON company_group_members
      WHEN ${GROUP_MEMBER_NOT_IN_ORGANIZATION}
      BEGIN SELECT RAISE(ABORT, 'quota_group_member_not_in_organization'); END;
    CREATE TRIGGER IF NOT EXISTS quota_assignments_person_insert_guard BEFORE INSERT ON quota_assignments
      WHEN ${PERSON_SUBJECT_NOT_MEMBER}
      BEGIN SELECT RAISE(ABORT, 'quota_subject_not_member'); END;
    CREATE TRIGGER IF NOT EXISTS quota_assignments_person_update_guard BEFORE UPDATE OF allocation_id, subject_kind, subject_id ON quota_assignments
      WHEN ${PERSON_SUBJECT_NOT_MEMBER}
      BEGIN SELECT RAISE(ABORT, 'quota_subject_not_member'); END;
    CREATE TRIGGER IF NOT EXISTS quota_assignments_group_insert_guard BEFORE INSERT ON quota_assignments
      WHEN ${GROUP_SUBJECT_OUTSIDE_ORGANIZATION}
      BEGIN SELECT RAISE(ABORT, 'quota_group_outside_organization'); END;
    CREATE TRIGGER IF NOT EXISTS quota_assignments_group_update_guard BEFORE UPDATE OF allocation_id, subject_kind, subject_id ON quota_assignments
      WHEN ${GROUP_SUBJECT_OUTSIDE_ORGANIZATION}
      BEGIN SELECT RAISE(ABORT, 'quota_group_outside_organization'); END;`;

function ensureTenantUsageQuotaColumns(sqlite: Database.Database): void {
  const existing = new Set(
    (sqlite.prepare("PRAGMA table_info(tenant_usage)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (existing.size === 0) {
    return;
  }
  for (const [name, type] of TENANT_USAGE_QUOTA_COLUMNS) {
    if (!existing.has(name)) {
      sqlite.exec(`ALTER TABLE \`tenant_usage\` ADD \`${name}\` ${type}`);
    }
  }
  sqlite.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS tenant_usage_hold_idx ON tenant_usage (hold_id) WHERE hold_id IS NOT NULL",
  );
}

export function ensureQuotaTables(sqlite: Database.Database): void {
  sqlite.exec(QUOTA_DDL);
  sqlite.exec(TENANT_GUARDED_TABLES.map(tenantGuards).join("\n"));
  sqlite.exec(MEMBERSHIP_GUARDS);
  ensureTenantUsageQuotaColumns(sqlite);
}
