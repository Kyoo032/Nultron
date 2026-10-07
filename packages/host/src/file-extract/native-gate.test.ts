import { describe, expect, it } from "vitest";
import { ApiError } from "@agentforge/core";
import { FileExtractError } from "./errors";
import { extractFile } from "./index";
import {
  createNativeGate,
  DEFAULT_MAX_NATIVE_DESK,
  DEFAULT_MAX_NATIVE_HOSTED,
  MAX_NATIVE_CONVERSIONS_ENV,
  nativeGateFor,
} from "./native-gate";
import { docxFixture } from "./test-fixtures";

/** A native call the test finishes by hand, so "it is still running" is a fact and not a timing guess. */
function hangingCall() {
  let finish: (value: string) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const promise = new Promise<string>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  return { promise, finish, fail };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("a conversion that outlives its deadline", () => {
  it("answers the caller at the deadline but keeps its slot until the native call itself ends", async () => {
    const gate = createNativeGate(1);
    const call = hangingCall();
    await expect(gate.run(() => call.promise, 15)).rejects.toMatchObject({ code: "timeout" });
    // The caller was answered, and the native work is still running on the thread pool.
    expect(gate.inFlight()).toBe(1);
    await call.finish("late");
    await tick();
    expect(gate.inFlight()).toBe(0);
  });

  it("answers 429 too_many_jobs at the cap, so orphans cannot pile up", async () => {
    const gate = createNativeGate(1);
    const call = hangingCall();
    await expect(gate.run(() => call.promise, 10)).rejects.toBeInstanceOf(FileExtractError);
    const refused = await gate.run(() => Promise.resolve("never"), 10).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ code: "too_many_jobs", status: 429 });
  });

  it("frees the slot when the native call finally ends, and the next conversion runs", async () => {
    const gate = createNativeGate(1);
    const call = hangingCall();
    await gate.run(() => call.promise, 10).catch(() => undefined);
    call.finish("done");
    await tick();
    await expect(gate.run(() => Promise.resolve("next"), 100)).resolves.toBe("next");
  });

  it("frees the slot when the late call rejects, and leaves no unhandled rejection behind", async () => {
    const gate = createNativeGate(1);
    const call = hangingCall();
    await gate.run(() => call.promise, 10).catch(() => undefined);
    call.fail(new Error("native blew up after the deadline"));
    await tick();
    expect(gate.inFlight()).toBe(0);
  });

  it("frees the slot when the work throws before it returns a promise", async () => {
    const gate = createNativeGate(1);
    await expect(
      gate.run(() => {
        throw new Error("sync");
      }, 10),
    ).rejects.toThrow("sync");
    expect(gate.inFlight()).toBe(0);
  });

  it("passes a result and a rejection that arrive in time straight through", async () => {
    const gate = createNativeGate(2);
    await expect(gate.run(() => Promise.resolve("ok"), 100)).resolves.toBe("ok");
    await expect(gate.run(() => Promise.reject(new Error("bad")), 100)).rejects.toThrow("bad");
    expect(gate.inFlight()).toBe(0);
  });
});

describe("the cap", () => {
  it("is 2 on the hosted server and 3 on a desk, and the operator can raise it", () => {
    expect(nativeGateFor({ AGENTFORGE_SERVER: "1" }).max).toBe(DEFAULT_MAX_NATIVE_HOSTED);
    expect(nativeGateFor({}).max).toBe(DEFAULT_MAX_NATIVE_DESK);
    expect(nativeGateFor({ AGENTFORGE_SERVER: "1", [MAX_NATIVE_CONVERSIONS_ENV]: "6" }).max).toBe(6);
    expect(nativeGateFor({ [MAX_NATIVE_CONVERSIONS_ENV]: "nonsense" }).max).toBe(DEFAULT_MAX_NATIVE_DESK);
  });
});

describe("through extractFile, which Knowledge ingest, Finance import and Chat all use", () => {
  it("times out promptly, holds the slot, and refuses the next file with 429 until the call ends", async () => {
    const call = hangingCall();
    const gate = createNativeGate(1);
    const bytes = await docxFixture();
    const hanging = {
      formatFromExtension: (extension: string) => (extension === "docx" ? ("docx" as const) : null),
      formatFromBytes: () => "docx" as const,
      toMarkdownBytes: () => call.promise,
    };
    const started = Date.now();
    await expect(
      extractFile({ bytes, filename: "slow.docx" }, { loadAnydoc: () => hanging, timeoutMs: 20, nativeGate: gate }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(gate.inFlight()).toBe(1);

    await expect(
      extractFile({ bytes, filename: "next.docx" }, { loadAnydoc: () => hanging, timeoutMs: 20, nativeGate: gate }),
    ).rejects.toMatchObject({ code: "too_many_jobs", status: 429 });

    call.finish("# done");
    await tick();
    expect(gate.inFlight()).toBe(0);
  });
});
