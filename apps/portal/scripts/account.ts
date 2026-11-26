#!/usr/bin/env tsx
/**
 * `pnpm --filter @agentforge/portal account -- <command> [options]`
 *
 * The operator's tool for a portal running with `PORTAL_SIGNIN_MODE=password`: create a person with a
 * username and a generated initial password, reset a password, disable and enable a person, change a
 * role, list everyone. A thin shell around `src/accounts/`: parse, migrate as the owner, open the
 * server's connection, do it, print, close. Everything worth testing is in `src/accounts/`.
 *
 * It runs through the deploy bundle's wrapper exactly like `seed` and `invite` do, from the host:
 *
 *     sh webapp-deploy/scripts/portal.sh account create --username hyp.alice --email alice@example.com
 *
 * Nothing here prompts: it reads arguments, writes to stdout and exits, so it works with `exec -T`
 * (no terminal) and can be redirected. A generated password is printed to STDOUT once and is in no
 * file, log line or audit row; only its scrypt hash is stored.
 *
 * Refused unless the portal is in password mode (`PORTAL_SIGNIN_MODE=password` in the environment this
 * runs in, which in the bundle is the portal container's own): a password account on a portal that
 * signs people in by e-mailed code would be a credential nothing reads, and nothing about the default
 * mode should change because somebody ran the wrong command.
 */
import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import {
  ACCOUNT_USAGE,
  AccountArgsError,
  createAccount,
  disableAccount,
  enableAccount,
  formatCreated,
  formatList,
  formatReset,
  listAccounts,
  parseAccountArgs,
  resetPassword,
  setAccountEndpoint,
  setAccountRole,
  type AccountCommand,
  type AccountDeps,
  type CreateAccountRefusal,
  type DisableRefusal,
  type EnableRefusal,
  type ListRefusal,
  type PersonRefusal,
  type SetEndpointRefusal,
  type SetRoleRefusal,
} from "../src/accounts";
import { migrateAsOwner } from "../src/boot";
import { loadConfig, PortalConfigError } from "../src/config";
import { createPasswordHasher } from "../src/password";
import { keyFromSeed } from "../src/jwt/keys";
import { sealGatewayKey } from "../src/gateway-key";
import { openStore } from "../src/store";

interface Refusal {
  readonly code: number;
  readonly message: string;
}

const UNKNOWN_TENANT: Refusal = {
  code: 3,
  message: "No tenant has that slug. Seed it first with `portal.sh seed`.",
};
const UNKNOWN_ORG: Refusal = { code: 3, message: "That tenant has no org with that slug." };
const CHOOSE_ORG: Refusal = { code: 3, message: "That tenant has more than one org. Say which with --org-slug." };
const NOT_FOUND: Refusal = {
  code: 3,
  message: "Nobody in this tenant has that username or address with a password. `account list` shows who does.",
};
const SEAT_CAP: Refusal = {
  code: 5,
  message:
    "The org has no seat left (people on record who are not disabled fill the seat cap). Disable somebody or raise the cap.",
};
const LAST_OWNER: Refusal = {
  code: 5,
  message: "That person is the tenant's last owner who is not disabled. Make someone else an owner first.",
};

const CREATE_REFUSALS: Readonly<Record<CreateAccountRefusal, Refusal>> = {
  unknown_tenant: UNKNOWN_TENANT,
  unknown_org: UNKNOWN_ORG,
  choose_org: CHOOSE_ORG,
  org_mismatch: { code: 4, message: "That address is already a person in a different org of this tenant." },
  username_taken: { code: 4, message: "That username is already taken in this tenant." },
  already_has_account: { code: 4, message: "That person already has a password. Use reset-password to issue another." },
  user_disabled: { code: 4, message: "That person is disabled. Use enable to let them back in." },
  user_invited: {
    code: 4,
    message:
      "That address is an invited person left over from the e-mailed-code sign-in. It has no invite to redeem here.",
  },
  role_mismatch: {
    code: 4,
    message: "That person already exists with a different role. Create without --role, then change it with set-role.",
  },
  seat_cap_reached: SEAT_CAP,
  invalid_gateway_endpoint: {
    code: 2,
    message: "--gateway-endpoint must be a valid HTTPS URL without credentials, query string, or fragment.",
  },
};

const PERSON_REFUSALS: Readonly<Record<PersonRefusal, Refusal>> = {
  unknown_tenant: UNKNOWN_TENANT,
  not_found: NOT_FOUND,
};

const DISABLE_REFUSALS: Readonly<Record<DisableRefusal, Refusal>> = {
  ...PERSON_REFUSALS,
  already_disabled: { code: 4, message: "That person is already disabled." },
  last_owner: LAST_OWNER,
};

const ENABLE_REFUSALS: Readonly<Record<EnableRefusal, Refusal>> = {
  ...PERSON_REFUSALS,
  not_disabled: { code: 4, message: "That person is not disabled." },
  seat_cap_reached: SEAT_CAP,
};

const LIST_REFUSALS: Readonly<Record<ListRefusal, Refusal>> = {
  unknown_tenant: UNKNOWN_TENANT,
  unknown_org: UNKNOWN_ORG,
  choose_org: CHOOSE_ORG,
};

const ROLE_REFUSALS: Readonly<Record<SetRoleRefusal, Refusal>> = {
  ...PERSON_REFUSALS,
  not_a_member: NOT_FOUND,
  not_active: { code: 4, message: "That person is not active." },
  user_disabled: { code: 4, message: "That person is disabled. Enable them first." },
  same_role: { code: 4, message: "That person already has that role." },
  last_owner: LAST_OWNER,
};

const ENDPOINT_REFUSALS: Readonly<Record<SetEndpointRefusal, Refusal>> = {
  ...PERSON_REFUSALS,
  user_disabled: { code: 4, message: "That person is disabled. Enable them first." },
  same_endpoint: { code: 4, message: "That person already has that gateway endpoint." },
  invalid_gateway_endpoint: {
    code: 2,
    message: "--gateway-endpoint must be a valid HTTPS URL without credentials, query string, or fragment.",
  },
  key_wrap_unavailable: {
    code: 3,
    message: "This portal cannot seal an endpoint key: PORTAL_SIGNING_KEY is not set.",
  },
};

function say(text: string): void {
  process.stdout.write(`${text}\n`);
}

function refuse(refusal: Refusal): void {
  console.error(`Refused: ${refusal.message}`);
  process.exitCode = refusal.code;
}

async function run(command: AccountCommand, deps: AccountDeps): Promise<void> {
  switch (command.command) {
    case "create": {
      const result = await createAccount(deps, command);
      if (result.ok) {
        say(formatCreated(result));
      } else {
        refuse(CREATE_REFUSALS[result.reason]);
      }
      return;
    }
    case "reset-password": {
      const result = await resetPassword(deps, command);
      if (result.ok) {
        say(formatReset(result));
      } else {
        refuse(PERSON_REFUSALS[result.reason]);
      }
      return;
    }
    case "disable": {
      const result = await disableAccount(deps, command);
      if (result.ok) {
        say(`${result.username} (${result.email}) is disabled and signed out everywhere.`);
      } else {
        refuse(DISABLE_REFUSALS[result.reason]);
      }
      return;
    }
    case "enable": {
      const result = await enableAccount(deps, command);
      if (result.ok) {
        say(`${result.username} (${result.email}) is active again, with the password they had.`);
      } else {
        refuse(ENABLE_REFUSALS[result.reason]);
      }
      return;
    }
    case "set-role": {
      const result = await setAccountRole(deps, command);
      if (result.ok) {
        say(
          `${result.username} (${result.email}): role ${result.from} -> ${result.to}. ` +
            "It reaches the host in the person's next token.",
        );
      } else {
        refuse(ROLE_REFUSALS[result.reason]);
      }
      return;
    }
    case "set-endpoint": {
      // The key comes over stdin only: never an argv string, never a URL (F11's rule, applied here).
      const gatewayKey = command.keyFromStdin ? await readStdinKey() : undefined;
      // An invalid stdin read already refused; nothing reaches the write.
      if (command.keyFromStdin && gatewayKey === null) {
        return;
      }
      const result = await setAccountEndpoint(deps, { ...command, gatewayKey });
      if (result.ok) {
        say(
          `${result.username} (${result.email}): endpoint ${result.from ?? "default"} -> ${result.to ?? "default"}. ` +
            "It reaches the host in the person's next token.",
        );
      } else {
        refuse(ENDPOINT_REFUSALS[result.reason]);
      }
      return;
    }
    case "list": {
      const result = await listAccounts(deps, command);
      if (result.ok) {
        say(formatList(result));
      } else {
        refuse(LIST_REFUSALS[result.reason]);
      }
      return;
    }
    default: {
      const unhandled: never = command;
      return unhandled;
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    say(ACCOUNT_USAGE);
    return;
  }
  const command = parseAccountArgs(argv);
  const config = loadConfig();
  // `set-endpoint` works in either sign-in mode: assigning a gateway endpoint (and issuing its key)
  // touches the member's own row, nothing the password stack owns.
  if (config.signInMode !== "password" && command.command !== "set-endpoint") {
    console.error(
      "Refused: this portal is not in password mode (PORTAL_SIGNIN_MODE is not set to password where this runs).\n" +
        "The accounts this command makes are read only by a portal that signs people in with a username and a\n" +
        "password. For the e-mailed-code sign-in, use the invite command instead. `set-endpoint` works in\n" +
        "either mode.",
    );
    process.exit(3);
  }
  await mkdir(config.dataDir, { recursive: true });

  await migrateAsOwner(config);
  const store = openStore(config);
  try {
    await run(command, {
      store,
      passwords: createPasswordHasher(),
      clock: store.clock,
      // Seals under the same signing key the server opens with; an unconfigured dev portal (ephemeral
      // key) has no stable key to seal under, so the script refuses to seal rather than strand it.
      sealEndpointKey: config.signingKey
        ? (raw) => sealGatewayKey(raw, keyFromSeed(config.signingKey as Buffer))
        : (raw) => {
            throw new PortalConfigError(["PORTAL_SIGNING_KEY is unset: there is no stable key to seal the endpoint key under."]);
          },
    });
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof AccountArgsError || error instanceof PortalConfigError) {
    console.error(error.message);
    process.exit(2);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

/**
 * `--key-stdin`: the key arrives on stdin and nowhere else — never an argument, a URL or a log line.
 * Trimmed once; anything empty or multi-line is refused, because a pasted block is not a key.
 */
async function readStdinKey(): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, terminal: false });
  let text = "";
  for await (const line of rl) {
    text += `${line}\n`;
  }
  const key = text.trim();
  if (!key || key.includes("\n") || key.includes("\r")) {
    refuse({ code: 3, message: "Pass exactly one line on stdin: the endpoint's bearer key." });
    // `refuse` only sets the exit code, so the caller must bail on null: nothing reaches the write.
    return null;
  }
  return key;
}
