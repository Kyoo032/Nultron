import type { TenantContext } from "@agentforge/core";
import { isFileRefusal, type FileAuthor, type FileRootKind, type FileRootResolver } from "@agentforge/core/tools/files";
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
  const folder = await createFolderRoot(tenant, author);
  return isFileRefusal(folder) ? folder : { root: folder, author };
};
