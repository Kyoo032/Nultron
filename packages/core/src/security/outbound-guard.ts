import { AsyncLocalStorage } from "node:async_hooks";
import { ApiError } from "../errors";
import { parseAppLocale, type AppLocale } from "../locale";
import { maskPii } from "./pii";
import {
  carriesPrivate,
  hasCredential,
  indexPlain,
  indexPrivate,
  queryShapeProblem,
  readableUrl,
  type ShapeProblem,
  type TextIndex,
} from "./outbound-match";

/**
 * Safe web search (SR-112, SR-166): the one check on text that leaves the host for the web during a run.
 * Web search stays on for every agent (Rizky, 2026-10-13), so the guard sits where text is sent: each search
 * backend (`web-search.ts`, `keyless-search.ts`) and `fetchPublicHttps`. A worker that searches or reads pages
 * on its own (`research_dossier`) goes through the same functions, so it is covered without a second check.
 *
 * The run's state lives in this module's AsyncLocalStorage. The host opens it for a Chat turn
 * (`runOutboundGuarded` in `packages/host/src/runs.ts`) with the person's own text and the private text the
 * prompt carries, so the run is tainted from its first step. A tool that hands the model the person's own
 * content (`trust: "user_content"`) taints it and adds its output, through the egress guard
 * (`../runtime/egress-guard.ts`), which reads the same taint.
 *
 * Every query, guarded run or not: PII is masked, and a query that is too long, holds a credential or holds
 * an encoded blob is refused. In a tainted run a query or a model-written address that shares a five-word
 * span or a figure with the private text, which the person's own messages do not hold, is refused. A
 * refusal is a sentence for the model, never a silently shortened query. Two refusals stop outbound search
 * for the rest of the run.
 *
 * What it does not stop: the model restating a private fact in its own words.
 */

export type OutboundRefusal = {
  readonly ok: false;
  readonly reason: "outbound";
  readonly message: string;
};

type RefusalKind = ShapeProblem | "private" | "stopped";

/** After this many refusals in one run, outbound search stops for the rest of it. */
export const OUTBOUND_REFUSALS_MAX = 2;

const REFUSAL_COPY: Record<RefusalKind, Record<AppLocale, string>> = {
  private: {
    en: "Not sent: this search or page address carries the person's private details (a phrase, number or code from their files, knowledge or earlier chats). Search again in general terms, without the person's details.",
    id: "Tidak dikirim: pencarian atau alamat halaman ini memuat data pribadi orang ini (frasa, angka, atau kode dari berkas, basis pengetahuan, atau obrolan sebelumnya). Cari lagi dengan istilah umum, tanpa data pribadi orang ini.",
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
  stopped: {
    en: "Web search is stopped for this turn: two searches carried the person's private details. Do not search again; answer from what you have and tell the person a search was held back.",
    id: "Pencarian web dihentikan untuk giliran ini: dua pencarian memuat data pribadi orang ini. Jangan mencari lagi; jawab dari yang sudah ada dan beri tahu orang ini bahwa satu pencarian ditahan.",
  },
};

export function outboundRefusal(kind: RefusalKind, locale: AppLocale = "en"): OutboundRefusal {
  return { ok: false, reason: "outbound", message: REFUSAL_COPY[kind][parseAppLocale(locale)] };
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
  /** Null when the query may be sent; the refusal otherwise. Counts the refusal. */
  judgeQuery(query: string): OutboundRefusal | null;
  /** Null when the model-written address may be opened; the refusal otherwise. Counts the refusal. */
  judgeUrl(url: string): OutboundRefusal | null;
};

export type OutboundGuardInit = {
  /** What the person typed in this run's history, attachments excluded (`userTextOf`). */
  readonly userText: readonly string[];
  /** Private text already in the prompt: knowledge excerpts, memories, earlier-chat titles, attachments. */
  readonly privateText: readonly string[];
  readonly locale: AppLocale;
};

function mergeInto(target: { spans: Set<string>; figures: Set<string> }, index: TextIndex): void {
  for (const span of index.spans) {
    target.spans.add(span);
  }
  for (const figure of index.figures) {
    target.figures.add(figure);
  }
}

export function createOutboundGuard(init: OutboundGuardInit): OutboundGuard {
  const locale = parseAppLocale(init.locale);
  const userJoined = init.userText.join("\n");
  const userIndex = indexPlain(userJoined);
  const privateIndex = { spans: new Set<string>(), figures: new Set<string>() };
  const searched = new Set<string>();
  let tainted = false;
  let refusals = 0;

  const refuse = (kind: RefusalKind): OutboundRefusal => {
    refusals += 1;
    return outboundRefusal(kind, locale);
  };
  const taint = (texts: readonly string[]) => {
    tainted = true;
    for (const text of texts) {
      mergeInto(privateIndex, indexPrivate(text));
    }
  };
  if (init.privateText.some((text) => text.trim() !== "")) {
    taint(init.privateText);
  }

  return {
    locale,
    isTainted: () => tainted,
    taint,
    noteSearchResults(urls) {
      for (const url of urls) {
        searched.add(url);
      }
    },
    judgeQuery(query) {
      if (refusals >= OUTBOUND_REFUSALS_MAX) {
        return outboundRefusal("stopped", locale);
      }
      const shape = queryShapeProblem(query);
      if (shape) {
        return refuse(shape);
      }
      return tainted && carriesPrivate(query, privateIndex, userIndex) ? refuse("private") : null;
    },
    judgeUrl(url) {
      if (searched.has(url) || userJoined.includes(url)) {
        return null;
      }
      if (refusals >= OUTBOUND_REFUSALS_MAX) {
        return outboundRefusal("stopped", locale);
      }
      const readable = readableUrl(url);
      if (hasCredential(readable)) {
        return refuse("credential");
      }
      return tainted && carriesPrivate(readable, privateIndex, userIndex) ? refuse("private") : null;
    },
  };
}

const storage = new AsyncLocalStorage<OutboundGuard>();

export function runOutboundGuarded<T>(guard: OutboundGuard, fn: () => T): T {
  return storage.run(guard, fn);
}

export function currentOutboundGuard(): OutboundGuard | undefined {
  return storage.getStore();
}

/**
 * The query a search backend may send: PII masked, on every backend. Throws `OutboundRefusedError` when the
 * query is refused. Outside a guarded run the shape rules still apply; refusals are not counted there.
 */
export function sendableSearchQuery(query: string, locale: AppLocale = "en"): string {
  const trimmed = query.trim();
  const guard = currentOutboundGuard();
  const refusal = guard ? guard.judgeQuery(trimmed) : shapeRefusal(trimmed, locale);
  if (refusal) {
    throw new OutboundRefusedError(refusal);
  }
  return maskPii(trimmed).trim();
}

function shapeRefusal(query: string, locale: AppLocale): OutboundRefusal | null {
  const shape = queryShapeProblem(query);
  return shape ? outboundRefusal(shape, locale) : null;
}

/** Throws `OutboundRefusedError` when a guarded run may not open this model-written address. */
export function assertSendableUrl(url: string): void {
  const refusal = currentOutboundGuard()?.judgeUrl(url);
  if (refusal) {
    throw new OutboundRefusedError(refusal);
  }
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
