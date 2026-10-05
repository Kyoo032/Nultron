import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which run a tool call belongs to, for tools that record an author (file writes, code runs). Chat
 * and every job set it around their model call; Chat's `withRunContext` is thread-scoped instead.
 */
export type ToolRun = {
  readonly runId: string;
  readonly mode: string;
};

const storage = new AsyncLocalStorage<ToolRun>();

export function withToolRun<T>(run: ToolRun, fn: () => Promise<T>): Promise<T> {
  return storage.run(run, fn);
}

export function currentToolRun(): ToolRun | undefined {
  return storage.getStore();
}
