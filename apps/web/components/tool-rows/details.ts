import { t } from "@/lib/i18n";
import { asRecord, readList, readNumber, readString } from "./results";

/** At most this many source titles are named under a Knowledge search; the rest are a count. */
const TITLES_SHOWN = 3;
const TITLE_MAX = 60;

function count(n: number, many: string, one: string): string {
  return n === 1 ? t(`chat.tools.detail.${one}`) : t(`chat.tools.detail.${many}`, { n });
}

function countOrNone(n: number, many: string, one: string): string {
  return n === 0 ? t("chat.tools.detail.none") : count(n, many, one);
}

function withMore(text: string, truncated: boolean): string {
  return truncated ? `${text} · ${t("chat.tools.detail.more")}` : text;
}

/**
 * The short fact a finished call adds to its label: how many files, matches or excerpts it found,
 * which lines were read, which version was saved. Null when the output says nothing worth a word.
 */
export function toolDetail(toolKey: string, output: unknown): string | null {
  const record = asRecord(output);
  if (!record || record.ok === false) {
    return null;
  }
  const truncated = record.truncated === true;
  switch (toolKey) {
    case "list_files": {
      const total = readNumber(record, "total") ?? readList(record, "entries")?.length;
      return total === undefined ? null : withMore(countOrNone(total, "files", "filesOne"), truncated);
    }
    case "search_files": {
      const hits = readList(record, "hits");
      return hits === undefined ? null : withMore(countOrNone(hits.length, "matches", "matchesOne"), truncated);
    }
    case "knowledge_search": {
      const results = readList(record, "results");
      return results === undefined ? null : countOrNone(results.length, "excerpts", "excerptsOne");
    }
    case "read_file": {
      const from = readNumber(record, "firstLine");
      const to = readNumber(record, "lastLine");
      const total = readNumber(record, "totalLines");
      if (from === undefined || to === undefined || total === undefined || total === 0 || to < from) {
        return null;
      }
      return t("chat.tools.detail.lineRange", { from, to, total });
    }
    case "write_file":
    case "edit_file": {
      const version = readNumber(record, "version");
      return record.status === "saved" && version !== undefined ? t("chat.tools.detail.version", { n: version }) : null;
    }
    case "build_deck": {
      const slides = readNumber(record, "slideCount");
      return slides === undefined ? null : count(slides, "slides", "slidesOne");
    }
    default:
      return null;
  }
}

/** The source titles a Knowledge search matched, for one muted line under its label. */
export function knowledgeTitles(output: unknown): { shown: string; all: string } | null {
  const hits = readList(asRecord(output), "results");
  if (!hits || hits.length === 0) {
    return null;
  }
  const titles = hits.flatMap((hit) => {
    const title = readString(asRecord(hit), "title")?.trim();
    return title ? [title] : [];
  });
  if (titles.length === 0) {
    return null;
  }
  const clip = (title: string) => (title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1).trimEnd()}…` : title);
  return { shown: titles.slice(0, TITLES_SHOWN).map(clip).join(" · "), all: titles.join(" · ") };
}
