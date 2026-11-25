"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { THREADS_CHANGED_EVENT } from "@/lib/threads-events";

export const SUBAGENTS_CHANGED_EVENT = "agentforge:subagents-changed";

export function notifySubagentsChanged() {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new Event(SUBAGENTS_CHANGED_EVENT));
}

export type DelegatedSessionStatus = "running" | "completed" | "failed" | "cancelled" | "timeout";

export type DelegatedSessionInfo = {
  readonly id: string;
  readonly parentThreadId: string;
  readonly childThreadId: string;
  readonly agentKey: string;
  readonly agentKind: "mode" | "bot";
  readonly agentName: string;
  readonly task: string;
  readonly status: DelegatedSessionStatus;
  readonly summary: string;
  readonly truncated: boolean;
  readonly toolsUsed: readonly string[];
  readonly error?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseSession(value: unknown): DelegatedSessionInfo | null {
  if (!isRecord(value)) {
    return null;
  }
  const { id, parentThreadId, childThreadId, agentKey, agentKind, agentName, task, status, summary } = value;
  if (
    typeof id !== "string" ||
    typeof parentThreadId !== "string" ||
    typeof childThreadId !== "string" ||
    typeof agentKey !== "string" ||
    typeof agentName !== "string" ||
    typeof task !== "string"
  ) {
    return null;
  }
  const validStatus: DelegatedSessionStatus =
    status === "running" || status === "completed" || status === "failed" || status === "cancelled" || status === "timeout"
      ? status
      : "failed";
  return {
    id,
    parentThreadId,
    childThreadId,
    agentKey,
    agentKind: agentKind === "bot" ? "bot" : "mode",
    agentName,
    task,
    status: validStatus,
    summary: typeof summary === "string" ? summary : "",
    truncated: value.truncated === true,
    toolsUsed: Array.isArray(value.toolsUsed)
      ? value.toolsUsed.filter((item): item is string => typeof item === "string")
      : [],
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
    ...(typeof value.finishedAt === "string" ? { finishedAt: value.finishedAt } : {}),
  };
}

export async function fetchThreadSubagents(threadId: string): Promise<DelegatedSessionInfo[]> {
  const response = await apiFetch(`/api/v1/threads/${encodeURIComponent(threadId)}/subagents`);
  if (!response.ok) {
    return [];
  }
  const payload = await response.json().catch(() => null);
  const rows = isRecord(payload) && Array.isArray(payload.sessions) ? payload.sessions : [];
  return rows.map(parseSession).filter((entry): entry is DelegatedSessionInfo => entry !== null);
}

export function useThreadSubagents(threadId?: string, { open = false }: { open?: boolean } = {}) {
  const [sessions, setSessions] = useState<DelegatedSessionInfo[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    if (!threadId) {
      setSessions([]);
      setLoaded(true);
      return;
    }
    try {
      const next = await fetchThreadSubagents(threadId);
      setSessions(next);
    } finally {
      setLoaded(true);
    }
  }, [threadId]);

  useEffect(() => {
    setLoaded(false);
    void reload();
    const onChanged = () => {
      void reload();
    };
    window.addEventListener(THREADS_CHANGED_EVENT, onChanged);
    window.addEventListener(SUBAGENTS_CHANGED_EVENT, onChanged);
    return () => {
      window.removeEventListener(THREADS_CHANGED_EVENT, onChanged);
      window.removeEventListener(SUBAGENTS_CHANGED_EVENT, onChanged);
    };
  }, [reload]);

  useEffect(() => {
    if (open) {
      void reload();
    }
  }, [open, reload]);

  const hasActive = sessions.some((session) => session.status === "running");
  const polling = hasActive || open;

  useEffect(() => {
    if (!threadId || !polling) {
      return;
    }
    const timer = window.setInterval(() => {
      void reload();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [threadId, polling, reload]);

  return { sessions, loaded, hasActive, reload };
}
