import { SettingsLinkHint } from "@/components/settings-link-hint";
import { useProductBrand } from "@/lib/product-brand";

/**
 * The calm line a pane shows where a model call would have gone, when the desk has no usable gateway
 * key: what is missing, and a link to the one place that fixes it. Muted, never red: a missing key
 * is a to-do, not a failure.
 *
 * Used on the hosted app, where a signed-in person may open the desk before adding a key ("Add it
 * later"). A pane shows it when `useHostedNeedsKey()` is true, which is also what quiets its Generate
 * button and hides the generic error banner a refused call would otherwise print. Panes that already
 * had their own needs-key line (Chat, Images, Videos, Music, Documents, Edit) keep it; this is for
 * the rest, so the copy and the link are the same wherever the person meets it.
 *
 * `testId` is the pane's own (`research-needs-key`), and the link carries `<testId>-settings`.
 *
 * `id` is optional and only for a pane whose controls name this note in `aria-describedby` (Edit); a
 * pane that passes none renders the markup it always did.
 */
export function NeedsKeyNote({ testId, className, id }: { testId: string; className?: string; id?: string }) {
  const { gatewayName } = useProductBrand();
  return (
    <p className={className ?? "basis-full text-xs text-[var(--text-3)]"} data-testid={testId} role="status" id={id}>
      <SettingsLinkHint i18nKey="common.needsKey.note" vars={{ gateway: gatewayName }} testId={`${testId}-settings`} />
    </p>
  );
}
