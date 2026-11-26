/**
 * How many native document conversions may be running at once.
 *
 * The converter is a napi-rs task on the libuv thread pool, which has four threads and is shared with
 * file reads, DNS and zlib for everyone in the process. A deadline that only races a timer against
 * that call (`toMarkdownUnderDeadline`) answers the caller but cannot stop the native work, so a file
 * built to run long would leave its conversion running after the answer, and every later upload
 * would start another beside it until the pool was full.
 *
 * So the slot belongs to the native promise, not to the race. `run` answers the caller at the
 * deadline, promptly, and keeps the slot until the native call itself settles, however late. At the
 * cap it refuses with 429 `too_many_jobs` instead of starting more. Every caller of `extractFile`
 * (Knowledge ingest, Finance import, Education, Chat) goes through it, so it is fixed once, here.
 *
 * What this does not do: spawn anything. The work it gates is the parse CHILD (`child-parse.ts`),
 * which the deadline SIGKILLs — so unlike the old in-process napi call, a conversion that never
 * answers really does end at the deadline and hands its slot back. The slot cap still bounds how
 * many parse children may exist at once.
 */
import { ApiError, type EnvLike, isServerMode } from "@agentforge/core";
import { maxFromEnv } from "../concurrency";
import { FileExtractError } from "./errors";

export const MAX_NATIVE_CONVERSIONS_ENV = "AGENTFORGE_MAX_NATIVE_CONVERSIONS";
/** Half the thread pool on the shared server, so two orphans still leave two threads for everyone else. */
export const DEFAULT_MAX_NATIVE_HOSTED = 2;
/** A desk is one person's own files; three leaves one thread free. */
export const DEFAULT_MAX_NATIVE_DESK = 3;

export type NativeGate = {
  readonly max: number;
  /** Native conversions still running, including ones whose caller was already answered. */
  inFlight(): number;
  run<T>(work: () => Promise<T>, deadlineMs: number): Promise<T>;
};

function busy(): ApiError {
  return new ApiError("too_many_jobs", "Too many documents are being read at once. Try again in a moment.", 429);
}

export function createNativeGate(max: number): NativeGate {
  const cap = Math.max(1, Math.floor(max));
  let active = 0;
  const release = (): void => {
    active -= 1;
  };
  return {
    max: cap,
    inFlight: () => active,
    run<T>(work: () => Promise<T>, deadlineMs: number): Promise<T> {
      if (active >= cap) {
        return Promise.reject(busy());
      }
      active += 1;
      let native: Promise<T>;
      try {
        native = work();
      } catch (error) {
        release();
        return Promise.reject(error);
      }
      // The slot is the native promise's: released when it settles, never when the race does. Giving the
      // rejection a handler here also means a call that fails after the deadline is not unhandled.
      native.then(release, release);
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new FileExtractError("timeout")), Math.max(1, deadlineMs));
      });
      return Promise.race([native, deadline]).finally(() => clearTimeout(timer));
    },
  };
}

/** The gate for `env`: capped at 2 on the hosted server and 3 on a desk, unless the operator says more. */
export function nativeGateFor(env: EnvLike = process.env): NativeGate {
  const fallback = isServerMode(env) ? DEFAULT_MAX_NATIVE_HOSTED : DEFAULT_MAX_NATIVE_DESK;
  return createNativeGate(maxFromEnv(MAX_NATIVE_CONVERSIONS_ENV, fallback, env));
}

/** The process's gate, fixed when the module loads like every other pool's cap. */
export const nativeGate: NativeGate = nativeGateFor();
