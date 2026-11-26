/**
 * Owner notices (F5b, second half): the desk mails its owner — an approval waiting, a quota
 * warning — from the channel's own address. Callers pass a topic, never a formatted mail: the
 * subject and body shapes are fixed here so a notice reads like a system notice, not an agent.
 *
 * The recipient is the desk's owner (`workspace_members` role `owner`), resolved at send time from
 * the channel's workspace — a notice is never addressed by a caller-supplied address.
 */
import type Database from "better-sqlite3";
import { sql } from "@agentforge/db";
import { log } from "../../log";
import { createMailer, type Mailer } from "./outbound";
import type { EmailChannelRow, EmailStore } from "./store";
import { emailStore } from "./db";

type Sql = Pick<Database.Database, "prepare">;

/** The owner's mailbox for a channel's workspace, or null when the desk has none. */
function ownerAddress(sqlite: Sql, workspaceId: string): string | null {
  const row = sqlite
    .prepare(
      `SELECT u.email AS email
       FROM workspace_members wm JOIN user u ON u.id = wm.user_id
       WHERE wm.workspace_id = ? AND wm.role = 'owner'
       ORDER BY wm.rowid LIMIT 1`,
    )
    .get(workspaceId) as { email: string | null } | undefined;
  return row?.email ?? null;
}

export type OwnerNoticeKind = "approval_waiting" | "quota_warning";

const NOTICE_SUBJECT: Record<OwnerNoticeKind, string> = {
  approval_waiting: "An approval is waiting",
  quota_warning: "Usage is nearing the quota",
};

/**
 * Mail the desk's owner a notice through the channel. No-op (false) when outbound is not
 * configured or the desk has no owner address — a notice must never fail the work that raised it.
 */
export async function notifyOwner(input: {
  channel: EmailChannelRow;
  kind: OwnerNoticeKind;
  /** One or two sentences of detail — e.g. what waits for approval. Plain text, no markup. */
  detail: string;
  env?: NodeJS.ProcessEnv;
  mailer?: Mailer | null;
  store?: EmailStore;
}): Promise<boolean> {
  const env = input.env ?? process.env;
  const mailer = input.mailer === undefined ? createMailer(env) : input.mailer;
  if (!mailer) {
    return false;
  }
  const to = ownerAddress(sql, input.channel.workspaceId);
  if (!to) {
    return false;
  }
  try {
    await mailer.send({
      to,
      subject: `[${input.channel.address}] ${NOTICE_SUBJECT[input.kind]}`,
      text: input.detail.slice(0, 4_000),
      fromAddress: input.channel.address,
    });
    return true;
  } catch {
    log.warn("email_notice_failed", { channelId: input.channel.id });
    return false;
  }
}

/** Convenience: the desk's first active email channel, when it has one. */
export function ownerNoticeChannel(workspaceId: string, store: EmailStore = emailStore()): EmailChannelRow | null {
  return store.listChannels(workspaceId).find((channel) => channel.status === "active") ?? null;
}
