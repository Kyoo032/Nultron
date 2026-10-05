import { z } from "zod";
import {
  type CodeRunFailure,
  type CodeRunInput,
  type CodeRunResult,
  defineTool,
  registerTool,
  type TenantContext,
} from "@agentforge/core";
import {
  type DeskPath,
  type FileAuthor,
  type FileRoot,
  FileRootError,
  isFileRefusal,
  parseDeskPath,
} from "@agentforge/core/tools/files";
import { codeRunsEnabled } from "./enabled";
import {
  MAX_CODE_BYTES,
  MAX_INPUT_BYTES,
  MAX_INPUT_FILES,
  MAX_OUTPUT_FILE_BYTES,
  MAX_OUTPUT_FILES,
  MAX_STREAM_BYTES,
  PY_WASM_MAX_MB,
  JS_WASM_MAX_MB,
  RUN_TIMEOUT_MS,
} from "./limits";
import { NOTES } from "./outcome";
import { sandboxRunner } from "./run-code";
import { composeStream } from "./sanitize";

/**
 * `run_code`: the model's way to run a short Python or JavaScript program in the sandbox.
 *
 * Path convention (one rule for both languages): a desk path IS the path under /workspace. The desk file
 * `data/sales.csv` is `/workspace/data/sales.csv` in Python and `files["data/sales.csv"]` in JavaScript.
 * A run's outputs live under `/workspace/out/`, and `/workspace/out/<name>` is saved to the desk as
 * `out/<name>` (JavaScript: `outFiles["<name>"]`). Only new or changed text files are saved, as agent
 * versions authored by the current run.
 */

export const RUN_CODE_DESCRIPTION = [
  "Run a short program in a sandbox and read what it prints. Use it for calculations, data work on files and checking results instead of working them out by hand.",
  'language: "python" (Python 3 with pandas and numpy, plus the standard library; no pip and no other packages) or "javascript" (plain ECMAScript: no require or import, no Node or browser APIs, no top-level await).',
  "The sandbox has no network and cannot see the host. Its only working folder is /workspace.",
  `Input: name desk files in files (a desk path such as data.csv or notes/plan.md; at most ${MAX_INPUT_FILES}, ${MAX_INPUT_BYTES / (1024 * 1024)} MB together, text only). In Python they appear at /workspace/<the same path> and the working directory is /workspace, so pd.read_csv("data.csv") works. In JavaScript they are in the object files, keyed by the same path, as text.`,
  `Output: to keep a result, write it under /workspace/out/ in Python (create the folder first: os.makedirs("/workspace/out", exist_ok=True)), or set outFiles["<name>"] = text in JavaScript. Every new or changed text file there is saved to the desk as out/<name> and listed in filesWritten. Binary files are not saved. At most ${MAX_OUTPUT_FILES} files, ${MAX_OUTPUT_FILE_BYTES / (1024 * 1024)} MB each. Nothing is saved when the run fails.`,
  `Read the result: print with print() or console.log(). stdout and stderr come back, each cut at ${MAX_STREAM_BYTES / 1024} KB, and the value of the last expression is shown after the output. Every call starts clean: variables and files from an earlier call are gone, so give each call everything it needs.`,
  `Limits: code up to ${MAX_CODE_BYTES / 1024} KB; a run is stopped after ${RUN_TIMEOUT_MS / 1000} seconds and at ${PY_WASM_MAX_MB} MB of memory (${JS_WASM_MAX_MB} MB for JavaScript). The first Python run after a pause starts the interpreter and can take about 20 seconds; later runs are quick.`,
  "When ok is false, read reason (timeout, memory, syntax, runtime, too_large, busy or unavailable) and stderr, fix the code and call again. busy means another run is still going; try again shortly. unavailable means code cannot run here at all, so say so rather than retrying.",
].join("\n\n");

const inputSchema = z
  .object({
    language: z.enum(["python", "javascript"]),
    code: z.string(),
    files: z.array(z.string().max(512)).max(MAX_INPUT_FILES).optional(),
  })
  .strict();

type FileAccess = { readonly root: FileRoot; readonly author: FileAuthor };

async function defaultFileAccess(tenant: TenantContext): Promise<FileAccess> {
  // Loaded when a run touches the desk, so the runner and its tests do not open the app database.
  const [{ createDeskRoot }, { currentAgentAuthor }] = await Promise.all([
    import("../desk-files/store"),
    import("../file-roots"),
  ]);
  const author = currentAgentAuthor();
  return { root: createDeskRoot(tenant, author), author };
}

let fileAccessImpl: (tenant: TenantContext) => Promise<FileAccess> = defaultFileAccess;

/** Test seam: where the tool reads and writes desk files. */
export function setCodeToolFileAccessForTests(next: ((tenant: TenantContext) => Promise<FileAccess>) | null): void {
  fileAccessImpl = next ?? defaultFileAccess;
}

function refuse(reason: CodeRunFailure, note: string): CodeRunResult {
  return { ok: false, stdout: "", stderr: note, filesWritten: [], reason };
}

/** Which result class a desk refusal belongs to. The contract has no class for "bad input", so `runtime`. */
function reasonForRefusal(code: string): CodeRunFailure {
  if (code === "too_large" || code === "too_many_files" || code === "quota") {
    return "too_large";
  }
  return code === "root_unavailable" ? "unavailable" : "runtime";
}

type Inputs = { readonly files: Record<string, string> } | CodeRunResult;

/** Reads the named desk files. A bad path, a missing file or too many bytes answers the model, not the run. */
async function readInputs(paths: readonly string[] | undefined, root: () => Promise<FileAccess>): Promise<Inputs> {
  const wanted = [...new Set(paths ?? [])];
  if (wanted.length === 0) {
    return { files: {} };
  }
  const parsed: DeskPath[] = [];
  for (const path of wanted) {
    const checked = parseDeskPath(path);
    if (isFileRefusal(checked)) {
      return refuse("runtime", `[run_code] Input file "${path.slice(0, 120)}": ${checked.message}`);
    }
    parsed.push(checked);
  }
  const { root: desk } = await root();
  const files: Record<string, string> = {};
  let total = 0;
  for (const path of parsed) {
    try {
      const file = await desk.read(path);
      total += file.bytes;
      if (total > MAX_INPUT_BYTES) {
        return refuse("too_large", NOTES.inputsTooLarge);
      }
      files[path] = file.text;
    } catch (error) {
      if (error instanceof FileRootError) {
        return refuse(reasonForRefusal(error.code), `[run_code] Input file "${path}": ${error.message}`);
      }
      throw error;
    }
  }
  return { files };
}

type Saved = {
  readonly written: Array<{ path: string; version: number }>;
  readonly notes: string[];
  readonly reason?: CodeRunFailure;
};

/** Writes each output as an agent version. A refusal from the desk is reported, and the rest still go. */
async function saveOutputs(
  outputs: readonly { path: string; text: string }[],
  access: () => Promise<FileAccess>,
): Promise<Saved> {
  const written: Array<{ path: string; version: number }> = [];
  const notes: string[] = [];
  let reason: CodeRunFailure | undefined;
  const { root, author } = await access();
  for (const output of outputs) {
    try {
      const outcome = await root.write(output.path as DeskPath, output.text, author);
      if (outcome.status === "saved") {
        written.push({ path: outcome.path, version: outcome.version });
      } else {
        notes.push(`[run_code] ${output.path} was not saved yet: it is waiting for approval.`);
      }
    } catch (error) {
      if (!(error instanceof FileRootError)) {
        throw error;
      }
      notes.push(`[run_code] Could not save ${output.path}: ${error.message}`);
      reason ??= reasonForRefusal(error.code);
    }
  }
  return { written, notes, ...(reason ? { reason } : {}) };
}

/** The tool body, exported so a test can drive it without a model. */
export async function runCodeForTenant(input: CodeRunInput, tenant: TenantContext): Promise<CodeRunResult> {
  let access: Promise<FileAccess> | null = null;
  const desk = (): Promise<FileAccess> => {
    access ??= fileAccessImpl(tenant);
    return access;
  };

  let inputs: Inputs;
  try {
    inputs = await readInputs(input.files, desk);
  } catch {
    return refuse("unavailable", "[run_code] The desk files could not be read right now. Try again later.");
  }
  if (!("files" in inputs)) {
    return inputs;
  }
  const result = await sandboxRunner().run({
    tenantId: tenant.tenantId,
    workspaceId: tenant.workspaceId,
    language: input.language,
    code: input.code,
    files: inputs.files,
  });
  if (result.outputs.length === 0) {
    return {
      ok: result.ok,
      stdout: result.stdout,
      stderr: result.stderr,
      filesWritten: [],
      ...(result.reason ? { reason: result.reason } : {}),
    };
  }
  try {
    const saved = await saveOutputs(result.outputs, desk);
    const reason = result.reason ?? saved.reason;
    return {
      ok: result.ok && saved.reason === undefined,
      stdout: result.stdout,
      stderr: composeStream(result.stderr, saved.notes),
      filesWritten: saved.written,
      ...(reason ? { reason } : {}),
    };
  } catch {
    return {
      ok: false,
      stdout: result.stdout,
      stderr: composeStream(result.stderr, ["[run_code] The files could not be saved to the desk. Try again later."]),
      filesWritten: [],
      reason: "unavailable",
    };
  }
}

export const runCodeTool = defineTool({
  key: "run_code",
  name: "Run code",
  description: RUN_CODE_DESCRIPTION,
  schema: inputSchema,
  trust: "user_content",
  // Defence in depth: with AGENTFORGE_CODE_RUNS off the model is never offered the tool (enabled.ts), and a
  // call that still arrives, from a saved agent version or a replayed history, is refused before the sandbox.
  execute: async (args, tenant) =>
    codeRunsEnabled() ? runCodeForTenant(args, tenant) : refuse("unavailable", NOTES.disabled),
});

/** Registered next to the file tools by `ensureToolsRegistered` (the orchestrator wires it). */
export function registerCodeTools(): void {
  registerTool(runCodeTool);
}
