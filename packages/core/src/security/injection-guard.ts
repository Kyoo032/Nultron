import { isHostNoteLine } from "../chat-documents/markers";
import type { ContentPart } from "../content/types";

export type InjectionSeverity = "HIGH" | "CRITICAL";

export type InjectionHit = {
  hit: true;
  rule: string;
  severity: InjectionSeverity;
};

type InjectionRule = {
  rule: string;
  severity: InjectionSeverity;
  pattern: RegExp;
};

/** Tight HIGH/CRITICAL subset. MEDIUM hypothetical/reward rules are not ported. */
const RULES: InjectionRule[] = [
  {
    rule: "ignore-previous",
    severity: "CRITICAL",
    pattern:
      /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above|preceding)\s+(instructions?|prompts?|rules?|guidelines?)\b/i,
  },
  {
    rule: "dan",
    severity: "CRITICAL",
    pattern: /\bdo\s+anything\s+now\b|\byou\s+are\s+(now\s+)?dan\b|\bdan\s+mode\b/i,
  },
  {
    rule: "system-delimiter",
    severity: "CRITICAL",
    pattern: /\[INST\]|<<\s*SYS\s*>>|<\|im_start\|>\s*system|<\|system\|>|\[SYSTEM\]|###\s*System(?:\s*prompt)?\b/i,
  },
  {
    rule: "prompt-leak",
    severity: "HIGH",
    pattern:
      /\b(reveal|print|show|dump|repeat|output)\s+(me\s+)?(?:your\s+(?:hidden\s+)?(?:system\s+)?|(?:hidden\s+)?system\s+)(prompt|instructions)\b/i,
  },
  {
    rule: "id-override",
    severity: "HIGH",
    pattern:
      /\babaikan\s+(semua\s+)?(instruksi|perintah)(\s+sebelumnya|\s+sebelum\s+ini)?\b|\blupakan\s+(semua\s+)?instruksi\b/i,
  },
];

/** Zero-width and joiner characters that split a trigger word without changing how it reads. */
const ZERO_WIDTH_RE = /[\u200B-\u200F\u2060-\u2064\uFEFF\u00AD]/g;

/** Cyrillic / Greek letters that render like Latin ones, folded so "Ignоre" (Cyrillic о) reads "Ignore". */
const HOMOGLYPHS: Record<string, string> = {
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  у: "y",
  х: "x",
  і: "i",
  ѕ: "s",
  ј: "j",
  һ: "h",
  ԁ: "d",
  ԛ: "q",
  ԝ: "w",
  ɡ: "g",
  ց: "g",
  ո: "n",
  ս: "u",
  А: "A",
  В: "B",
  Е: "E",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Т: "T",
  Х: "X",
  І: "I",
  Ѕ: "S",
  Ј: "J",
  α: "a",
  ο: "o",
  ν: "v",
  ι: "i",
  κ: "k",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
  Α: "A",
  Β: "B",
  Ε: "E",
  Ζ: "Z",
  Η: "H",
  Ι: "I",
  Κ: "K",
  Μ: "M",
  Ν: "N",
  Ο: "O",
  Ρ: "P",
  Τ: "T",
  Υ: "Y",
  Χ: "X",
};
const HOMOGLYPH_RE = new RegExp(`[${Object.keys(HOMOGLYPHS).join("")}]`, "g");

/**
 * The text the rules see: NFKC (fullwidth → ASCII), zero-width characters removed, look-alike
 * letters folded to Latin. Latin text is unchanged, so hits map back to the original one-to-one.
 */
export function normalizeForScan(text: string): string {
  return text
    .normalize("NFKC")
    .replace(ZERO_WIDTH_RE, "")
    .replace(HOMOGLYPH_RE, (char) => HOMOGLYPHS[char] ?? char);
}

/**
 * Rule match on the normalized text. There is deliberately no text-wide "this looks like a security
 * discussion / base64 blob, skip it" shortcut: any such shortcut is a one-line bypass (append
 * `notes.txt` and a base64 run, or the words "false positive"). The only way past a rule is the
 * injectionGuardBypass switch, which a desk holds in memory until the host restarts and a hosted desk
 * never honours.
 */
export function scanInjection(text: string): InjectionHit | null {
  if (!text) {
    return null;
  }
  const normalized = normalizeForScan(text);
  for (const rule of RULES) {
    if (rule.pattern.test(normalized)) {
      return { hit: true, rule: rule.rule, severity: rule.severity };
    }
  }
  return null;
}

export function scanJson(value: unknown, seen: Set<unknown> = new Set()): InjectionHit | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    return scanInjection(value);
  }
  if (typeof value !== "object") {
    return null;
  }
  if (seen.has(value)) {
    return null;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = scanJson(item, seen);
      if (hit) {
        return hit;
      }
    }
    return null;
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    const hit = scanJson(item, seen);
    if (hit) {
      return hit;
    }
  }
  return null;
}

export function blockedInjectionOutput(hit: InjectionHit): { success: false; error: string } {
  return { success: false, error: `Blocked by injection guard (rule: ${hit.rule})` };
}

const ATTACH_HEADER_RE = /(?:^|\n\n)--- [^\n]+ ---\n/;
/**
 * A block runs to the next FULL header (`--- name ---`) or the end. It used to stop at any `--- ` line,
 * so an attached file could end its own block with a half header such as `--- Section 2` and have
 * whatever followed it escape the scan. A forged full header only starts another block, and that
 * block is scanned too.
 */
const ATTACH_BLOCK_RE = /(?:^|\n\n)--- ([^\n]+) ---\n([\s\S]*?)(?=\n\n--- [^\n]+ ---\n|$)/g;

/** Replace injected attach bodies with a short marker so the turn still sends. */
export function redactAttachedText(text: string): string {
  return text.replace(ATTACH_BLOCK_RE, (match, filename: string, body: string) => {
    const hit = scanInjection(body);
    if (!hit) {
      return match;
    }
    const leading = match.startsWith("\n\n") ? "\n\n" : "";
    return `${leading}--- ${filename} ---\n[Attachment blocked by injection guard (rule: ${hit.rule})]`;
  });
}

/**
 * What the person typed in one message: everything before the first `--- name ---` attachment header,
 * without the host's own bracketed notes. An attachment is a file's content, not the person's words, so
 * a host it names is not one they asked for. The cut is at the FIRST header and runs to the end, so a
 * file cannot end its own block early with a half header and have what follows read as typed.
 */
export function typedTextOf(text: string): string {
  const header = ATTACH_HEADER_RE.exec(text);
  const typed = header ? text.slice(0, header.index) : text;
  return typed
    .split("\n")
    .filter((line) => !isHostNoteLine(line))
    .join("\n")
    .trimEnd();
}

/** The other side of `typedTextOf`'s cut: every attached file in one message, headers included, or "". */
export function attachedTextOf(text: string): string {
  const header = ATTACH_HEADER_RE.exec(text);
  return header ? text.slice(header.index) : "";
}

const ATTACH_NAME_RE = /(?:^|\n\n)--- ([^\n]+) ---\n/g;

/**
 * A message with each attachment replaced by one line that names the file and carries none of its text:
 * what was typed, then `[Attached file: name]` for every attachment. For the places that keep a message
 * beyond the turn (the Knowledge Base card of a Chat thread) and must say that a file was attached
 * without holding what was in it: the content lives in the person's own private desk copy.
 */
export function attachmentsAsMentions(text: string): string {
  const names = [...text.matchAll(ATTACH_NAME_RE)].map((match) => match[1] ?? "");
  if (names.length === 0) {
    return text;
  }
  const typed = typedTextOf(text);
  const mentions = names.map((name) => `[Attached file: ${name}]`).join("\n");
  return typed === "" ? mentions : `${typed}\n\n${mentions}`;
}

export function attachmentCountOf(text: string): number {
  return [...text.matchAll(ATTACH_NAME_RE)].length;
}

export function redactAttachedParts(parts: ContentPart[]): ContentPart[] {
  return parts.map((part) => {
    if (part.type !== "text") {
      return part;
    }
    return { ...part, text: redactAttachedText(part.text) };
  });
}
