/**
 * How many documents the host reads at once.
 *
 * Reading a document runs a native converter on the libuv pool, and a 25 MB file can hold a core and
 * a few hundred megabytes for seconds. On the hosted server that is shared by every tenant, so the
 * reads go through the same bounded limiter the SQL workers and ffmpeg use: up to `max` run, a
 * bounded few wait, and the rest are refused now with `too_many_jobs` (429). On a desk nothing is
 * capped, because there is one person and refusing them would only be a new failure.
 */
import type { EnvLike } from "@agentforge/core";
import { createJobLimiter, type Limiter } from "../concurrency";

export const MAX_DOCUMENT_READS_ENV = "AGENTFORGE_MAX_DOCUMENT_READS";
export const DEFAULT_MAX_DOCUMENT_READS = 2;

/** A limiter for `env`. Tests build their own; the route uses {@link documentLimiter}. */
export function createDocumentLimiter(env: EnvLike = process.env): Limiter {
  return createJobLimiter("document", MAX_DOCUMENT_READS_ENV, DEFAULT_MAX_DOCUMENT_READS, env);
}

/** The route's limiter, fixed when the module loads like every other pool's. */
export const documentLimiter: Limiter = createDocumentLimiter();
