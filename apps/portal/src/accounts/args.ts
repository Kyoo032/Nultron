/** Argument parsing for `pnpm --filter @agentforge/portal account`. Its own file so the operations stay testable. */
import { InvalidGatewayEndpointError, normaliseGatewayEndpoint } from "../gateway-endpoint";
import { EMAIL_SHAPE, MAX_INVITE_EMAIL_LENGTH } from "../invites/args";
import { isValidUsername, normaliseUsername } from "../password/policy";

const DEFAULT_TENANT = "nultron";
const ROLES = ["owner", "admin", "member", "auditor"] as const;
export type AccountRole = (typeof ROLES)[number];

export class AccountArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountArgsError";
  }
}

export const ACCOUNT_USAGE = `Usage:
  pnpm --filter @agentforge/portal account -- <command> [options]

For a portal running with PORTAL_SIGNIN_MODE=password. Nobody signs themselves up: an account exists
because an operator ran "create", and every password it ever has is handed out here or chosen by the
person at first sign-in.

Commands:
  create          Make a person who signs in with a username and a password.
                    --username <name>  --email <address>  [--role owner|admin|member|auditor]  [--name <display name>]  [--gateway-endpoint <url>]
                  Prints a generated initial password ONCE. The person must choose their own before a
                  session is issued. Refused when the org has no seat left. For an active person who has
                  no password yet (the owner "seed" made), it attaches the credential to them and ends
                  every session they already hold.
  reset-password  Issue a new initial password for a person: prints it once, ends every session they
                  hold, clears the failed attempts and any lock, and makes them choose a new one at next
                  sign-in.
                    --username <name> | --email <address>
  disable         Stop a person signing in and end every session they hold. Refused for the last owner.
                    --username <name> | --email <address>
  enable          Let a disabled person back in, with the password they had. Refused when no seat is left.
                    --username <name> | --email <address>
  set-role        Change an active person's role. Refused for the last owner.
                    --username <name> | --email <address>  --role owner|admin|member|auditor
  set-endpoint    Assign or clear a person's API gateway endpoint (Nultron admin only).
                    --username <name> | --email <address>  (--gateway-endpoint <url> | --clear)
  list            Everyone in the org: username, address, role, status, endpoint, password state, last
                  password seen, whether the account is locked, and how many times it was locked in the
                  last 24 hours. Prints no password and no hash.

Options for every command:
  --tenant <slug>    Tenant slug                                   (default: ${DEFAULT_TENANT})
  --org-slug <slug>  Org slug. Omit it when the tenant has exactly one org.

Usernames are 3 to 32 characters of a-z 0-9 . _ - and start with a letter or digit; they are lower case
and never contain @, so the sign-in form can take a username or an address in one field.`;

/** Flags that take no value. Everything else wants one. */
const BARE_FLAGS: ReadonlySet<string> = new Set(["clear"]);

interface Common {
  readonly tenantSlug: string;
  /** `null`: the tenant's only org. A tenant with several must be told which. */
  readonly orgSlug: string | null;
}

/** One person, named by exactly one of their username and their address. */
export type PersonRef =
  | { readonly by: "username"; readonly username: string }
  | { readonly by: "email"; readonly email: string };

export type AccountCommand =
  | (Common & {
      readonly command: "create";
      readonly username: string;
      readonly email: string;
      /** `null` when `--role` was not given: a new person is a `member`, and an existing one keeps theirs. */
      readonly role: AccountRole | null;
      readonly displayName: string | null;
      /** Operator-assigned gateway base URL, or `null` for the default pinned gateway. */
      readonly gatewayEndpoint: string | null;
    })
  | (Common & { readonly command: "reset-password"; readonly person: PersonRef })
  | (Common & { readonly command: "disable"; readonly person: PersonRef })
  | (Common & { readonly command: "enable"; readonly person: PersonRef })
  | (Common & { readonly command: "set-role"; readonly person: PersonRef; readonly role: AccountRole })
  | (Common & {
      readonly command: "set-endpoint";
      readonly person: PersonRef;
      /** Target gateway base URL, or `null` when `--clear` resets to the default pinned gateway. */
      readonly gatewayEndpoint: string | null;
    })
  | (Common & { readonly command: "list" });

function collect(
  argv: readonly string[],
): { readonly words: string[]; readonly values: Map<string, string>; readonly flags: Set<string> } {
  const words: string[] = [];
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
        throw new AccountArgsError(`--${pending} needs a value.\n\n${ACCOUNT_USAGE}`);
      }
      const [name, inline] = token.slice(2).split("=", 2);
      if (BARE_FLAGS.has(name)) {
        flags.add(name);
        continue;
      }
      if (inline !== undefined) {
        values.set(name, inline);
      } else {
        pending = name;
      }
      continue;
    }
    if (pending !== null) {
      values.set(pending, token);
      pending = null;
    } else {
      words.push(token);
    }
  }
  if (pending !== null) {
    throw new AccountArgsError(`--${pending} needs a value.\n\n${ACCOUNT_USAGE}`);
  }
  return { words, values, flags };
}

function readEmail(raw: string | undefined): string {
  const email = raw?.trim().toLowerCase();
  if (!email || !EMAIL_SHAPE.test(email) || email.length > MAX_INVITE_EMAIL_LENGTH) {
    throw new AccountArgsError(`--email <address> is required and must be an e-mail address.\n\n${ACCOUNT_USAGE}`);
  }
  return email;
}

function readUsername(raw: string | undefined): string {
  const username = raw === undefined ? "" : normaliseUsername(raw);
  if (!isValidUsername(username)) {
    throw new AccountArgsError(
      `--username must be 3 to 32 characters of a-z 0-9 . _ - starting with a letter or digit (got ${JSON.stringify(raw ?? "")}).\n\n${ACCOUNT_USAGE}`,
    );
  }
  return username;
}

/** The role named, or `null` when none was. */
function readRole(raw: string | undefined): AccountRole | null {
  const role = raw?.trim().toLowerCase();
  if (role === undefined) {
    return null;
  }
  if (!(ROLES as readonly string[]).includes(role)) {
    throw new AccountArgsError(`--role must be owner, admin, member or auditor; got ${JSON.stringify(role)}`);
  }
  return role as AccountRole;
}

function requireRole(raw: string | undefined): AccountRole {
  const role = readRole(raw);
  if (role === null) {
    throw new AccountArgsError(`--role owner|admin|member|auditor is required.\n\n${ACCOUNT_USAGE}`);
  }
  return role;
}

function readPerson(values: Map<string, string>): PersonRef {
  const username = values.get("username");
  const email = values.get("email");
  if ((username === undefined) === (email === undefined)) {
    throw new AccountArgsError(`Name the person with exactly one of --username and --email.\n\n${ACCOUNT_USAGE}`);
  }
  return username !== undefined
    ? { by: "username", username: readUsername(username) }
    : { by: "email", email: readEmail(email) };
}

function readGatewayEndpoint(raw: string | undefined): string | null {
  if (raw === undefined) {
    return null;
  }
  try {
    return normaliseGatewayEndpoint(raw);
  } catch (error) {
    if (error instanceof InvalidGatewayEndpointError) {
      throw new AccountArgsError(`${error.message}\n\n${ACCOUNT_USAGE}`);
    }
    throw error;
  }
}

export function parseAccountArgs(argv: readonly string[]): AccountCommand {
  const { words, values, flags } = collect(argv);
  if (words.length !== 1) {
    throw new AccountArgsError(
      words.length === 0 ? `Say which command.\n\n${ACCOUNT_USAGE}` : `One command at a time.\n\n${ACCOUNT_USAGE}`,
    );
  }

  const tenantSlug = (values.get("tenant") ?? DEFAULT_TENANT).trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(tenantSlug)) {
    throw new AccountArgsError(
      `--tenant must match ^[a-z][a-z0-9_]{1,30}$ (tenants_slug_format_chk); got ${JSON.stringify(tenantSlug)}`,
    );
  }
  const orgSlug = values.get("org-slug")?.trim().toLowerCase();
  const common: Common = { tenantSlug, orgSlug: orgSlug ? orgSlug : null };

  const command = words[0];
  switch (command) {
    case "create": {
      const displayName = values.get("name")?.trim();
      return Object.freeze({
        ...common,
        command,
        username: readUsername(values.get("username")),
        email: readEmail(values.get("email")),
        role: readRole(values.get("role")),
        displayName: displayName ? displayName.slice(0, 120) : null,
        gatewayEndpoint: readGatewayEndpoint(values.get("gateway-endpoint")),
      });
    }
    case "reset-password":
    case "disable":
    case "enable":
      return Object.freeze({ ...common, command, person: readPerson(values) });
    case "set-role":
      return Object.freeze({
        ...common,
        command,
        person: readPerson(values),
        role: requireRole(values.get("role")),
      });
    case "set-endpoint": {
      const hasUrl = values.has("gateway-endpoint");
      const hasClear = flags.has("clear");
      if (hasUrl === hasClear) {
        throw new AccountArgsError(
          `Pass exactly one of --gateway-endpoint <url> or --clear.\n\n${ACCOUNT_USAGE}`,
        );
      }
      return Object.freeze({
        ...common,
        command,
        person: readPerson(values),
        gatewayEndpoint: hasClear ? null : readGatewayEndpoint(values.get("gateway-endpoint")),
      });
    }
    case "list":
      return Object.freeze({ ...common, command });
    default:
      throw new AccountArgsError(`Unknown command ${JSON.stringify(command)}.\n\n${ACCOUNT_USAGE}`);
  }
}
