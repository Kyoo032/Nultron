/**
 * Dev-only live check of the HTTP talker and the gateway transcriber.
 * The key is read from stdin and redacted from everything this process prints.
 * Usage: <key on stdin> | tsx talker-live.mts <fixtures dir>
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VOICE_DEFAULT_MODEL, VOICE_DEFAULT_VOICE } from "../../src/voice/flag.ts";
import {
  acknowledgementWords,
  createOmniHttpTalker,
  whenAcknowledgementSettled,
} from "../../src/voice/talker-omni-http.ts";
import { OFFER_KEEP_LISTENING } from "../../src/voice/talker-prompt.ts";
import { TalkerError, type TalkerEvent, type TalkerUsage } from "../../src/voice/talker.ts";
import { createGatewayTranscriber } from "../../src/voice/transcriber-gateway.ts";

const BASE = "https://api.tokotokenai.com/v1";
const ANSWER = "Total penjualan bulan lalu Rp 12.500.000 dari 48 pesanan.";
const LOCALE = "id" as const;
const key = readFileSync(0, "utf8").trim();

function redact(value: unknown): string {
  const text =
    value instanceof Error ? `${value.name}: ${value.message}` : typeof value === "string" ? value : String(value);
  return key ? text.split(key).join("[key]") : text;
}

const say = (...parts: unknown[]) => {
  console.log(parts.map(redact).join(" "));
};

process.on("uncaughtException", (error) => {
  console.error(redact(error));
  process.exitCode = 1;
});

let requests = 0;
const fetchImpl: typeof fetch = async (input, init) => {
  requests += 1;
  if (requests > 45) {
    throw new Error("live check stopped at 45 requests");
  }
  return fetch(input, init);
};

function pcmOfWav(file: string): Buffer {
  const buf = readFileSync(file);
  if (buf.length >= 44 && buf.toString("ascii", 0, 4) === "RIFF") {
    const data = buf.readUInt32LE(40);
    return buf.subarray(44, Math.min(buf.length, 44 + data));
  }
  return buf;
}

function sentences(text: string): number {
  return text
    .split(/[.!?]+/)
    .map((part) => part.trim())
    .filter(Boolean).length;
}

type Row = {
  name: string;
  run: number;
  first: string;
  firstMs: number | null;
  audioMs: number | null;
  askMs: number | null;
  wait: boolean;
  words: string;
  audioSec: number;
  usage: TalkerUsage | null;
  error: string;
  answerAudioMs: number | null;
  answerWords: string;
  answerSec: number;
};

function usageText(usage: TalkerUsage | null): string {
  if (!usage) {
    return "-";
  }
  return `in ${usage.inputTokens} (audio ${usage.inputAudioTokens}) out ${usage.outputTokens} (audio ${usage.outputAudioTokens})`;
}

async function consume(
  source: AsyncIterable<TalkerEvent>,
): Promise<{ first: string; firstMs: number | null; audioMs: number | null; askMs: number | null; wait: boolean; words: string; audioSec: number; usage: TalkerUsage | null; ask: { callId: string } | null; error: string }> {
  const started = performance.now();
  const out = {
    first: "",
    firstMs: null as number | null,
    audioMs: null as number | null,
    askMs: null as number | null,
    wait: false,
    words: "",
    audioSec: 0,
    usage: null as TalkerUsage | null,
    ask: null as { callId: string } | null,
    error: "",
  };
  let audioBytes = 0;
  try {
    for await (const event of source) {
      const ms = Math.round(performance.now() - started);
      if (!out.first && event.type !== "done" && event.type !== "usage") {
        out.first = event.type;
        out.firstMs = ms;
      }
      if (event.type === "audio") {
        if (out.audioMs === null) {
          out.audioMs = ms;
        }
        audioBytes += event.pcm.length;
      } else if (event.type === "text") {
        out.words += event.delta;
      } else if (event.type === "ask") {
        out.askMs = ms;
        out.ask = { callId: event.callId };
      } else if (event.type === "wait") {
        out.wait = true;
      } else if (event.type === "usage") {
        out.usage = event.usage;
      }
    }
  } catch (error) {
    out.error = error instanceof TalkerError ? error.code : "error";
  }
  out.audioSec = Math.round((audioBytes / 48_000) * 1000) / 1000;
  return out;
}

const dir = resolve(process.argv[2] ?? "");
const talker = createOmniHttpTalker({
  baseUrl: BASE,
  apiKey: key,
  model: VOICE_DEFAULT_MODEL,
  voice: VOICE_DEFAULT_VOICE,
  fetch: fetchImpl,
});
const transcriber = createGatewayTranscriber({ baseUrl: BASE, apiKey: key, fetch: fetchImpl });
const trio = { model: VOICE_DEFAULT_MODEL, voice: VOICE_DEFAULT_VOICE, locale: LOCALE };

say(`keep_listening ${OFFER_KEEP_LISTENING.on ? "on" : "off"} model ${VOICE_DEFAULT_MODEL} voice ${VOICE_DEFAULT_VOICE}`);

const ackStarted = performance.now();
const warmer = talker.open({ locale: LOCALE, history: [] });
await whenAcknowledgementSettled(trio);
const ack = warmer.acknowledgement();
const ackMs = Math.round(performance.now() - ackStarted);
say(
  `ack ms=${ackMs} cached=${ack ? "yes" : "no"} played="${ack?.text ?? ""}" heard="${acknowledgementWords(trio) ?? ""}" bytes=${ack?.pcm.length ?? 0}`,
);
warmer.close();

const rows: Row[] = [];
const plan: Array<{ name: string; runs: number; answer: boolean }> = [
  { name: "fact", runs: 2, answer: true },
  { name: "task", runs: 2, answer: true },
  { name: "smalltalk", runs: 2, answer: false },
  { name: "backchannel", runs: 2, answer: false },
  { name: "stop", runs: 2, answer: false },
  { name: "long", runs: 2, answer: false },
  { name: "unfinished", runs: 3, answer: false },
];

for (const item of plan) {
  const pcm = pcmOfWav(resolve(dir, `${item.name}.wav`));
  for (let run = 1; run <= item.runs; run += 1) {
    const open = talker.open({ locale: LOCALE, history: [] });
    const signal = new AbortController().signal;
    const reply = await consume(open.reply(pcm, { signal }));
    let answerAudioMs: number | null = null;
    let answerWords = "";
    let answerSec = 0;
    if (item.answer && reply.ask) {
      const spoken = await consume(open.answer(reply.ask.callId, ANSWER, { signal }));
      answerAudioMs = spoken.audioMs;
      answerWords = spoken.words;
      answerSec = spoken.audioSec;
      if (spoken.error) {
        reply.error = reply.error || `answer ${spoken.error}`;
      }
    }
    open.close();
    const row: Row = {
      name: item.name,
      run,
      first: reply.first,
      firstMs: reply.firstMs,
      audioMs: reply.audioMs,
      askMs: reply.askMs,
      wait: reply.wait,
      words: reply.words.replace(/\s+/g, " ").trim(),
      audioSec: reply.audioSec,
      usage: reply.usage,
      error: reply.error,
      answerAudioMs,
      answerWords: answerWords.replace(/\s+/g, " ").trim(),
      answerSec,
    };
    rows.push(row);
    say(
      `${row.name}#${row.run} first=${row.first || "-"}@${row.firstMs ?? "-"} audioMs=${row.audioMs ?? "-"} askMs=${row.askMs ?? "-"} wait=${row.wait ? "yes" : "no"} audioSec=${row.audioSec} sentences=${sentences(row.words)} words="${row.words}" usage=${usageText(row.usage)} answerAudioMs=${row.answerAudioMs ?? "-"} answerSec=${row.answerSec} answer="${row.answerWords}" err=${row.error || "-"}`,
    );
  }
}

for (const name of ["backchannel", "stop"] as const) {
  const open = talker.open({ locale: LOCALE, history: [] });
  const started = performance.now();
  const heard = await open.hearShort(pcmOfWav(resolve(dir, `${name}.wav`)), new AbortController().signal);
  open.close();
  say(`hearShort ${name} ms=${Math.round(performance.now() - started)} text="${heard ?? ""}"`);
}

const transcribed = await transcriber.transcribe(pcmOfWav(resolve(dir, "fact.wav")), {
  locale: LOCALE,
  signal: new AbortController().signal,
});
say(`transcribe fact text="${transcribed?.text ?? ""}" seconds=${transcribed?.seconds ?? "-"}`);
say(`requests ${requests}`);

const unfinishedWaits = rows.filter((row) => row.name === "unfinished" && row.wait).length;
const otherWaits = rows.filter((row) => row.name !== "unfinished" && row.wait).length;
say(`unfinished waits ${unfinishedWaits}/3 other waits ${otherWaits}`);
