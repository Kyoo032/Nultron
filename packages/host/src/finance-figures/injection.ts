import { scanInjection } from "@agentforge/core";

export function financeTextBlocked(filename: string, text: string): boolean {
  return (scanInjection(filename) ?? scanInjection(text)) !== null;
}
