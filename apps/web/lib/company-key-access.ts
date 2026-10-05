import { useHostCapabilities } from "@/lib/host-capabilities";
import { useSession, type SessionSnapshot } from "@/lib/session";

/**
 * Whether the screen offers this person the company's gateway key: the field that saves it, the button
 * that forgets it, the onboarding step that asks for it.
 *
 * On the hosted app the key belongs to the company, and the host answers `403 settings_key_forbidden`
 * to anyone who is not an owner or an admin (`packages/host/src/handlers/settings.ts`, M4). This hides
 * what the host would refuse. It is a courtesy and never the control: a stale role costs one refused
 * click, and the host re-reads the membership row on every request.
 *
 * - A signed-in `owner` or `admin` on the hosted server: yes.
 * - A signed-in `member`, or a role this screen cannot read: no. Unknown is never an administrator,
 *   the same reading the Erase account button has (`settings-reset-card.tsx`).
 * - Anyone who is not signed in: yes. A boot read in flight or a signed-out visit is followed by a
 *   sign-in screen or a real role, and the host decides either way.
 * - Anywhere that is not the hosted server (`hosted` false): yes, and no role is read at all. A desk
 *   has one owner and no sessions, so on the Personal app this is always true and the screens render
 *   exactly what they did.
 */
export function mayChangeCompanyKey(session: Pick<SessionSnapshot, "status" | "identity">, hosted = true): boolean {
  if (!hosted || session.status !== "signed-in") {
    return true;
  }
  const role = session.identity?.role;
  return role === "owner" || role === "admin";
}

/**
 * `mayChangeCompanyKey` for the session the app is running under. `sessions` is the host's own
 * statement that this deployment has browser sessions (the hosted server alone); a session only ever
 * reaches `signed-in` after ping has said so, so by the time a screen reads a role the flag is set.
 */
export function useMayChangeCompanyKey(): boolean {
  const session = useSession();
  const { sessions } = useHostCapabilities();
  return mayChangeCompanyKey(session, sessions);
}
