import { AsyncLocalStorage } from "node:async_hooks";

const attended = new AsyncLocalStorage<true>();

export function withAttendedRun<T>(fn: () => Promise<T>): Promise<T> {
  return attended.run(true, fn);
}

export function isAttendedRun(): boolean {
  return attended.getStore() === true;
}
