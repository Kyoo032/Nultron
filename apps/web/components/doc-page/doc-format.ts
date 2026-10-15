import type { DocAuthor, DocFormat, DocKind } from "@/lib/docs-client";
import { getLocale, t } from "@/lib/i18n";
import { personName } from "@/lib/people-names";
import { virtualAgentName, type VirtualAgentInfo } from "@/lib/virtual-agents";

export type DocPeople = {
  readonly me: string | null;
  readonly nameOf: (userId: string) => string | null;
};

export const NO_PEOPLE: DocPeople = { me: null, nameOf: () => null };

export function docPagePath(artifactId: string, workspaceId?: string | null): string {
  const base = `/docs/${encodeURIComponent(artifactId)}`;
  return workspaceId ? `${base}?workspace=${encodeURIComponent(workspaceId)}` : base;
}

export function downloadFormats(kind: DocKind): readonly DocFormat[] {
  return kind === "workbook" ? ["xlsx"] : ["docx", "pdf"];
}

export function primaryFormat(kind: DocKind): DocFormat {
  return kind === "workbook" ? "xlsx" : "docx";
}

export function fileNameFor(title: string, version: number, format: DocFormat): string {
  const safe = title.replace(/[\\/:*?"<>|]/g, "-").trim() || "document";
  return `${safe} v${version}.${format}`;
}

export function initialsOf(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return "?";
  }
  const letters = words.length === 1 ? words[0].slice(0, 2) : `${words[0][0]}${words[1][0]}`;
  return letters.toUpperCase();
}

export function personLabel(people: DocPeople, userId: string): string {
  if (userId === people.me) {
    return t("docpage.you");
  }
  return personName({ userId, name: people.nameOf(userId) });
}

export function agentLabel(agentId: string): string {
  const label = virtualAgentName({ id: agentId as VirtualAgentInfo["id"], generalist: false }, "");
  return label === `rail.${agentId}` ? agentId : label;
}

export type AuthorLine = { readonly who: string; readonly caption: string | null; readonly title: string };

export function authorLine(people: DocPeople, author: DocAuthor): AuthorLine {
  if (author.kind === "person") {
    const who = personLabel(people, author.userId);
    return { who, caption: null, title: t("docpage.mark.edited", { name: who }) };
  }
  const agent = agentLabel(author.agentId);
  const asker = personLabel(people, author.askedByUserId);
  return {
    who: agent,
    caption: t("docpage.mark.agentCaption", { agent, name: asker }),
    title: t("docpage.mark.agentTitle", { agent, name: asker }),
  };
}

export function versionAuthorText(people: DocPeople, author: DocAuthor): string {
  if (author.kind === "person") {
    return t("docpage.versions.savedBy", { name: personLabel(people, author.userId) });
  }
  return t("docpage.versions.agentAsked", {
    agent: agentLabel(author.agentId),
    name: personLabel(people, author.askedByUserId),
  });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function intlLocale(): string {
  return getLocale() === "id" ? "id-ID" : "en-US";
}

export function relativeTime(then: number, now: number = Date.now()): string {
  const elapsed = now - then;
  if (elapsed < MINUTE) {
    return t("docpage.time.now");
  }
  const formatter = new Intl.RelativeTimeFormat(intlLocale(), { numeric: "auto" });
  if (elapsed < HOUR) {
    return formatter.format(-Math.floor(elapsed / MINUTE), "minute");
  }
  if (elapsed < DAY) {
    return formatter.format(-Math.floor(elapsed / HOUR), "hour");
  }
  if (elapsed < 30 * DAY) {
    return formatter.format(-Math.floor(elapsed / DAY), "day");
  }
  return new Date(then).toLocaleDateString(intlLocale());
}

export type FailureKind = "not_found" | "not_editable" | "failed";

export function failureKind(error: { readonly code: string; readonly status: number } | null): FailureKind {
  if (error?.status === 404 || error?.code === "not_found") {
    return "not_found";
  }
  if (error?.code === "not_editable") {
    return "not_editable";
  }
  return "failed";
}
