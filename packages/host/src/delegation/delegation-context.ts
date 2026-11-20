import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Set around a delegated run (`run-delegation.ts`) and read by the code that must treat it differently
 * from a conversation a person is in: `delegate` itself, which refuses to nest, and the file root
 * resolver, which gives a delegated run the desk and never the owner's folder (nobody is there to approve
 * a folder write).
 */
export type Delegation = {
  /** The agent that was asked: a mode id or a team bot's `tb-` slug. */
  readonly agent: string;
  /** The conversation the task came from. */
  readonly fromThreadId: string;
  /** The asked agent's own conversation for this task. */
  readonly threadId: string;
};

const storage = new AsyncLocalStorage<Delegation>();

export function withDelegation<T>(delegation: Delegation, fn: () => Promise<T>): Promise<T> {
  return storage.run(delegation, fn);
}

/** The delegation this code is running inside, or undefined in a conversation a person is in. */
export function currentDelegation(): Delegation | undefined {
  return storage.getStore();
}
