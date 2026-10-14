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
import { registerDocTools } from "./doc-tools";
import { resolveHostFileRoot } from "./file-roots";
import { knowledgeSearchTool } from "./knowledge-search-tool";
import { marketTools } from "./market/tools";
import { pastSessionsTool } from "./session-tools";
import { localeForRun } from "./run-context";
import { selfCheckTool } from "./self-check-tool";
import { runSqlTool } from "./sql-tool";
import { researchDossierTool } from "./workers/research-dossier-tool";

let registered = false;

export function ensureToolsRegistered(): void {
  bindKeylessSearchLocale(localeForRun);
  if (registered) {
    return;
  }
  registerPlatformTools();
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
  registerDocTools();
  // Tester code: a mode harness as a tool of its own agent's conversation (`workers/`).
  registerTool(researchDossierTool);
  registered = true;
  void import("./edit/backend").then((mod) => {
    setEditToolBackend(mod.hostEditBackend);
  });
  void import("./edit/wire-generate").then((mod) => {
    mod.ensureGenerateSubmitWired();
  });
}
