import {
  registerPlatformTools,
  registerTool,
  registerEditTools,
  setEditToolBackend,
  bindKeylessSearchLocale,
} from "@agentforge/core";
import { registerFileTools, setFileRootResolver } from "@agentforge/core/tools/files";
import { registerUniversityTools } from "@agentforge/university";
import { registerCodeTools } from "./code-runner";
import { registerDeckTools } from "./deck";
import { delegateTool } from "./delegation/delegate-tool";
import { mcpFetchTool, mcpListSourcesTool } from "./mcp/mcp-tools";
import { resolveHostFileRoot } from "./file-roots";
import { knowledgeSearchTool } from "./knowledge-search-tool";
import { marketTools } from "./market/tools";
import { pastSessionsTool } from "./session-tools";
import { localeForRun } from "./run-context";
import { selfCheckTool } from "./self-check-tool";
import { runSqlTool } from "./sql-tool";
import { financeTaskTool } from "./workers/finance-task-tool";
import { researchDossierTool } from "./workers/research-dossier-tool";
import { chatVideoGenerateTool } from "./workers/video-generate-tool";

let registered = false;

export function ensureToolsRegistered(): void {
  bindKeylessSearchLocale(localeForRun);
  if (registered) {
    return;
  }
  registerPlatformTools();
  // Replaces core's `video_generate` under the same key: the same tool, kept from ending a chat turn while it renders.
  registerTool(chatVideoGenerateTool);
  registerUniversityTools();
  registerTool(pastSessionsTool);
  registerTool(runSqlTool);
  for (const tool of marketTools.all) {
    registerTool(tool);
  }
  registerEditTools();
  registerTool(knowledgeSearchTool);
  registerFileTools();
  setFileRootResolver(resolveHostFileRoot);
  registerCodeTools();
  registerTool(selfCheckTool);
  registerDeckTools();
  // Tester code: a mode harness as a tool of its own agent's conversation (`workers/`).
  registerTool(researchDossierTool);
  registerTool(financeTaskTool);
  // One agent asking another for its answer (`delegation/`).
  registerTool(delegateTool);
  // Read-only sandboxed MCP connectors (Gmail, Google Drive, OneDrive, Notion).
  registerTool(mcpListSourcesTool);
  registerTool(mcpFetchTool);
  registered = true;
  void import("./edit/backend").then((mod) => {
    setEditToolBackend(mod.hostEditBackend);
  });
  void import("./edit/wire-generate").then((mod) => {
    mod.ensureGenerateSubmitWired();
  });
}
