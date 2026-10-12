import {
  asRecord,
  classifyOutcome,
  isRichTool,
  readCodeResult,
  readString,
  type Rec,
  type RichToolKey,
  type ToolStatus,
} from "@/components/tool-rows/results";
import { DOSSIER_TOOL_KEY, readDossierResult } from "@/components/tool-rows/dossier-result";
import { t } from "@/lib/i18n";

/** Fast tools still show a completed row; they skip the long "Working…" spinner. */

const COMPACT_TOOLS = new Set(["calculator", "datetime"]);

const ACTIVITY_KEYS: Record<string, string> = {
  web_search: "chat.tool.searching",
  web_fetch: "chat.tool.fetching",
  image_generate: "chat.tool.creatingImage",
  video_generate: "chat.tool.creatingVideo",
  past_sessions: "chat.tool.pastChats",
  calculator: "chat.tool.calculating",
  datetime: "chat.tool.clock",
  self_check: "chat.tool.selfChecking",
  research_dossier: "agents.progress.working",
};

const DONE_KEYS: Record<string, string> = {
  web_search: "chat.tool.search",
  web_fetch: "chat.tool.fetch",
  image_generate: "chat.tool.image",
  video_generate: "chat.tool.video",
  past_sessions: "chat.tool.pastSessions",
  calculator: "chat.tool.calculator",
  datetime: "chat.tool.datetime",
  self_check: "chat.tool.selfCheck",
  research_dossier: "agents.dossier.label",
};

export function showsToolActivity(_toolKey: string): boolean {
  return true;
}

export function showsToolSpinner(toolKey: string): boolean {
  return !COMPACT_TOOLS.has(toolKey);
}

/** The two engines `run_code` has. Proper names, the same in every language. */
const CODE_LANGUAGE_NAMES: Readonly<Record<string, string>> = { python: "Python", javascript: "JavaScript" };

/** A model-written query or pattern can be long; the row is one line and the full text is in its title. */
const LABEL_ARG_MAX = 80;

export function codeLanguageName(language: unknown): string | undefined {
  return typeof language === "string" ? CODE_LANGUAGE_NAMES[language.trim().toLowerCase()] : undefined;
}

function capArg(text: string): string {
  return text.length > LABEL_ARG_MAX ? `${text.slice(0, LABEL_ARG_MAX - 1).trimEnd()}…` : text;
}

/**
 * The host a `web_fetch` call opened: only the host, never the path or query, which can carry a
 * token and does not fit a one-line row. Null for a missing, malformed or non-web address.
 */
function fetchedHost(input: unknown): string | null {
  const url = readString(asRecord(input), "url");
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname
      ? capArg(parsed.hostname)
      : null;
  } catch {
    return null;
  }
}

/** One sentence for a `web_fetch` call: "Opened example.com". Without a host it says it plainly. */
function webFetchLabel(input: unknown, output: unknown, status: ToolStatus): string {
  const host = fetchedHost(input);
  const state = classifyOutcome("web_fetch", status, output).state;
  if (state === "running") {
    return host ? t("chat.tools.doing.web_fetch", { host }) : t("chat.tool.fetching");
  }
  if (state === "refused" || state === "budget") {
    return host ? t("chat.tools.failed.web_fetch", { host }) : t("chat.tool.fetchFailed");
  }
  return host ? t("chat.tools.done.web_fetch", { host }) : t("chat.tool.fetch");
}

/**
 * What a rich tool's label names, taken from its arguments. Null when a required argument is
 * missing; `list_files` names nothing when it is asked for the top of the desk, so it gets `{}`.
 */
function labelVars(toolKey: RichToolKey, args: Rec | null): Record<string, string> | null {
  switch (toolKey) {
    case "read_file":
    case "write_file":
    case "edit_file":
    case "delete_file": {
      const path = readString(args, "path");
      return path ? { path } : null;
    }
    case "list_files": {
      const dir = readString(args, "dir");
      return dir ? { dir } : {};
    }
    case "search_files": {
      const pattern = readString(args, "pattern");
      return pattern ? { query: capArg(pattern) } : null;
    }
    case "knowledge_search": {
      const query = readString(args, "query");
      return query ? { query: capArg(query) } : null;
    }
    case "run_code": {
      const language = codeLanguageName(args?.language);
      return language ? { language } : null;
    }
    case "build_deck": {
      const title = readString(args, "title");
      return title ? { title: capArg(title) } : null;
    }
  }
}

type RowGroup = "doing" | "done" | "failed" | "pending";

function rowGroup(toolKey: RichToolKey, status: ToolStatus, output: unknown): RowGroup {
  const outcome = classifyOutcome(toolKey, status, output);
  if (outcome.state === "running") {
    return "doing";
  }
  if (outcome.state === "pending") {
    return "pending";
  }
  if (outcome.state === "refused" || outcome.state === "budget") {
    return "failed";
  }
  const run = toolKey === "run_code" ? readCodeResult(output) : null;
  return run && !run.ok ? "failed" : "done";
}

/**
 * One plain sentence for a file, Knowledge or code tool call, in the person's language: "Read
 * notes/plan.md", "Searched files for “total”", "Ran Python". It follows the call's state, so a
 * refused read says "Could not read …" and a folder change still waiting says it was proposed.
 * Any other tool keeps `toolDoneLabel`.
 */
export function toolRowLabel(
  toolKey: string,
  input?: unknown,
  output?: unknown,
  status: ToolStatus = "completed",
): string {
  if (toolKey === "web_fetch") {
    return webFetchLabel(input, output, status);
  }
  if (!isRichTool(toolKey)) {
    return toolDoneLabel(toolKey);
  }
  const group = rowGroup(toolKey, status, output);
  if (group === "pending") {
    return t(`chat.tools.pending.${toolKey}`);
  }
  const vars = labelVars(toolKey, asRecord(input));
  const optional = toolKey === "list_files" || (group === "failed" && toolKey === "knowledge_search");
  if (!vars && !optional) {
    return group === "doing" ? t("chat.tool.working") : t(`chat.tools.name.${toolKey}`);
  }
  const top = toolKey === "list_files" && group !== "failed" && !vars?.dir;
  return t(`chat.tools.${group}.${top ? "list_files_top" : toolKey}`, vars ?? {});
}

export function toolActivityLabel(toolKey: string, input?: unknown): string {
  if (toolKey === "web_fetch") {
    return webFetchLabel(input, undefined, "started");
  }
  if (isRichTool(toolKey)) {
    return toolRowLabel(toolKey, input, undefined, "started");
  }
  return t(ACTIVITY_KEYS[toolKey] ?? "chat.tool.working");
}

export function toolDoneLabel(toolKey: string): string {
  if (isRichTool(toolKey)) {
    return t(`chat.tools.name.${toolKey}`);
  }
  const key = DONE_KEYS[toolKey];
  return key ? t(key) : toolKey.replace(/_/g, " ");
}

/**
 * A readable one-line gist for the tool row. This is the *summary* — the row is 12px and must
 * stay a single line — so the shape matters more than the content: a past-sessions call whose
 * output is `{"success":true,"sessions":[]}` should read as "no sessions", not as raw JSON.
 * Anything we do not recognise is dropped to a capped, unquoted string rather than dumped.
 */
function gist(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "string") {
    const text = value.trim();
    return text.length > 60 ? `${text.slice(0, 59).trimEnd()}…` : text;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    // A list result: say how many, not what they are.
    for (const key of ["sessions", "results", "items", "matches", "rows"]) {
      const list = record[key];
      if (Array.isArray(list)) {
        return list.length === 0 ? "none" : `${list.length} found`;
      }
    }
    for (const key of ["result", "expression", "query", "iso", "text", "message", "answer"]) {
      if (key in record) {
        return gist(record[key]);
      }
    }
    if ("success" in record && record.success === true) {
      return "ok";
    }
    // A single named argument (`{"action":"list"}`) is the argument's value, not "1 field".
    const keys = Object.keys(record);
    if (keys.length === 1) {
      const only = record[keys[0]!];
      if (typeof only === "string" || typeof only === "number" || typeof only === "boolean") {
        return gist(only);
      }
    }
    return keys.length === 0 ? "empty" : `${keys.length} field${keys.length === 1 ? "" : "s"}`;
  }
  return "";
}

/**
 * The Thinking row of a dossier call: the label and the dossier's title, or the reason it failed. The
 * generic gist would print the question and "6 fields". The card under the answer carries the rest.
 */
function dossierSummary(label: string, output: unknown): string {
  const model = readDossierResult(undefined, output);
  if (model) {
    return `${label} · ${gist(model.title)}`;
  }
  const message = readString(asRecord(output), "message");
  return message ? `${label} · ${gist(message)}` : label;
}

export function toolCallSummary(toolKey: string, input?: unknown, output?: unknown): string {
  if (toolKey === "web_fetch") {
    return webFetchLabel(input, output, "completed");
  }
  if (isRichTool(toolKey)) {
    return toolRowLabel(toolKey, input, output);
  }
  const label = toolDoneLabel(toolKey);
  if (toolKey === DOSSIER_TOOL_KEY) {
    return dossierSummary(label, output);
  }
  const out = gist(output);
  const inn = gist(input);
  if (out && inn) {
    return `${label} · ${inn} → ${out}`;
  }
  if (out) {
    return `${label} · ${out}`;
  }
  if (inn) {
    return `${label} · ${inn}`;
  }
  return label;
}
