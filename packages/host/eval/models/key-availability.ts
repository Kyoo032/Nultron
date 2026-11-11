/**
 * `pnpm --filter @agentforge/host eval:models:availability` (dev only, never imported by the app).
 *
 * Prints what the pickers would offer for ONE key, from the two free reads the host makes (the key's
 * `GET /v1/models` and the gateway's public `GET /api/pricing`). The key comes on stdin, once, and is
 * held in memory: it is not read from a desk, not written to disk, and never printed. The model cache
 * this builds goes to a temp file that holds model ids and a salted key id, never the key.
 *
 * It starts no generation. `--learn-2026-11-11` then files the refusals measured on that day against
 * the key (the three models its list carried that every call refused, and Suno), so the picker after
 * one real click each can be seen without making those clicks. Those lessons are the recorded ones, not
 * fresh calls. `--desk <dir>` keeps the cache in a throwaway desk instead of a deleted temp one, so an
 * isolated app on that desk (`AGENTFORGE_DATA_DIR=<dir>`) shows the same lessons in Settings; the same
 * key saved there afterwards finds them, because they are filed under its salted id.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LEARN = process.argv.includes("--learn-2026-11-11");
/** `--desk <dir>`: write the cache into that throwaway desk's `models-cache.json` and keep it, to look at Settings. */
const DESK_FLAG = process.argv.indexOf("--desk");
const DESK = DESK_FLAG >= 0 ? process.argv[DESK_FLAG + 1] : undefined;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main(): Promise<number> {
  const apiKey = await readStdin();
  if (!apiKey) {
    process.stderr.write("No key on stdin.\n");
    return 1;
  }
  const dir = DESK ?? mkdtempSync(join(tmpdir(), "af-key-availability-"));
  if (DESK) {
    mkdirSync(DESK, { recursive: true });
  }
  process.env.AGENTFORGE_DATA_DIR = dir;
  process.env.AGENTFORGE_MODELS_CACHE_PATH = join(dir, "models-cache.json");
  try {
    const core = await import("@agentforge/core");
    const { saveModelCache } = await import("../../src/model-cache");
    const selectable = await import("../../src/selectable-models");
    const availability = await import("../../src/model-availability");
    const payload = await import("../../src/model-availability-payload");
    const { transcriptionCandidates } = await import("@agentforge/core/meeting");
    const { cachedModelIds } = await import("../../src/meeting/transcribe");
    const { defaultStudioVideoModel, defaultStudioImageModel } = await import("../../src/studio-generate");

    // Free read 1: the key's own model list.
    const models = await core.probeOpenAIModels({ baseURL: core.resolvedGatewayBaseUrl(), apiKey });
    // Free read 2: the public price list (no key sent).
    const response = await fetch(`${core.gatewayOriginFromBaseUrl(core.resolvedGatewayBaseUrl())}/api/pricing`, {
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const hints = response.ok ? core.parsePricingHints(await response.json()) : {};

    const salt = core.newAvailabilitySalt();
    const keyId = core.availabilityKeyId(apiKey, salt) as string;
    let store = core.emptyAvailabilityStore(salt);
    const now = Date.now();
    if (LEARN) {
      const learned: Array<[string, "account_blocked" | "no_channel" | "upstream_rejected" | "not_on_key", string]> = [
        ["grok-imagine-video", "account_blocked", "prepaid_async_requires_fixed_price"],
        ["kling-v3", "no_channel", "no available configurable resource channel"],
        ["veo_3_1-fast", "upstream_rejected", "bad_response_status_code"],
        ["suno_music", "not_on_key", "model_not_found"],
        ["suno_lyrics", "not_on_key", "model_not_found"],
      ];
      for (const [model, status, reason] of learned) {
        store = core.withAvailabilityOutcome(store, keyId, model, { status, reason }, now);
      }
    }
    saveModelCache(
      {
        openai: models,
        openaiProbedAt: new Date(now).toISOString(),
        endpointHints: hints,
        endpointHintsAt: new Date(now).toISOString(),
        availability: store,
        keyId,
      },
      undefined,
    );
    availability.resetAvailabilityMemo();
    selectable.resetCatalogMemo();

    const ids = (list: Array<{ id: string }>) => list.map((model) => model.id);
    const { defaults, modes } = selectable.modeCatalogPayload(undefined, undefined);
    const body = payload.modelAvailabilityBody(undefined);
    const lines: string[] = [];
    lines.push(`listed by the key: ${models.length} ids; price list: ${Object.keys(hints).length} ids`);
    lines.push(`lessons filed: ${LEARN ? "the 2026-11-11 refusals (recorded, not re-probed)" : "none"}`);
    lines.push("");
    lines.push(`video         ${ids(selectable.listProbedVideoModels()).join(", ")}`);
    lines.push(`  default     ${defaultStudioVideoModel()}   (mode default: ${defaults.video})`);
    lines.push(`image         ${ids(selectable.listImageModels()).join(", ")}`);
    lines.push(`  default     ${defaultStudioImageModel()}   (mode default: ${defaults.image})`);
    lines.push(`speech        ${ids(selectable.listSpeechModels()).join(", ") || "(none)"}`);
    lines.push(`music         ${ids(selectable.listMusicModels()).join(", ") || "(none)"}`);
    lines.push(`transcription ${transcriptionCandidates(cachedModelIds()).join(", ") || "(none)"}`);
    lines.push(`chat          ${modes.chat.length} models (first: ${ids(modes.chat).slice(0, 5).join(", ")})`);
    lines.push("");
    lines.push(`offered per kind: ${JSON.stringify(body.kinds)}`);
    lines.push(`cannot use (${body.unavailable.length}):`);
    for (const row of body.unavailable) {
      lines.push(`  ${row.kind.padEnd(13)} ${row.id.padEnd(40)} ${row.status}${row.reason ? ` (${row.reason})` : ""}`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  } finally {
    // The temp desk holds model ids and a salted key id, never the key. The host's database may still be
    // open on Windows, so a failed delete is retried and then left for the OS temp cleaner.
    try {
      if (!DESK) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    } catch {
      process.stderr.write(`could not delete ${dir}; it holds no key\n`);
    }
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    // The message of a probe error is already redacted by the probe; the key is never part of it.
    process.stderr.write(`failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exit(1);
  },
);
