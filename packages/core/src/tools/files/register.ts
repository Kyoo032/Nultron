import { registerTool } from "../registry";
import { FILE_TOOLS } from "./tools";

export function registerFileTools(): void {
  for (const tool of FILE_TOOLS) {
    registerTool(tool);
  }
}
