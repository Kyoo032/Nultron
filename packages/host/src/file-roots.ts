import type { TenantContext } from "@agentforge/core";
import {
  fileRefusal,
  isFileRefusal,
  type FileAuthor,
  type FileRootKind,
  type FileRootResolver,
} from "@agentforge/core/tools/files";
import { currentDelegation } from "./delegation/delegation-context";
import { createDeskRoot } from "./desk-files/store";
import { createFolderRoot } from "./folder-root";
import { getRunContext } from "./run-context";
import { currentToolRun } from "./tool-run-context";

/** A model-invoked tool always writes as the agent. Every run sets its tool run; the thread is a fallback. */
export function currentAgentAuthor(): FileAuthor {
  const run = currentToolRun();
  if (run) {
    return { kind: "agent", runId: run.runId, mode: run.mode };
  }
  const chat = getRunContext();
  return { kind: "agent", runId: chat?.threadId ?? "unscoped", mode: chat ? "chat" : "unknown" };
}

export const resolveHostFileRoot: FileRootResolver = async (tenant: TenantContext, kind: FileRootKind) => {
  const author = currentAgentAuthor();
  if (kind === "desk") {
    return { root: createDeskRoot(tenant, author), author };
  }
  // A delegated run has no owner to approve a change to the real folder, so it gets the desk only.
  if (currentDelegation()) {
    return fileRefusal(
      "root_unavailable",
      "This run was delegated by another agent and works on the desk's files only. Use root \"desk\".",
    );
  }
  const folder = await createFolderRoot(tenant, author);
  return isFileRefusal(folder) ? folder : { root: folder, author };
};
