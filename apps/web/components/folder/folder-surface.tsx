import type { CSSProperties } from "react";
import { FolderControl } from "@/components/folder/folder-control";
import { FolderProposals } from "@/components/folder/folder-proposals";
import { useFolder } from "@/components/folder/use-folder";
import { folderErrorText } from "@/lib/folder-copy";
import { hasProposalRows, pendingCount, type FolderState } from "@/lib/folder-state";
import type { FolderController } from "@/lib/folder-actions";
import { hasNativeFilePicker, useHostCapabilities } from "@/lib/host-capabilities";
import type { HostCapabilities } from "@agentforge/core/capabilities";

/**
 * Where the surface sits: the first thing in the Chat composer ledge, so Nultron stands on its top
 * edge, with the ledge's own gap above it (`--ledge-gap` is the composer's top margin) and a gap of
 * `--space-2` to the composer. The composer keeps its own top margin, and two block margins that
 * meet collapse to the larger, so the bottom margin here is the difference that leaves `--space-2`.
 */
const SURFACE_STYLE: CSSProperties = {
  margin: "var(--ledge-gap, 1.5rem) var(--chat-gutter, 1rem) calc(var(--space-2, 8px) - var(--ledge-gap, 1.5rem))",
};

type ViewProps = {
  state: FolderState;
  capabilities: HostCapabilities;
  controller: FolderController;
  /** Whether the shell can open a folder dialog. Left out, the capability flag alone decides. */
  picker?: boolean;
};

/** The pieces, given state: nothing here reads the host, the bridge or a hook. */
export function FolderSurfaceView({ state, capabilities, controller, picker = true }: ViewProps) {
  const status = state.status;
  if (!status?.available) {
    return null;
  }
  // The control needs a folder dialog to press; the panel needs only an open folder with changes in it.
  const showControl = picker && hasNativeFilePicker(capabilities);
  const showProposals = status.mounted && hasProposalRows(state);
  if (!showControl && !showProposals) {
    return null;
  }
  return (
    <div className="flex min-w-0 flex-col gap-2" style={SURFACE_STYLE} data-testid="folder-surface">
      {showControl ? (
        <FolderControl
          name={status.name}
          mounted={status.mounted}
          busy={state.mounting}
          pendingCount={pendingCount(state)}
          onOpen={() => void controller.open()}
          onClose={() => void controller.close()}
        />
      ) : null}
      {state.error ? (
        <p className="text-xs text-[var(--danger)]" role="alert" data-testid="folder-error">
          {folderErrorText(state.error)}
        </p>
      ) : null}
      {showProposals ? (
        <FolderProposals
          state={state}
          onToggle={(id) => void controller.toggleDiff(id)}
          onDecide={(id, decision) => void controller.decide(id, decision)}
          onDismiss={(id) => controller.dismiss(id)}
        />
      ) : null}
    </div>
  );
}

/**
 * The folder control and the "changes to approve" panel, mounted once above the Chat composer.
 *
 * `running` is the Chat pane's own "a reply is streaming" flag; the panel looks again when it falls.
 * Where there is no folder (the hosted app, webdev, a host that predates the routes) this renders
 * nothing at all, not an empty box.
 */
export function FolderSurface({ running }: { running: boolean }) {
  const capabilities = useHostCapabilities();
  const { state, controller, picker } = useFolder(running);
  return <FolderSurfaceView state={state} capabilities={capabilities} controller={controller} picker={picker} />;
}
