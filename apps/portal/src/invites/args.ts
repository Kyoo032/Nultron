/** Argument parsing for `pnpm --filter @agentforge/portal invite`. Its own file so the issuing stays testable. */

export const INVITE_DEFAULT_TTL_DAYS = 7;
export const INVITE_MAX_TTL_DAYS = 30;
const DEFAULT_TENANT = "nultron";
const LANGUAGES = ["en", "id"] as const;
export type InviteLanguage = (typeof LANGUAGES)[number];
const ROLES = ["owner", "admin", "member"] as const;
export type InviteRole = (typeof ROLES)[number];

/** One `@`, something either side, no whitespace. The portal does not validate deliverability. */
export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;
export const MAX_INVITE_EMAIL_LENGTH = 254;

export interface InviteArgs {
  readonly email: string;
  readonly tenantSlug: string;
  /** `null`: the tenant's only org. A tenant with several must be told which. */
  readonly orgSlug: string | null;
  readonly ttlDays: number;
  /**
   * The role the member holds once the invite is redeemed, or `null` when `--role` was not given.
   * An invite defaults a null to `member`; for an address that is already an active member, a role
   * that was GIVEN changes theirs and a null refuses (they need no invite).
   */
  readonly role: InviteRole | null;
  /** The language of the invite e-mail. The operator knows the tester; the portal does not. */
  readonly language: InviteLanguage;
  /** Print the code too. Off by default: it is e-mailed, and exists nowhere else. */
  readonly printCode: boolean;
}

export class InviteArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InviteArgsError";
  }
}

export const INVITE_USAGE = `Usage:
  pnpm --filter @agentforge/portal invite -- --email <address> [options]

Invites an address: creates the member in the "invited" state and e-mails them a one-time invite
code through the portal's mailer (the same SMTP config as sign-in codes; Mailpit locally). The
tester enters their address AND that code for their first sign-in; the portal then e-mails the usual
six-digit code. Later sign-ins need only that e-mailed code. Running it again for the same address
replaces the earlier invite.

Options:
  --email <address>   Required. The address the code is bound to.
  --tenant <slug>     Tenant slug                                  (default: ${DEFAULT_TENANT})
  --org-slug <slug>   Org slug. Omit it when the tenant has exactly one org.
  --ttl-days <n>      How long the code works, 1-${INVITE_MAX_TTL_DAYS} days        (default: ${INVITE_DEFAULT_TTL_DAYS})
  --role <role>       owner | admin | member: the role held once the invite is redeemed, and what
                      the host is told the person is. Default member. A tenant must always have an
                      owner, so the first invite for a tenant (and any that would leave it with none)
                      has to be --role owner. For an address that is already an active member this
                      CHANGES their role instead of inviting them.
  --lang <en|id>      Language of the invite e-mail                (default: en)
  --print             Also print the code, once. For an operator who has to hand it over another
                      way. Without it the code exists only in the e-mail.`;

/** Flags that take no value. Everything else wants one. */
const BARE_FLAGS: ReadonlySet<string> = new Set(["print"]);

export function parseInviteArgs(argv: readonly string[]): InviteArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  let pending: string | null = null;

  for (const token of argv) {
    // `pnpm run x -- --email a` forwards the separator on some versions; it carries no meaning.
    if (token === "--") {
      continue;
    }
    if (token.startsWith("--")) {
      if (pending !== null) {
        throw new InviteArgsError(`--${pending} needs a value.

${INVITE_USAGE}`);
      }
      const [name, inline] = token.slice(2).split("=", 2);
      if (BARE_FLAGS.has(name)) {
        flags.add(name);
        pending = null;
      } else if (inline !== undefined) {
        values.set(name, inline);
        pending = null;
      } else {
        pending = name;
      }
      continue;
    }
    if (pending === null) {
      throw new InviteArgsError(`Unexpected argument ${JSON.stringify(token)}.\n\n${INVITE_USAGE}`);
    }
    values.set(pending, token);
    pending = null;
  }

  if (pending !== null) {
    throw new InviteArgsError(`--${pending} needs a value.

${INVITE_USAGE}`);
  }

  const email = values.get("email")?.trim().toLowerCase();
  if (!email || !EMAIL_SHAPE.test(email) || email.length > MAX_INVITE_EMAIL_LENGTH) {
    throw new InviteArgsError(`--email <address> is required.\n\n${INVITE_USAGE}`);
  }

  const tenantSlug = (values.get("tenant") ?? DEFAULT_TENANT).trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(tenantSlug)) {
    throw new InviteArgsError(
      `--tenant must match ^[a-z][a-z0-9_]{1,30}$ (tenants_slug_format_chk); got ${JSON.stringify(tenantSlug)}`,
    );
  }

  const ttlRaw = values.get("ttl-days");
  const ttlDays = ttlRaw === undefined ? INVITE_DEFAULT_TTL_DAYS : Number(ttlRaw);
  if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > INVITE_MAX_TTL_DAYS) {
    throw new InviteArgsError(
      `--ttl-days must be a whole number of days between 1 and ${INVITE_MAX_TTL_DAYS}; got ${ttlRaw}`,
    );
  }

  const roleRaw = values.get("role")?.trim().toLowerCase();
  if (roleRaw !== undefined && !(ROLES as readonly string[]).includes(roleRaw)) {
    throw new InviteArgsError(`--role must be owner, admin or member; got ${JSON.stringify(roleRaw)}`);
  }

  const language = (values.get("lang") ?? "en").trim().toLowerCase();
  if (language !== "en" && language !== "id") {
    throw new InviteArgsError(`--lang must be en or id; got ${JSON.stringify(language)}`);
  }

  const orgSlug = values.get("org-slug")?.trim().toLowerCase();
  return Object.freeze({
    email,
    tenantSlug,
    orgSlug: orgSlug ? orgSlug : null,
    ttlDays,
    role: (roleRaw as InviteRole | undefined) ?? null,
    language,
    printCode: flags.has("print"),
  });
}
