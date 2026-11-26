import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CHILD_OLD_SPACE_MB, JS_HEAP_LIMIT_BYTES, JS_STACK_KB, JS_WASM_MAX_MB } from "./limits";
import { classifyGuestError } from "./outcome";
import { type ChildResult, parseChildMessage } from "./protocol";

const QJS_CHILD = fileURLToPath(new URL("./child/qjs-child.mjs", import.meta.url));

const spawned: ChildProcess[] = [];

afterEach(() => {
  while (spawned.length > 0) {
    const child = spawned.pop();
    try {
      child?.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }
});

async function runInRealQuickJs(
  code: string,
  overrides: { deadlineMs?: number; heapLimitBytes?: number } = {},
): Promise<ChildResult> {
  const child = fork(QJS_CHILD, [JSON.stringify({ wasmMaxMb: JS_WASM_MAX_MB })], {
    execArgv: ["--disallow-code-generation-from-strings", `--max-old-space-size=${CHILD_OLD_SPACE_MB}`],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    serialization: "advanced",
  });
  spawned.push(child);

  await new Promise<void>((resolve, reject) => {
    const onMessage = (raw: unknown) => {
      const msg = parseChildMessage(raw);
      if (msg?.type === "ready") {
        child.off("message", onMessage);
        resolve();
      } else if (msg?.type === "fatal") {
        child.off("message", onMessage);
        reject(new Error(msg.error));
      }
    };
    child.on("message", onMessage);
    child.once("error", reject);
    child.once("exit", (codeExit, signal) => reject(new Error(`child exited before ready: ${codeExit ?? signal}`)));
  });

  return await new Promise<ChildResult>((resolve, reject) => {
    const id = "qjs-test-job";
    const onMessage = (raw: unknown) => {
      const msg = parseChildMessage(raw);
      if (msg?.type === "result" && msg.id === id) {
        child.off("message", onMessage);
        resolve(msg);
      }
    };
    child.on("message", onMessage);
    child.once("error", reject);
    child.send({
      type: "job",
      id,
      code,
      files: {},
      deadlineMs: overrides.deadlineMs ?? 25_000,
      stackKb: JS_STACK_KB,
      heapLimitBytes: overrides.heapLimitBytes ?? JS_HEAP_LIMIT_BYTES,
    });
  });
}

describe("qjs-child memory and deadline classification", () => {
  it("stops the memory bomb at the heap/wasm cap and classifies it as memory rather than timeout", async () => {
    const result = await runInRealQuickJs("const a = []; while (true) a.push(new Array(1000).fill(1))");
    expect(result.error).not.toBeNull();
    expect(result.discard).toBe(true);
    expect(result.why).toBe("wasm-memory");
    expect(classifyGuestError("javascript", result)).toBe("memory");
    expect(result.runMs).toBeLessThan(15_000);
  }, 30_000);

  it("stops a memory bomb that catches OOM in a loop as memory rather than timeout", async () => {
    const result = await runInRealQuickJs(
      "const a = []; while (true) { try { a.push(new Array(1000).fill(1)); } catch {} }",
    );
    expect(result.error).not.toBeNull();
    expect(result.discard).toBe(true);
    expect(result.why).toBe("wasm-memory");
    expect(classifyGuestError("javascript", result)).toBe("memory");
  }, 30_000);

  it("still classifies a pure infinite loop as timeout", async () => {
    const result = await runInRealQuickJs("while (true) {}", { deadlineMs: 300 });
    expect(result.why).toBe("deadline");
    expect(result.discard).toBe(true);
    expect(classifyGuestError("javascript", result)).toBe("timeout");
  }, 15_000);
});
