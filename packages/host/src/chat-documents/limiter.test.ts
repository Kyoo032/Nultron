import { describe, expect, it } from "vitest";
import { createDocumentLimiter, DEFAULT_MAX_DOCUMENT_READS, MAX_DOCUMENT_READS_ENV } from "./limiter";

describe("the document reader's limiter", () => {
  it("caps nothing on a desk, where one person reads their own files", () => {
    const limiter = createDocumentLimiter({});
    expect(limiter.max).toBe(Number.POSITIVE_INFINITY);
  });

  it("caps concurrent reads on the hosted server, with a bounded waiting room", () => {
    const limiter = createDocumentLimiter({ AGENTFORGE_SERVER: "1" });
    expect(limiter.max).toBe(DEFAULT_MAX_DOCUMENT_READS);
    expect(limiter.queueLimit).toBeGreaterThan(0);
  });

  it("lets the operator raise the cap", () => {
    const limiter = createDocumentLimiter({ AGENTFORGE_SERVER: "1", [MAX_DOCUMENT_READS_ENV]: "5" });
    expect(limiter.max).toBe(5);
  });

  it("refuses with the host's too_many_jobs answer once the waiting room is full", async () => {
    const limiter = createDocumentLimiter({ AGENTFORGE_SERVER: "1", [MAX_DOCUMENT_READS_ENV]: "1" });
    const held = limiter.tryAcquire();
    expect(held).not.toBeNull();
    const waiting = Array.from({ length: limiter.queueLimit }, () => limiter.acquire().catch(() => null));
    await expect(limiter.acquire()).rejects.toMatchObject({ code: "too_many_jobs", status: 429 });
    held?.();
    await Promise.all(waiting.map(async (waiter) => (await waiter)?.()));
  });
});
