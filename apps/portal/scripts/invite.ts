#!/usr/bin/env tsx
/**
 * `pnpm --filter @agentforge/portal invite -- --email <address> [--tenant nultron] [--org-slug kyo]
 *                                              [--ttl-days 7] [--lang en|id] [--print]`
 *
 * A thin shell around `issueInvite` and `mailInvite`: parse, migrate as the owner, open the
 * server's connection, issue, e-mail, print, close. Everything worth testing is in `src/invites/`.
 * It writes through the same role the server uses, so what it writes is exactly what the server's
 * tenant policies let it.
 *
 * The invite code is e-mailed to the address through the portal's own mailer, and printed only with
 * `--print`. Unlike `portal:otp` there is no environment switch and it is not refused in
 * production: this is how a first sign-in is earned, and what it makes opens exactly one door --
 * the first sign-in of one address -- after which the tester still proves the mailbox with the
 * e-mailed six-digit code.
 */
import { mkdir } from "node:fs/promises";
import { migrateAsOwner } from "../src/boot";
import { loadConfig, PortalConfigError } from "../src/config";
import { createLogger } from "../src/log";
import {
  changeMemberRole,
  formatInviteReport,
  formatRoleReport,
  InviteArgsError,
  issueInvite,
  mailInvite,
  parseInviteArgs,
  type ChangeRoleRefusal,
  type IssueInviteRefusal,
} from "../src/invites";
import { createMailer } from "../src/mail";
import { openStore } from "../src/store";

const REFUSALS: Readonly<Record<IssueInviteRefusal, { readonly code: number; readonly message: string }>> = {
  invalid_email: { code: 2, message: "That is not an e-mail address." },
  invalid_gateway_endpoint: {
    code: 2,
    message: "--gateway-endpoint must be a valid HTTPS URL without credentials, query string, or fragment.",
  },
  unknown_tenant: { code: 3, message: "No tenant has that slug. Seed it first with `pnpm portal:seed`." },
  unknown_org: { code: 3, message: "That tenant has no org with that slug." },
  choose_org: { code: 3, message: "That tenant has more than one org. Say which with --org-slug." },
  org_mismatch: {
    code: 3,
    message: "That address is already invited into a different org. An invite does not move a member.",
  },
  already_member: {
    code: 4,
    message: "That address is already an active member. It needs no invite: it signs in with the e-mailed code.",
  },
  user_disabled: {
    code: 4,
    message: "That member is disabled. An invite is not how somebody is let back in.",
  },
  other_tenant: {
    code: 4,
    message:
      "That address already belongs to another tenant. An address in two tenants is sent no sign-in code, so the tester could never get in.",
  },
  owner_required: {
    code: 5,
    message:
      "Every tenant needs an owner. This tenant has none who is not disabled (or this invite would leave it with none), so the invite has to be --role owner.",
  },
};

const ROLE_REFUSALS: Readonly<Record<ChangeRoleRefusal, { readonly code: number; readonly message: string }>> = {
  unknown_tenant: REFUSALS.unknown_tenant,
  not_a_member: { code: 4, message: "That address is not a member of this tenant." },
  not_active: {
    code: 4,
    message: "That member has not redeemed their invite yet, so the role is the invite's: re-invite them with --role.",
  },
  user_disabled: REFUSALS.user_disabled,
  same_role: { code: 4, message: "That member already has that role." },
  last_owner: {
    code: 5,
    message: "That member is the tenant's last owner. Make someone else an owner first, then change this one.",
  },
};

/** The mail transport refused the invite. The invite exists; nobody has its code. */
const MAIL_FAILED_EXIT = 7;

async function main(): Promise<void> {
  const args = parseInviteArgs(process.argv.slice(2));
  const config = loadConfig();
  if (config.signInMode === "password") {
    // An invite is the e-mailed-code sign-in's first door, and that sign-in does not exist here.
    console.error(
      "Refused: this portal signs people in with a username and a password (PORTAL_SIGNIN_MODE=password), so\n" +
        "there is no invite to issue and no e-mail goes out. Make the person with:\n\n" +
        "    portal.sh account create --username <name> --email <address>",
    );
    process.exit(3);
  }
  await mkdir(config.dataDir, { recursive: true });

  await migrateAsOwner(config);
  const log = createLogger();
  const store = openStore(config);
  const mailer = createMailer(config, log);
  try {
    const result = await issueInvite(store, {
      tenantSlug: args.tenantSlug,
      orgSlug: args.orgSlug,
      email: args.email,
      role: args.role ?? undefined,
      ttlMs: args.ttlDays * 24 * 60 * 60 * 1000,
      gatewayEndpoint: args.gatewayEndpoint,
    });
    if (!result.ok && result.reason === "already_member" && args.role !== null) {
      // An active member needs no invite. Given a role, this is how it is changed -- here, by the
      // operator, and nowhere else.
      const changed = await changeMemberRole(store, { tenantSlug: args.tenantSlug, email: args.email, role: args.role });
      if (!changed.ok) {
        const refusal = ROLE_REFUSALS[changed.reason];
        console.error(`Refused: ${refusal.message}`);
        process.exitCode = refusal.code;
        return;
      }
      process.stdout.write(`${formatRoleReport(changed)}
`);
      return;
    }
    if (!result.ok) {
      const refusal = REFUSALS[result.reason];
      console.error(`Refused: ${refusal.message}`);
      process.exitCode = refusal.code;
      return;
    }

    const mailed = await mailInvite(
      { store, mailer, log },
      {
        tenantId: result.tenantId,
        orgId: result.orgId,
        inviteId: result.inviteId,
        code: result.code,
        email: result.email,
        expiresAt: result.expiresAt,
        locale: args.language,
        action: "invite.mailed",
      },
    );

    if (mailed === "failed" && !args.printCode) {
      // The code is not printed, so the invite just made is unusable: say so and how to fix it.
      console.error(
        "The invite was created but the e-mail could not be sent (see the log for the transport error).\n" +
          "Nobody has the code. Fix the mail configuration and run this again, or run it with --print to\n" +
          "read a new code out yourself. Either way it replaces the invite that was just created.",
      );
      process.exitCode = MAIL_FAILED_EXIT;
      return;
    }
    process.stdout.write(`${formatInviteReport(result, { mailed: mailed === "sent", printCode: args.printCode })}\n`);
    if (mailed === "failed") {
      process.exitCode = MAIL_FAILED_EXIT;
    }
  } finally {
    await mailer.close();
    await store.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof InviteArgsError || error instanceof PortalConfigError) {
    console.error(error.message);
    process.exit(2);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
