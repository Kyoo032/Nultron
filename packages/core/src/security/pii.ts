import type { ContentPart } from "../content/types";
import { digitsOnly, passesLuhn, scanIndonesianIds } from "./pii-id";

export { passesLuhn };

export type PiiKind = "email" | "phone" | "id" | "card" | "nik" | "npwp" | "account" | "name";

export const PII_MASK: Record<PiiKind, string> = {
  email: "[email]",
  phone: "[phone]",
  id: "[id]",
  card: "[card]",
  nik: "[nik]",
  npwp: "[npwp]",
  account: "[account]",
  name: "[name]",
};

export type PiiFinding = {
  kind: PiiKind;
  match: string;
  index: number;
};

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/** Intl-ish phones: optional +, country code, groups of digits with spaces/dashes/parens. */
const PHONE_RE = /(?:(?:\+|00)\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)\d{3,4}[\s.-]?\d{3,4}(?:[\s.-]?\d{1,4})?/g;

/** 13–19 digit runs, allowing common separators. */
const CARD_CANDIDATE_RE = /\b(?:\d[ -]*?){13,19}\b/g;

/** Long ID-like numbers: SSN / national-id style with separators. Bare digit runs are quantities. */
const ID_RE = /\b(?:\d{3}[-\s]\d{2}[-\s]\d{4}|\d{2}[-\s]\d{2}[-\s]\d{2}[-\s]\d{2,4})\b/g;

/**
 * Common non-person capitalized words (days, months, Indonesian/English places, banks, orgs,
 * finance/document headers, product names, common function words). Any token here stops
 * context-cued person-name collection so prose, headers, and finance tables stay intact.
 */
const NAME_STOPLIST: ReadonlySet<string> = new Set([
  // Days & months (EN + ID)
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "senin", "selasa", "rabu", "kamis", "jumat", "sabtu", "minggu", "ahad",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "januari", "februari", "maret", "mei", "juni", "juli", "agustus", "oktober", "desember",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "agu", "agt", "sep", "sept", "oct", "okt", "nov", "nop", "dec", "des",
  // Honorifics & titles
  "bapak", "bpk", "ibu", "pak", "bu", "sdr", "sdri", "tn", "ny", "nn", "yth",
  "mr", "mrs", "ms", "miss", "dr", "prof", "ir", "haji", "hajjah",
  // Places, cities, regions, countries
  "indonesia", "jakarta", "bandung", "surabaya", "medan", "semarang", "yogyakarta", "jogja",
  "makassar", "palembang", "tangerang", "depok", "bekasi", "bogor", "malang", "bali", "denpasar",
  "batam", "pekanbaru", "padang", "balikpapan", "samarinda", "banjarmasin", "pontianak", "manado",
  "jawa", "sumatra", "sumatera", "kalimantan", "sulawesi", "papua", "nusantara",
  "singapore", "singapura", "malaysia", "kuala", "lumpur", "thailand", "bangkok", "vietnam",
  "philippines", "japan", "tokyo", "china", "beijing", "shanghai", "korea", "seoul", "india",
  "australia", "sydney", "melbourne", "united", "states", "america", "new", "york", "san",
  "francisco", "london", "europe", "asia", "barat", "timur", "utara", "selatan", "tengah", "pusat",
  // Banks, legal entities, orgs, brands, products
  "bank", "bca", "bri", "bni", "mandiri", "bsi", "cimb", "niaga", "danamon", "ocbc", "nisp",
  "btn", "panin", "maybank", "uob", "hsbc", "citibank", "jago", "seabank", "jenius", "blu",
  "gopay", "ovo", "dana", "shopeepay", "linkaja", "qris", "ojk", "kemenkeu", "djp", "bpjs",
  "pt", "cv", "tbk", "ud", "yayasan", "koperasi", "perusahaan", "persero", "inc", "ltd", "llc",
  "corp", "gmbh", "group", "holdings", "ventures", "capital", "partners",
  "nultron", "agentforge", "toko", "token", "enterprise", "personal", "desktop", "web", "api", "sdk",
  "openai", "anthropic", "google", "deepmind", "gemini", "claude", "gpt", "deepseek", "qwen",
  "minimax", "kimi", "seedance", "suno", "tavily", "brave", "metranet", "aihub", "weknora",
  // Finance, document, business, tech & common nouns/adjectives
  "revenue", "total", "subtotal", "summary", "ringkasan", "laporan", "report", "draft", "memo",
  "brief", "notes", "note", "catatan", "dossier", "finance", "keuangan", "akuntansi", "accounting",
  "budget", "anggaran", "cashflow", "arus", "kas", "saldo", "balance", "amount", "jumlah", "nilai",
  "value", "profit", "laba", "loss", "rugi", "gross", "kotor", "net", "bersih", "ebit", "ebitda",
  "tax", "pajak", "ppn", "pph", "npwp", "nik", "ktp", "rekening", "norek", "account", "accounts",
  "payable", "receivable", "piutang", "hutang", "utang", "aset", "asset", "assets", "equity",
  "ekuitas", "modal", "cost", "costs", "biaya", "beban", "expense", "expenses", "income",
  "pendapatan", "sales", "penjualan", "margin", "ratio", "rasio", "growth", "pertumbuhan",
  "forecast", "proyeksi", "projection", "quarter", "kuartal", "tahun", "year", "bulan", "month",
  "week", "hari", "day", "tanggal", "date", "periode", "period", "table", "tabel", "sheet",
  "lembar", "chart", "grafik", "data", "file", "berkas", "dokumen", "document", "documents",
  "contract", "kontrak", "agreement", "perjanjian", "invoice", "faktur", "receipt", "kwitansi",
  "kuitansi", "payment", "pembayaran", "transfer", "payroll", "gaji", "salary", "tunjangan",
  "bonus", "reimbursement", "project", "proyek", "team", "tim", "divisi", "division",
  "departemen", "department", "unit", "cabang", "branch", "kantor", "office", "headquarters",
  "perihal", "subject", "lampiran", "attachment", "attachments", "status", "active", "aktif",
  "pending", "approved", "rejected", "client", "klien", "customer", "pelanggan", "vendor",
  "supplier", "pemasok", "partner", "mitra", "employee", "karyawan", "pegawai", "staff", "staf",
  "manager", "director", "direktur", "ceo", "cfo", "cto", "coo", "owner", "pemilik", "admin",
  "user", "pengguna", "support", "dukungan", "service", "layanan", "product", "produk", "barang",
  "jasa", "harga", "price", "diskon", "discount", "promo", "order", "pesanan", "shipping",
  "pengiriman", "address", "alamat", "email", "phone", "telepon", "nomor", "number", "kode",
  "code", "id", "section", "bagian", "chapter", "bab", "page", "halaman", "slide", "slides",
  "deck", "presentation", "presentasi", "research", "riset", "market", "pasar", "legal", "hukum",
  "meeting", "rapat", "minutes", "notulen", "knowledge", "pengetahuan", "chat", "obrolan",
  "images", "gambar", "videos", "video", "music", "musik", "edit", "studio", "workspace",
  "workspaces", "settings", "pengaturan", "portal", "server", "app", "system", "platform",
  "engine", "model", "agent", "worker", "bot", "tool", "mode", "plan", "tier", "pack", "desk",
  "card", "list", "grid", "view", "form", "menu", "bar", "tab", "panel", "modal", "dialog",
  "alert", "badge", "tag", "pill", "link", "icon", "logo", "image", "photo", "picture", "audio",
  "clip", "track", "song", "lyrics", "voice", "speech", "text", "copy", "title", "heading",
  "subhead", "bullet", "bullets", "aside", "footer", "header", "sidebar", "rail", "home",
  "inbox", "archive", "trash", "profile", "login", "logout", "signup", "signin", "invite",
  "reset", "verify", "confirm", "cancel", "delete", "remove", "create", "update", "save", "load",
  "send", "submit", "run", "start", "stop", "pause", "resume", "retry", "export", "import",
  "upload", "download", "search", "filter", "sort", "merge", "split", "share", "paste", "print",
  "help", "about", "terms", "privacy", "policy", "security", "audit", "log", "logs", "trace",
  "metric", "metrics", "kpi", "kpis", "roi", "irr", "npv", "wacc", "cagr", "yoy", "mom", "qoq",
  "ytd", "mtd", "gdp", "cpi", "fx", "usd", "idr", "eur", "sgd", "myr", "jpy", "gbp", "aud",
  "cny", "rmb", "info", "warning", "error", "all", "some", "any", "each", "every", "no", "not",
  "and", "or", "but", "for", "from", "with", "without", "into", "onto", "upon", "above", "below",
  "under", "over", "between", "among", "through", "during", "before", "after", "since", "until",
  "while", "where", "when", "who", "whom", "whose", "which", "what", "how", "why", "please",
  "thank", "thanks", "hello", "hi", "dear", "regards", "best", "sincerely", "the", "this",
  "that", "these", "those", "my", "your", "our", "their", "his", "her", "its", "dan", "atau",
  "yang", "di", "ke", "dari", "untuk", "pada", "dengan", "tanpa", "oleh", "sebagai", "adalah",
  "akan", "sudah", "belum", "tidak", "bukan", "ini", "itu", "tersebut", "kami", "kita", "anda",
  "saya", "mereka", "beliau", "terima", "kasih", "hormat", "salam", "mohon", "tolong", "silakan",
  "perhatian", "new", "old", "high", "low", "first", "second", "third", "last", "next",
  "previous", "open", "close", "main", "core", "full", "half", "one", "two", "three", "four",
  "five", "zero", "top", "bottom", "left", "right", "public", "private", "local", "global",
  "internal", "external", "default", "standard", "custom", "auto", "manual", "daily", "weekly",
  "monthly", "quarterly", "annual", "yearly", "fiscal", "final", "initial", "primary",
  "secondary", "general", "special", "executive", "senior", "junior", "chief", "head", "lead",
  "vice", "assistant", "associate", "board", "committee", "council", "ministry", "agency",
  "bureau", "authority", "commission", "central", "national", "international", "federal",
  "state", "city", "town", "village", "street", "road", "avenue", "building", "floor", "room",
  "suite", "tower", "plaza", "mall", "park", "center", "centre", "station", "airport", "port",
  "hospital", "school", "university", "college", "institute", "academy", "hotel", "resort",
  "club", "restaurant", "cafe", "shop", "store", "factory", "plant", "warehouse", "depot", "lab",
]);

const HONORIFIC_PART = "(?:bpk|bapak|ibu|pak|bu|sdr|sdri|tn|ny|nn|mr|mrs|ms|miss|dr|prof|ir)\\.?";
const LABEL_CUE_PART =
  "(?:nama(?:\\s+(?:lengkap|karyawan|pegawai|penerima|pemilik|nasabah|pic|kontak))?|name|full\\s+name|contact\\s+person|a\\.?\\s*n\\.?|atas\\s+nama|penerima|payee|signed\\s+by|ditandatangani\\s+oleh)";
const PREP_CUE_PART =
  "(?:kepada(?:\\s+yth\\.?)?|untuk|dari|ke|hubungi|contact|dear|oleh|by|attention|attn\\.?)";

const NAME_CUE_ONLY_RE = new RegExp(
  `(?:\\b${LABEL_CUE_PART}\\s*[:=-]?[ \\t]*(?:${HONORIFIC_PART}[ \\t]+)?|\\b${PREP_CUE_PART}[,:\\t ]+(?:${HONORIFIC_PART}[ \\t]+)?|\\b${HONORIFIC_PART}[ \\t]+)`,
  "gi",
);

/** Case-sensitive: each token must genuinely open with an uppercase letter followed by lowercase. */
const TITLE_NAME_SPAN_RE =
  /^([A-Z][a-z'’-]{1,24}(?:[ \t]+(?:[A-Z]\.?|[A-Z][a-z'’-]{1,24})){0,2}[ \t]+[A-Z][a-z'’-]{1,24})(?![A-Za-z])/;

function extractSafePersonName(rawSpan: string): string | null {
  const tokens = rawSpan.split(/[ \t]+/);
  const kept: string[] = [];
  for (const token of tokens) {
    const normalized = token.replace(/\.$/, "").toLowerCase();
    if (NAME_STOPLIST.has(normalized)) {
      break;
    }
    kept.push(token);
  }
  // Require at least two tokens and at least two multi-letter words (no trailing initial-only span).
  while (kept.length > 0) {
    const last = kept[kept.length - 1];
    if (!last || last.replace(/\./g, "").length >= 2) {
      break;
    }
    kept.pop();
  }
  const fullWords = kept.filter((token) => token.replace(/\./g, "").length >= 2);
  if (kept.length < 2 || fullWords.length < 2) {
    return null;
  }
  return kept.join(" ");
}

function pushUnique(findings: PiiFinding[], finding: PiiFinding): void {
  const exists = findings.some(
    (item) => item.kind === finding.kind && item.index === finding.index && item.match === finding.match,
  );
  if (!exists) {
    findings.push(finding);
  }
}

function overlapsFinding(findings: PiiFinding[], index: number, length: number): boolean {
  return findings.some((item) => index < item.index + item.match.length && index + length > item.index);
}

/** Bare digit runs are quantities (market cap, volume), not phones. Require + / 00 or separators. */
function hasPhoneFormatting(raw: string): boolean {
  return /^(?:\+|00)/.test(raw.trim()) || /[\s().-]/.test(raw);
}

/**
 * A bare digit run that ends in four zeros is a total, not a number to call. It is the same reading
 * {@link CARD_ROUND_TAIL_RE} gives a card-length run, and it is what keeps a signed or bracketed
 * `(1.000.000.000)` out of the phone detector: the wrapper looks like formatting, the digits do not.
 */
const ROUND_TOTAL_RE = /^\d+0{4}$/;

/**
 * Uniform three-digit groups with at most a two-digit decimal tail: `1.250.000`, `1,234,567.89`,
 * `23 960 000 000`. That is how money is written and it is not how a phone is written — phones group
 * by 3-4 and stop at fifteen digits, so no real number reaches four uniform groups.
 */
const GROUPED_THOUSANDS_RE = /^\d{1,3}(?:[.,\u00a0 ]\d{3})+(?:[.,]\d{1,2})?$/;

/**
 * The wrapper a sheet puts around a figure, taken off before the grouping is judged: accounting
 * brackets, a leading sign, padding. The closing bracket is peeled on its own because the matcher
 * hands over `(23.960.000.000` — it read the opening bracket as phone formatting and stopped at the
 * one it never reached.
 */
function amountBody(raw: string): string {
  return raw
    .trim()
    .replace(/^[(\s]+/, "")
    .replace(/[)\s]+$/, "")
    .replace(/^[-+]\s*/, "")
    .trim();
}

/**
 * `1.250.000.000.000` is a rupiah total, not a phone, and so is `(23.960.000.000)` — the accounting
 * way to write the negative of one. Both used to come back as `[phone]`, which silently rewrote the
 * one thing a Finance brief may not lose: a 2024 cost of sales reached the parser as `[phone])`.
 *
 * Peeling the bracket cannot turn a phone into money: a bracketed phone closes its area code before
 * the rest of the number (`(021) 555-1234`), so the `)` stays inside the body and no uniform
 * grouping survives it. A currency mark never enters the match at all — the phone pattern holds no
 * letters — so `Rp (1.250.000.000)` is judged on its digits like any other figure.
 */
function looksLikeAmount(raw: string): boolean {
  const body = amountBody(raw);
  return GROUPED_THOUSANDS_RE.test(body) || ROUND_TOTAL_RE.test(body);
}

/**
 * A phone is a whole token, so a match that begins or ends inside a longer number is a slice of one.
 *
 * A PDF flattens its table to one line and two figures end up side by side: `7.368.000.000
 * 9.004.650.000`. The matcher offers `368.000.000 9`, which is phone-shaped and passes every test
 * above, and masking it took both figures out of an annual report at once.
 *
 * The sentence-ending full stop is not "inside" anything, so only a separator with a digit behind it
 * counts. A match that opens with `+` is exempt on the left: no amount runs into a country code.
 */
function slicedFromNumber(text: string, index: number, raw: string): boolean {
  const after = text[index + raw.length] ?? "";
  if (/\d/.test(after) || (/[.,]/.test(after) && /\d/.test(text[index + raw.length + 1] ?? ""))) {
    return true;
  }
  return !raw.startsWith("+") && /[\d.,-]/.test(text[index - 1] ?? "");
}

/**
 * Issuer prefixes a run has to open with before an unseparated 13-19 digit number is read as a card.
 * Luhn alone passes roughly one bare digit run in ten, so a 16-digit rupiah total was being masked
 * as `[card]` about that often. A card written out by a person keeps its groups (`4111 1111 …`) and
 * still takes the formatted path below; only the bare case has to prove itself.
 */
const CARD_PREFIX_RE = /^(?:4|5[1-5]|2[2-7]|34|37|6011|64[4-9]|65|35|30[0-5]|36|3[89]|62)/;

/** No PAN ends in four zeros; a total nearly always does. */
const CARD_ROUND_TAIL_RE = /0{4}$/;

/** A bare run must look like an issued card, not like money. Separated runs keep the old rule. */
function bareRunLooksLikeCard(raw: string, digits: string): boolean {
  if (/[ -]/.test(raw)) {
    return true;
  }
  return CARD_PREFIX_RE.test(digits) && !CARD_ROUND_TAIL_RE.test(digits);
}

export function scanPii(text: string): PiiFinding[] {
  if (!text) {
    return [];
  }

  const findings: PiiFinding[] = [];

  // Indonesian identifiers go in first so a NIK that happens to pass Luhn reads as [nik] rather than
  // [card]. Each detector there needs a structure or a label an amount cannot have — see ./pii-id.ts.
  for (const found of scanIndonesianIds(text)) {
    pushUnique(findings, { kind: found.kind, match: found.match, index: found.index });
  }

  for (const match of text.matchAll(EMAIL_RE)) {
    if (match.index === undefined) {
      continue;
    }
    pushUnique(findings, { kind: "email", match: match[0], index: match.index });
  }

  for (const match of text.matchAll(PHONE_RE)) {
    if (match.index === undefined) {
      continue;
    }
    const raw = match[0];
    const digits = digitsOnly(raw);
    // Avoid short numbers (years, codes) and unformatted quantities (market cap).
    if (digits.length < 10 || digits.length > 15 || !hasPhoneFormatting(raw) || looksLikeAmount(raw)) {
      continue;
    }
    if (slicedFromNumber(text, match.index, raw)) {
      continue;
    }
    if (overlapsFinding(findings, match.index, raw.length)) {
      continue;
    }
    pushUnique(findings, { kind: "phone", match: raw, index: match.index });
  }

  for (const match of text.matchAll(CARD_CANDIDATE_RE)) {
    if (match.index === undefined) {
      continue;
    }
    const raw = match[0];
    const digits = digitsOnly(raw);
    if (!passesLuhn(digits) || !bareRunLooksLikeCard(raw, digits) || looksLikeAmount(raw)) {
      continue;
    }
    // An Indonesian identifier already claimed these digits; one span never gets two tokens.
    if (overlapsFinding(findings, match.index, raw.length)) {
      continue;
    }
    pushUnique(findings, { kind: "card", match: raw, index: match.index });
  }

  for (const match of text.matchAll(ID_RE)) {
    if (match.index === undefined) {
      continue;
    }
    const raw = match[0];
    const digits = digitsOnly(raw);
    if (digits.length < 9 || looksLikeAmount(raw)) {
      continue;
    }
    // Prefer card classification when Luhn-valid.
    if (passesLuhn(digits) && digits.length >= 13 && digits.length <= 19) {
      continue;
    }
    if (overlapsFinding(findings, match.index, raw.length)) {
      continue;
    }
    // Bare digit runs are quantities (market cap, volume), not IDs. Cards use Luhn.
    // SSN / national-id style needs separators.
    if (!/[-\s]/.test(raw)) {
      continue;
    }
    pushUnique(findings, { kind: "id", match: raw, index: match.index });
  }

  for (const cueMatch of text.matchAll(NAME_CUE_ONLY_RE)) {
    if (cueMatch.index === undefined) {
      continue;
    }
    const start = cueMatch.index + cueMatch[0].length;
    const spanMatch = TITLE_NAME_SPAN_RE.exec(text.slice(start));
    const rawCandidate = spanMatch?.[1];
    if (!rawCandidate) {
      continue;
    }
    const candidate = extractSafePersonName(rawCandidate);
    if (!candidate) {
      continue;
    }
    if (overlapsFinding(findings, start, candidate.length)) {
      continue;
    }
    pushUnique(findings, { kind: "name", match: candidate, index: start });
  }

  findings.sort((a, b) => a.index - b.index || a.kind.localeCompare(b.kind));
  return findings;
}

const KIND_LABEL: Record<PiiKind, string> = {
  email: "email addresses",
  phone: "phone numbers",
  id: "ID numbers",
  card: "card numbers",
  nik: "NIK numbers",
  npwp: "NPWP numbers",
  account: "bank account numbers",
  name: "names",
};

/** Replace findings with stable tokens. The original string is not mutated. */
export function maskPii(text: string): string {
  const findings = scanPii(text);
  if (findings.length === 0) {
    return text;
  }
  const ordered = [...findings].sort((left, right) => {
    if (right.index !== left.index) {
      return right.index - left.index;
    }
    return right.match.length - left.match.length;
  });
  let result = text;
  const consumed: Array<{ index: number; end: number }> = [];
  for (const finding of ordered) {
    const end = finding.index + finding.match.length;
    if (consumed.some((span) => finding.index < span.end && end > span.index)) {
      continue;
    }
    result = result.slice(0, finding.index) + PII_MASK[finding.kind] + result.slice(end);
    consumed.push({ index: finding.index, end });
  }
  return result;
}

const SKIP_JSON_MASK_KEYS: ReadonlySet<string> = new Set([
  "url",
  "href",
  "path",
  "id",
  "mediaId",
  "artifactId",
  "toolKey",
  "sourceId",
]);

const STANDALONE_LINK_RE = /^(?:https?:\/\/|\/api\/|data:)\S+$/i;

function maskPiiJsonWalk(value: unknown, key: string | undefined, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    if ((key && SKIP_JSON_MASK_KEYS.has(key)) || STANDALONE_LINK_RE.test(value.trim())) {
      return value;
    }
    return maskPii(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => maskPiiJsonWalk(item, undefined, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    out[entryKey] = maskPiiJsonWalk(entryValue, entryKey, seen);
  }
  return out;
}

/**
 * Recursively masks PII in string values of a JSON-shaped tool output while keeping technical
 * references (`url`, `href`, `path`, `id`, `mediaId`, `artifactId`, `toolKey`, `/api/...`, `http(s)://...`) intact.
 */
export function maskPiiInJson<T>(value: T): T {
  return maskPiiJsonWalk(value, undefined, new WeakSet()) as T;
}

export function maskPiiInParts(parts: ContentPart[]): ContentPart[] {
  return parts.map((part) => {
    if (part.type === "text" || part.type === "thinking") {
      return { ...part, text: maskPii(part.text) };
    }
    return part;
  });
}

export function maskOutboundRunInput<
  T extends {
    version: { systemPrompt: string };
    history: Array<{ role: "user" | "assistant"; parts: ContentPart[] }>;
  },
>(input: T): T {
  return {
    ...input,
    version: { ...input.version, systemPrompt: maskPii(input.version.systemPrompt) },
    history: input.history.map((item) => ({ ...item, parts: maskPiiInParts(item.parts) })),
  };
}

export function piiWarning(findings: PiiFinding[]): string | null {
  if (findings.length === 0) {
    return null;
  }
  const kinds = [...new Set(findings.map((item) => item.kind))];
  const labels = kinds.map((kind) => KIND_LABEL[kind]);
  if (labels.length === 1) {
    return `This prompt may contain ${labels[0]}. Remove personal data before sending.`;
  }
  if (labels.length === 2) {
    return `This prompt may contain ${labels[0]} and ${labels[1]}. Remove personal data before sending.`;
  }
  const head = labels.slice(0, -1).join(", ");
  const last = labels[labels.length - 1];
  return `This prompt may contain ${head}, and ${last}. Remove personal data before sending.`;
}
