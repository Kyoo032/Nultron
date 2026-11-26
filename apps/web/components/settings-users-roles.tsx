"use client";

import { useState } from "react";
import { t } from "@/lib/i18n";
import { useSession } from "@/lib/session";

const ROLES = ["owner", "admin", "member", "auditor"] as const;

/**
 * Settings → Users & Roles.
 *
 * What each of the four seats may do, and the one new control this page adds: inviting an
 * auditor. There is no invite API — invites are an operator CLI action (`apps/portal`), so the
 * form's job is to produce the exact command an operator pastes into their shell. Rendering the
 * command instead of hiding a broken button keeps the seat honest: the owner sees the right
 * command and hands it to whoever runs the portal.
 */
export function UsersRolesPage() {
  const session = useSession();
  const ownRole = session.identity?.role;
  const [email, setEmail] = useState("");
  const [tenant, setTenant] = useState("");
  const [ttlDays, setTtlDays] = useState("7");
  const [copied, setCopied] = useState(false);

  const trimmedEmail = email.trim().toLowerCase();
  const command =
    trimmedEmail.length === 0
      ? null
      : [
          "pnpm --filter @agentforge/portal invite --",
          `--email ${trimmedEmail}`,
          "--role auditor",
          tenant.trim() ? `--tenant ${tenant.trim().toLowerCase()}` : null,
          `--ttl-days ${ttlDays.trim() || "7"}`,
        ]
          .filter(Boolean)
          .join(" ");

  async function copyCommand() {
    if (!command) {
      return;
    }
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[var(--content)] flex-col gap-6 px-6 py-6" data-testid="users-roles-page">
      <section className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5">
        <h2 className="font-heading text-base font-semibold text-[var(--text)]">
          {t("settings.usersRoles.rolesTitle")}
        </h2>
        <p className="mt-1 text-sm text-[var(--text-3)]">{t("settings.usersRoles.rolesBlurb")}</p>
        <ul className="mt-4 flex flex-col gap-3">
          {ROLES.map((role) => (
            <li key={role} className="flex flex-col gap-0.5" data-testid={`role-row-${role}`}>
              <span className="text-sm font-semibold text-[var(--text)]">
                {t(`settings.usersRoles.role.${role}.name`)}
                {ownRole === role ? (
                  <span className="ml-2 rounded-full border border-[var(--line)] px-2 py-0.5 text-xs font-medium text-[var(--text-3)]">
                    {t("settings.usersRoles.you")}
                  </span>
                ) : null}
              </span>
              <span className="text-sm text-[var(--text-3)]">{t(`settings.usersRoles.role.${role}.blurb`)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5">
        <h2 className="font-heading text-base font-semibold text-[var(--text)]">
          {t("settings.usersRoles.inviteTitle")}
        </h2>
        <p className="mt-1 text-sm text-[var(--text-3)]">{t("settings.usersRoles.inviteBlurb")}</p>

        <div className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-[var(--text)]">{t("settings.usersRoles.emailLabel")}</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder={t("settings.usersRoles.emailPlaceholder")}
              className="rounded-lg border border-[var(--line)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)]"
              data-testid="invite-auditor-email"
            />
          </label>
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-[var(--text)]">{t("settings.usersRoles.tenantLabel")}</span>
              <input
                type="text"
                value={tenant}
                onChange={(event) => setTenant(event.target.value)}
                placeholder="nultron"
                className="w-40 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)]"
                data-testid="invite-auditor-tenant"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-[var(--text)]">{t("settings.usersRoles.ttlLabel")}</span>
              <input
                type="number"
                min={1}
                max={30}
                value={ttlDays}
                onChange={(event) => setTtlDays(event.target.value)}
                className="w-24 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)]"
                data-testid="invite-auditor-ttl"
              />
            </label>
          </div>
        </div>

        {command ? (
          <div className="mt-4 rounded-lg border border-[var(--line)] bg-[var(--bg)] p-3">
            <p className="mb-2 text-xs font-medium text-[var(--text-3)]">{t("settings.usersRoles.commandHint")}</p>
            <code className="block break-all font-mono text-xs text-[var(--text)]" data-testid="invite-auditor-command">
              {command}
            </code>
            <button
              type="button"
              onClick={copyCommand}
              className="mt-3 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-contrast,var(--bg))]"
              data-testid="invite-auditor-copy"
            >
              {copied ? t("settings.usersRoles.copied") : t("settings.usersRoles.copy")}
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
