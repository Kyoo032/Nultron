import { DEFAULT_APP_LOCALE, parseAppLocale, type AppLocale } from "@agentforge/core/locale";
import enAuth from "../locales/en/auth.json";
import enChannels from "../locales/en/channels.json";
import enCustomers from "../locales/en/customers.json";
import enChat from "../locales/en/chat.json";
import enCommon from "../locales/en/common.json";
import enData from "../locales/en/data.json";
import enDocuments from "../locales/en/documents.json";
import enEdit from "../locales/en/edit.json";
import enEducation from "../locales/en/education.json";
import enFinance from "../locales/en/finance.json";
import enGuide from "../locales/en/guide.json";
import enImages from "../locales/en/images.json";
import enKnowledge from "../locales/en/knowledge.json";
import enLegal from "../locales/en/legal.json";
import enMarket from "../locales/en/market.json";
import enMcp from "../locales/en/mcp.json";
import enMeeting from "../locales/en/meeting.json";
import enMusic from "../locales/en/music.json";
import enOnboarding from "../locales/en/onboarding.json";
import enPlans from "../locales/en/plans.json";
import enPresentation from "../locales/en/presentation.json";
import enRail from "../locales/en/rail.json";
import enResearch from "../locales/en/research.json";
import enSettings from "../locales/en/settings.json";
import enUsage from "../locales/en/usage.json";
import enVideos from "../locales/en/videos.json";
import enWorkspaces from "../locales/en/workspaces.json";
import enFiles from "../locales/en/files.json";
import enFolder from "../locales/en/folder.json";
import enAgents from "../locales/en/agents.json";
import enHarness from "../locales/en/harness.json";
import enVoice from "../locales/en/voice.json";
import enTeam from "../locales/en/team.json";
import idAgents from "../locales/id/agents.json";
import idHarness from "../locales/id/harness.json";
import idVoice from "../locales/id/voice.json";
import idAuth from "../locales/id/auth.json";
import idChannels from "../locales/id/channels.json";
import idCustomers from "../locales/id/customers.json";
import idChat from "../locales/id/chat.json";
import idCommon from "../locales/id/common.json";
import idData from "../locales/id/data.json";
import idDocuments from "../locales/id/documents.json";
import idEdit from "../locales/id/edit.json";
import idEducation from "../locales/id/education.json";
import idFinance from "../locales/id/finance.json";
import idGuide from "../locales/id/guide.json";
import idImages from "../locales/id/images.json";
import idKnowledge from "../locales/id/knowledge.json";
import idLegal from "../locales/id/legal.json";
import idMarket from "../locales/id/market.json";
import idMcp from "../locales/id/mcp.json";
import idMeeting from "../locales/id/meeting.json";
import idMusic from "../locales/id/music.json";
import idOnboarding from "../locales/id/onboarding.json";
import idPlans from "../locales/id/plans.json";
import idPresentation from "../locales/id/presentation.json";
import idRail from "../locales/id/rail.json";
import idResearch from "../locales/id/research.json";
import idSettings from "../locales/id/settings.json";
import idUsage from "../locales/id/usage.json";
import idVideos from "../locales/id/videos.json";
import idWorkspaces from "../locales/id/workspaces.json";
import idFiles from "../locales/id/files.json";
import idFolder from "../locales/id/folder.json";
import idTeam from "../locales/id/team.json";

const NAMESPACES = [
  "common",
  "rail",
  "settings",
  "onboarding",
  "chat",
  "documents",
  "research",
  "images",
  "videos",
  "music",
  "presentation",
  "plans",
  "knowledge",
  "workspaces",
  "files",
  "folder",
  "usage",
  "channels",
  "customers",
  "mcp",
  "market",
  "data",
  "finance",
  "legal",
  "edit",
  "education",
  "meeting",
  "auth",
  "guide",
  // Tester code: the virtual agents shell (`agents`) and what an agent is made of (`harness`).
  "agents",
  "harness",
  // Live voice in Chat: the mic, the voice view and its errors.
  "voice",
  "team",
] as const;
type Namespace = (typeof NAMESPACES)[number];
type MessageTree = { [key: string]: string | MessageTree };

const catalogs: Record<AppLocale, Record<Namespace, MessageTree>> = {
  en: {
    common: enCommon,
    rail: enRail,
    settings: enSettings,
    onboarding: enOnboarding,
    chat: enChat,
    documents: enDocuments,
    research: enResearch,
    images: enImages,
    videos: enVideos,
    music: enMusic,
    presentation: enPresentation,
    plans: enPlans,
    knowledge: enKnowledge,
    channels: enChannels,
    customers: enCustomers,
    mcp: enMcp,
    workspaces: enWorkspaces,
    files: enFiles,
    folder: enFolder,
    usage: enUsage,
    market: enMarket,
    data: enData,
    finance: enFinance,
    legal: enLegal,
    edit: enEdit,
    education: enEducation,
    meeting: enMeeting,
    auth: enAuth,
    guide: enGuide,
    agents: enAgents,
    harness: enHarness,
    voice: enVoice,
    team: enTeam,
  },
  id: {
    common: idCommon,
    rail: idRail,
    settings: idSettings,
    onboarding: idOnboarding,
    chat: idChat,
    documents: idDocuments,
    research: idResearch,
    images: idImages,
    videos: idVideos,
    music: idMusic,
    presentation: idPresentation,
    plans: idPlans,
    knowledge: idKnowledge,
    channels: idChannels,
    customers: idCustomers,
    mcp: idMcp,
    workspaces: idWorkspaces,
    files: idFiles,
    folder: idFolder,
    usage: idUsage,
    market: idMarket,
    data: idData,
    finance: idFinance,
    legal: idLegal,
    edit: idEdit,
    education: idEducation,
    meeting: idMeeting,
    auth: idAuth,
    guide: idGuide,
    agents: idAgents,
    harness: idHarness,
    voice: idVoice,
    team: idTeam,
  },
};

let frozen: AppLocale | null = null;

export const LOCALE_RESTART_EVENT = "agentforge-locale-restart";

export function freezeLocale(locale: unknown): AppLocale {
  if (frozen) {
    return frozen;
  }
  return applyLocale(locale);
}

/** Overwrite the boot freeze. Settings Restart is the only product caller. */
export function applyLocale(locale: unknown): AppLocale {
  frozen = parseAppLocale(locale);
  if (typeof document !== "undefined") {
    document.documentElement.lang = frozen;
  }
  return frozen;
}

export function getLocale(): AppLocale {
  return frozen ?? DEFAULT_APP_LOCALE;
}

export function resetLocaleForTests(): void {
  frozen = null;
}

function walk(node: unknown, parts: string[]): unknown {
  let current = node;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function lookup(locale: AppLocale, key: string): string | undefined {
  const dot = key.indexOf(".");
  if (dot <= 0) {
    return undefined;
  }
  const ns = key.slice(0, dot);
  const rest = key.slice(dot + 1);
  if (!NAMESPACES.includes(ns as Namespace)) {
    return undefined;
  }
  const catalog = catalogs[locale][ns as Namespace];
  const nested = walk(catalog, rest.split("."));
  if (typeof nested === "string") {
    return nested;
  }
  const flat = catalog[rest];
  return typeof flat === "string" ? flat : undefined;
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (all, name: string) => {
    const value = vars[name];
    return value == null ? all : String(value);
  });
}

/** Single UI translator. Missing `id` keys fall back to English; missing English returns the key. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const locale = getLocale();
  const value = lookup(locale, key) ?? (locale === "en" ? undefined : lookup("en", key));
  if (value == null) {
    return key;
  }
  return interpolate(value, vars);
}
