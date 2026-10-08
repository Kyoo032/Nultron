import { useHostCapabilities } from "@/lib/host-capabilities";
import { useSession, type SessionSnapshot } from "@/lib/session";

/**
 * Whether the Workspaces page offers this person the Delete button for a desk.
 *
 * On the hosted app a desk holds every person's chats, and the host answers
 * `403 workspace_delete_forbidden` to anyone who is not an owner or an admin
 * (`packages/host/src/handlers/workspaces.ts`). This hides what the host would refuse. It is a courtesy
 * and never the control: a stale role costs one refused click, and the host re-reads the membership row
 * on every request. Same reading as `mayChangeCompanyKey` (`company-key-access.ts`):
 *
 * - A signed-in `owner` or `admin` on the hosted server: yes.
 * - A signed-in `member`, or a role this screen cannot read: no. Unknown is never an administrator.
 * - Anyone who is not signed in: yes. A boot read in flight or a signed-out visit is followed by a
 *   sign-in screen or a real role, and the host decides either way.
 * - Anywhere that is not the hosted server (`hosted` false): yes, and no role is read at all. A desk
 *   has one person and no sessions, so on the Personal app this is always true and the page renders
 *   exactly what it did.
 */
export function mayDeleteDesk(session: Pick<SessionSnapshot, "status" | "identity">, hosted = true): boolean {
  if (!hosted || session.status !== "signed-in") {
    return true;
  }
  const role = session.identity?.role;
  return role === "owner" || role === "admin";
}

/**
 * `mayDeleteDesk` for the session the app is running under. `sessions` is the host's own statement that
 * this deployment has browser sessions (the hosted server alone), so by the time a screen reads a role
 * the flag is set.
 */
export function useMayDeleteDesk(): boolean {
  const session = useSession();
  const { sessions } = useHostCapabilities();
  return mayDeleteDesk(session, sessions);
}
