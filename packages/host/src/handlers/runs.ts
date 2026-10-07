import type { InputModality } from "@agentforge/core";
import type { HostRequest, HostResult } from "../types";
import { jsonError } from "../errors";
import { requireGatewayAllowedFor } from "../gateway-gate";
import { getTenant } from "../tenant";
import { startModalityRun } from "../runs";
import { admitRun, guardRunStream } from "../run-limits";

async function asStream(events: AsyncIterable<string>): Promise<HostResult> {
  const iterator = events[Symbol.asyncIterator]();
  // The first frame is read here so a run that fails before it has one answers as JSON, not as a stream.
  const first = await iterator.next();
  let unread: IteratorResult<string> | null = first;
  // By hand rather than as a generator, for the same reason as `guardRunStream`: a generator returned
  // before its first `next()` never runs its `finally`, so a consumer that gives up before reading
  // anything would never reach the run, and the run's slot and listeners would be left behind. Here
  // `return()` and `throw()` always reach the source, and are a no-op once it has finished.
  const replay: AsyncIterableIterator<string> = {
    [Symbol.asyncIterator]: () => replay,
    async next() {
      if (unread) {
        const step = unread;
        unread = null;
        return step;
      }
      return iterator.next();
    },
    async return(value?: unknown) {
      unread = null;
      return iterator.return ? iterator.return(value) : { done: true as const, value: undefined };
    },
    async throw(error?: unknown) {
      unread = null;
      if (iterator.throw) {
        return iterator.throw(error);
      }
      throw error;
    },
  };
  return { type: "stream", status: 200, events: replay };
}

export async function handleRun(request: HostRequest, modality: InputModality): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    // Every path below reaches the gateway, so a closed gate is a 403 here and not a failed call.
    requireGatewayAllowedFor(tenant);
    // One slot per run in flight (SR-138): refused here, before a stream exists, with 429
    // `too_many_runs` or 503 `server_busy`. Hosted only; off server mode this is a no-op.
    const release = admitRun(tenant);
    try {
      return await asStream(
        guardRunStream(
          release,
          startModalityRun({
            tenant,
            threadId: request.params.threadId,
            modality,
            body: request.body,
            abortSignal: request.abortSignal,
          }),
        ),
      );
    } catch (error) {
      // Safe to repeat: a release that already ran is ignored.
      release();
      throw error;
    }
  } catch (error) {
    return jsonError(error);
  }
}
