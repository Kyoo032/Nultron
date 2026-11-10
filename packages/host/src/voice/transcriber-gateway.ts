/**
 * Accurate words for one utterance, off the reply's critical path.
 * `POST <gateway>/audio/transcriptions` with `muse-voice-transcribe-1.0`.
 * The base URL and the key are passed in. This file does not read the environment.
 * A failure, an empty transcript or a wait past the limit is null. It never throws.
 */
import { log } from "../log";
import type { Pcm, Transcriber } from "./talker";
import { pcmDurationSeconds, wavFromPcm } from "./talker-wav";
import type { VoiceLocale } from "./turns";

export const TRANSCRIBE_MODEL = "muse-voice-transcribe-1.0";
export const TRANSCRIBE_TIMEOUT_MS = 15_000;

export type GatewayTranscriberOptions = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  /** Tests inject a short budget. Production leaves this unset. */
  readonly timeoutMs?: number;
};

/** A timer that aborts `signal`. `cancel` stops it so a finished call does not keep the process awake. */
function openBudget(ms: number): { readonly signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(timer) };
}

function endpoint(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}/audio/transcriptions`;
}

export function createGatewayTranscriber(options: GatewayTranscriberOptions): Transcriber {
  const fetchImpl = options.fetch ?? fetch;
  const url = endpoint(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS;

  return {
    async transcribe(utterance: Pcm, call: { readonly locale: VoiceLocale; readonly signal: AbortSignal }) {
      const started = performance.now();
      const seconds = pcmDurationSeconds(utterance.length);
      let status = 0;
      let outcome = "null";
      try {
        if (call.signal.aborted) {
          return null;
        }
        const budget = openBudget(timeoutMs);
        const signal = AbortSignal.any([call.signal, budget.signal]);
        const wav = wavFromPcm(utterance);
        const form = new FormData();
        form.set("model", TRANSCRIBE_MODEL);
        form.set("language", call.locale);
        form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "utterance.wav");
        let response: Response;
        try {
          response = await fetchImpl(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${options.apiKey}` },
            body: form,
            redirect: "manual",
            signal,
          });
        } finally {
          budget.cancel();
        }
        status = response.status;
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return null;
        }
        const json = (await response.json()) as { text?: unknown };
        const text = typeof json.text === "string" ? json.text.trim() : "";
        if (!text) {
          return null;
        }
        outcome = "ok";
        return { text, seconds };
      } catch {
        return null;
      } finally {
        log.info("voice_talker", {
          kind: "transcribe",
          outcome,
          ms: Math.round(performance.now() - started),
          audioBytes: utterance.length,
          status,
        });
      }
    },
  };
}
