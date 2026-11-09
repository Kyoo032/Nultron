import { AsyncLocalStorage } from "node:async_hooks";
import { ApiError } from "../errors";
import { parseAppLocale, type AppLocale } from "../locale";
import { maskPii } from "./pii";
import {
  hasBlob,
  hasCredential,
  indexFiguresOnly,
  indexPlain,
  indexPrivate,
  normalizeText,
  privateMatch,
  queryShapeProblem,
  readableUrl,
  urlShapeProblem,
  type ShapeProblem,
  type TextIndex,
} from "./outbound-match";

/**
 * Safe web search (SR-112, SR-166): the one check on text that leaves the host for the web during a run.
 * Web search stays on for every agent (Rizky, 2026-10-13), so the guard sits where text is sent: each search
 * backend (`web-search.ts`, `keyless-search.ts`), `fetchPublicHttps`, and the media tools that hand a source
 * image address or a prompt to a provider. A worker that searches or reads pages on its own
 * (`research_dossier`) goes through the same functions, so it is covered without a second check.
 *
 * The run's state lives in this module's AsyncLocalStorage. The host opens it for a Chat turn (`runs.ts`), a
 * mode job (`job-regen.ts`), the research harness (`research-generate.ts`) and the Edit agent
 * (`edit/agent-run.ts`), with the person's own text and the private text the run carries, so the run is
 * tainted from its first step. A tool that hands the model the person's own content
 * (`trust: "user_content"`) taints it and adds its output, through the egress guard
 * (`../runtime/egress-guard.ts`), which reads the same taint.
 *
 * Fails closed: a model's tool call (`invokeToolGuarded` marks it with `runInToolCall`) that reaches a sender
 * with no guard open is refused, so a run the host forgot to guard cannot send model-written text.
 *
 * Every query: PII is masked (and the tool says so), and a query that is too long, holds a credential or holds
 * an encoded blob is refused, unless the person typed that part themselves. A model-written page address is
 * refused when it holds a credential, a host label that packs data, an over-long or encoded path. In a
 * tainted run a query, address or third-party prompt that shares a meaningful five-word span, a code, a
 * long figure or two short figures with the private text, which the person's own messages do not hold, is
 * refused. A refusal is a sentence for the model, never a silently shortened query. Two counted refusals
 * stop outbound search for the rest of the run; a refusal for figures alone is not counted.
 *
 * Accepted residuals: a paraphrase or a translation of private text, a sentence split across queries, numbers
 * spelled out in words, names and phrases under five words, round amounts, earlier assistant turns (not
 * indexed), and a poisoned page that spends the two refusals to stop search for the rest of the turn.
 */

export type RefusalKind =
  | ShapeProblem
  | "private"
  | "stopped"
  | "url_too_long"
  | "url_blob"
  | "media"
  | "unguarded";

export type OutboundRefusal = {
  readonly ok: false;
  readonly reason: "outbound";
  /** Which rule refused; `stopped` means outbound search is over for this run. */
  readonly kind: RefusalKind;
  readonly message: string;
};

/** After this many counted refusals in one run, outbound search stops for the rest of it. */
export const OUTBOUND_REFUSALS_MAX = 2;

const REFUSAL_COPY: Record<RefusalKind, Record<AppLocale, string>> = {
  private: {
    en: "Not sent: this search or page address carries the person's private details (a phrase, number or code from their files, knowledge or earlier chats). Search again in general terms, without the person's details.",
    id: "Tidak dikirim: pencarian atau alamat halaman ini memuat data pribadi orang ini (frasa, angka, atau kode dari file, Knowledge Base, atau obrolan sebelumnya). Cari lagi dengan istilah umum, tanpa data pribadi orang ini.",
  },
  too_long: {
    en: "Not sent: this search is longer than 300 characters. Search again with a short query in general terms.",
    id: "Tidak dikirim: pencarian ini lebih dari 300 karakter. Cari lagi dengan kueri pendek dan istilah umum.",
  },
  credential: {
    en: "Not sent: this search or page address holds something shaped like a password, key or token. Search again without it.",
    id: "Tidak dikirim: pencarian atau alamat halaman ini memuat sesuatu yang mirip kata sandi, kunci, atau token. Cari lagi tanpa itu.",
  },
  blob: {
    en: "Not sent: this search holds a long encoded string. Search again in plain words, in general terms.",
    id: "Tidak dikirim: pencarian ini memuat untaian kode yang panjang. Cari lagi dengan kata biasa dan istilah umum.",
  },
  url_too_long: {
    en: "Not opened: this page address is too long to open from here. Open a page a search returned, or search for it.",
    id: "Tidak dibuka: alamat halaman ini terlalu panjang untuk dibuka dari sini. Buka halaman dari hasil pencarian, atau cari halaman itu.",
  },
  url_blob: {
    en: "Not opened: this page address holds a long encoded string. Open a page a search returned, or search for it.",
    id: "Tidak dibuka: alamat halaman ini memuat untaian kode yang panjang. Buka halaman dari hasil pencarian, atau cari halaman itu.",
  },
  media: {
    en: "Not sent: a source image must be one this conversation made, one a search returned, or one the person gave. Use one of those, or make the picture from the prompt alone.",
    id: "Tidak dikirim: gambar sumber harus gambar yang dibuat dalam percakapan ini, hasil pencarian, atau yang diberikan orang ini. Pakai salah satunya, atau buat gambar dari prompt saja.",
  },
  unguarded: {
    en: "Not sent: this run cannot send text to the web. Answer from what you have.",
    id: "Tidak dikirim: proses ini tidak bisa mengirim teks ke web. Jawab dari yang sudah ada.",
  },
  stopped: {
    en: "Web search is stopped for this turn: two searches carried the person's private details. Do not search again; answer from what you have and tell the person a search was held back.",
    id: "Pencarian web dihentikan untuk giliran ini: dua pencarian memuat data pribadi orang ini. Jangan mencari lagi; jawab dari yang sudah ada dan beri tahu orang ini bahwa satu pencarian ditahan.",
  },
};

const MASKED_NOTE: Record<AppLocale, string> = {
  en: "Some details in this search (an email, phone number or ID) were replaced with placeholders before it was sent.",
  id: "Beberapa detail dalam pencarian ini (email, nomor telepon, atau nomor identitas) diganti placeholder sebelum dikirim.",
};

export function outboundRefusal(kind: RefusalKind, locale: AppLocale = "en"): OutboundRefusal {
  return { ok: false, reason: "outbound", kind, message: REFUSAL_COPY[kind][parseAppLocale(locale)] };
}

/** The sentence a search result carries when PII was masked out of the query it sent (no silent change). */
export function maskedQueryNote(locale: AppLocale = "en"): string {
  return MASKED_NOTE[parseAppLocale(locale)];
}

export function isOutboundRefusal(value: unknown): value is OutboundRefusal {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.ok === false && record.reason === "outbound" && typeof record.message === "string";
}

/** Thrown by a sender that refused; the tool that called it hands `refusal` to the model. */
export class OutboundRefusedError extends ApiError {
  readonly refusal: OutboundRefusal;

  constructor(refusal: OutboundRefusal) {
    super("outbound_refused", refusal.message, 400);
    this.name = "OutboundRefusedError";
    this.refusal = refusal;
  }
}

export type OutboundGuard = {
  readonly locale: AppLocale;
  isTainted(): boolean;
  /** Marks the run tainted, even with no texts (a private read that failed), and adds `texts` to its private material. */
  taint(texts: readonly string[]): void;
  /** Pages a search in this run returned. Opening one of them verbatim is not the model writing an address. */
  noteSearchResults(urls: readonly string[]): void;
  /** Media a tool in this run made. Handing one back to a provider as a source image is allowed. */
  noteHostMedia(urls: readonly string[]): void;
  /** Null when the query may be sent; the refusal otherwise. Counts the refusal unless it is for figures alone. */
  judgeQuery(query: string): OutboundRefusal | null;
  /** Null when the model-written address may be opened; the refusal otherwise. */
  judgeUrl(url: string): OutboundRefusal | null;
  /** Null when this address may go to a provider as a source image; the refusal otherwise. */
  judgeMediaUrl(url: string): OutboundRefusal | null;
  /** Null when a generation prompt may go to a third-party provider; the refusal otherwise. No length cap. */
  judgePrompt(prompt: string): OutboundRefusal | null;
};

export type OutboundGuardInit = {
  /** What the person typed in this run's history, attachments excluded (`userTextOf`). */
  readonly userText: readonly string[];
  /** Private text already in the prompt: knowledge excerpts, memories, attachments, a job's private inputs. */
  readonly privateText: readonly string[];
  /** Private text that counts for its figures and codes only: earlier-chat titles. */
  readonly figuresOnlyText?: readonly string[];
  /** Start tainted even with no private text: a picture or a file in the turn. */
  readonly tainted?: boolean;
  readonly locale: AppLocale;
};

type MutableIndex = { spans: Set<string>; figures: Set<string>; shortFigures: Set<string>; codes: Set<string> };

function mergeInto(target: MutableIndex, index: TextIndex): void {
  for (const key of ["spans", "figures", "shortFigures", "codes"] as const) {
    for (const item of index[key]) {
      target[key].add(item);
    }
  }
}

export function createOutboundGuard(init: OutboundGuardInit): OutboundGuard {
  const locale = parseAppLocale(init.locale);
  const userJoined = normalizeText(init.userText.join("\n"));
  const userIndex = indexPlain(userJoined);
  const privateIndex: MutableIndex = { spans: new Set(), figures: new Set(), shortFigures: new Set(), codes: new Set() };
  const searched = new Set<string>();
  const hostMedia = new Set<string>();
  let tainted = init.tainted === true;
  let refusals = 0;

  const refusal = (kind: RefusalKind, counted = true): OutboundRefusal => {
    if (counted) {
      refusals += 1;
    }
    return outboundRefusal(kind, locale);
  };
  const taint = (texts: readonly string[]) => {
    tainted = true;
    for (const text of texts) {
      mergeInto(privateIndex, indexPrivate(text));
    }
  };
  const figuresOnly = (init.figuresOnlyText ?? []).filter((text) => text.trim() !== "");
  if (init.privateText.some((text) => text.trim() !== "") || figuresOnly.length > 0) {
    taint(init.privateText);
  }
  for (const text of figuresOnly) {
    mergeInto(privateIndex, indexFiguresOnly(text));
  }
  const typed = (url: string) => searched.has(url) || userJoined.includes(url);
  const privateRefusal = (text: string): OutboundRefusal | null => {
    if (!tainted) {
      return null;
    }
    const match = privateMatch(text, privateIndex, userIndex);
    return match ? refusal("private", match !== "figure") : null;
  };
  const stopped = () => (refusals >= OUTBOUND_REFUSALS_MAX ? outboundRefusal("stopped", locale) : null);

  return {
    locale,
    isTainted: () => tainted,
    taint,
    noteSearchResults(urls) {
      for (const url of urls) {
        searched.add(url);
      }
    },
    noteHostMedia(urls) {
      for (const url of urls) {
        hostMedia.add(url);
      }
    },
    judgeQuery(query) {
      const done = stopped();
      if (done) {
        return done;
      }
      const shape = queryShapeProblem(query, userJoined);
      return shape ? refusal(shape) : privateRefusal(query);
    },
    judgeUrl(url) {
      if (typed(url) || hostMedia.has(url)) {
        return null;
      }
      const done = stopped();
      if (done) {
        return done;
      }
      const shape = urlShapeProblem(url, userJoined);
      if (shape) {
        return refusal(shape === "too_long" ? "url_too_long" : shape === "blob" ? "url_blob" : shape);
      }
      return privateRefusal(readableUrl(url));
    },
    judgeMediaUrl(url) {
      return typed(url) || hostMedia.has(url) ? null : refusal("media");
    },
    judgePrompt(prompt) {
      const done = stopped();
      if (done) {
        return done;
      }
      const text = normalizeText(prompt);
      if (hasCredential(text) && !userJoined.includes(prompt.trim())) {
        return refusal("credential");
      }
      if (hasBlob(text) && !userJoined.includes(prompt.trim())) {
        return refusal("blob");
      }
      return privateRefusal(prompt);
    },
  };
}

const storage = new AsyncLocalStorage<OutboundGuard>();
const toolCalls = new AsyncLocalStorage<true>();

export function runOutboundGuarded<T>(guard: OutboundGuard, fn: () => T): T {
  return storage.run(guard, fn);
}

export function currentOutboundGuard(): OutboundGuard | undefined {
  return storage.getStore();
}

/** Marks `fn` as a model's tool call (`invokeToolGuarded`), so a sender with no guard open refuses it. */
export function runInToolCall<T>(fn: () => T): T {
  return toolCalls.run(true, fn);
}

/** True inside a model's tool call. */
export function inToolCall(): boolean {
  return toolCalls.getStore() === true;
}

function refuse(refusal: OutboundRefusal | null | undefined): void {
  if (refusal) {
    throw new OutboundRefusedError(refusal);
  }
}

/** The refusal for a model's tool call that reached a sender with no guard open; null outside a tool call. */
function unguarded(locale: AppLocale): OutboundRefusal | null {
  return inToolCall() ? outboundRefusal("unguarded", locale) : null;
}

/**
 * The query a search backend may send: PII masked, on every backend. Throws `OutboundRefusedError` when the
 * query is refused. Outside a guarded run and outside a tool call (a host route) the shape rules still apply
 * and refusals are not counted; inside a tool call with no guard it is refused.
 */
export function sendableSearchQuery(query: string, locale: AppLocale = "en"): string {
  const trimmed = query.trim();
  const guard = currentOutboundGuard();
  if (guard) {
    refuse(guard.judgeQuery(trimmed));
  } else {
    refuse(unguarded(locale));
    const shape = queryShapeProblem(trimmed);
    refuse(shape ? outboundRefusal(shape, locale) : null);
  }
  return maskPii(trimmed).trim();
}

/** True when `sendableSearchQuery` would change this query by masking PII. */
export function queryWasMasked(query: string): boolean {
  const trimmed = query.trim();
  return maskPii(trimmed).trim() !== trimmed;
}

/** Throws `OutboundRefusedError` when this model-written address may not be opened. */
export function assertSendableUrl(url: string): void {
  const guard = currentOutboundGuard();
  refuse(guard ? guard.judgeUrl(url) : unguarded("en"));
}

/** The refusal for a source image address a provider would fetch, or null. */
export function mediaUrlRefusal(url: string): OutboundRefusal | null {
  const guard = currentOutboundGuard();
  return guard ? guard.judgeMediaUrl(url) : unguarded("en");
}

/** Throws `OutboundRefusedError` when a provider may not be handed this source image address. */
export function assertSendableMediaUrl(url: string): void {
  refuse(mediaUrlRefusal(url));
}

/** The refusal for a generation prompt bound for a third-party provider (not the gateway), or null. */
export function thirdPartyPromptRefusal(prompt: string): OutboundRefusal | null {
  const guard = currentOutboundGuard();
  return guard ? guard.judgePrompt(prompt) : unguarded("en");
}

/**
 * What a media tool checks before it hands work to a provider: a source image address must be one the run
 * made, a search returned or the person typed (the provider fetches it, so a model-written address could
 * carry private text to any host); and a prompt bound for a third party (FAL, Ark, OpenAI Images; not the
 * gateway, which already receives the conversation) is judged like a query, without the length cap.
 */
export function mediaSendRefusal(input: {
  imageUrl?: string | undefined;
  prompt: string;
  thirdParty: boolean;
}): OutboundRefusal | null {
  const image = input.imageUrl ? mediaUrlRefusal(input.imageUrl) : null;
  return image ?? (input.thirdParty ? thirdPartyPromptRefusal(input.prompt) : null);
}

/** Every string inside a tool's output, so its words index as words, not as escaped JSON. */
export function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      stringsOf(item, out);
    }
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      stringsOf(item, out);
    }
  }
  return out;
}
