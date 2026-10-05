/**
 * What a run created on the desk, and the removal of it through the same public API.
 *
 * A run leaves three kinds of rows: threads (Chat), datasets (Data) and artifacts (Data, Documents,
 * Presentation, Research). Deleting an artifact also drops its Knowledge work card
 * (`handleDeleteArtifact`), so no fourth list is needed. Usage rows cannot be deleted through the API
 * and stay; they are the cost of the run.
 */
import { errorText, isOk, describeError, type Http } from "./client";
import type { CleanupRecord } from "./rows";

export type Created = { threads: string[]; datasets: string[]; artifacts: string[] };

export type Tracker = {
  thread(id: string): void;
  dataset(id: string): void;
  artifact(id: string): void;
  snapshot(): Created;
};

export function createTracker(): Tracker {
  const created: Created = { threads: [], datasets: [], artifacts: [] };
  const add = (list: string[], id: string) => {
    if (id && !list.includes(id)) {
      list.push(id);
    }
  };
  return {
    thread: (id) => add(created.threads, id),
    dataset: (id) => add(created.datasets, id),
    artifact: (id) => add(created.artifacts, id),
    snapshot: () => ({
      threads: [...created.threads],
      datasets: [...created.datasets],
      artifacts: [...created.artifacts],
    }),
  };
}

type ArtifactListItem = { id?: unknown; mode?: unknown; meta?: { question?: unknown } };

function artifactItems(body: unknown): ArtifactListItem[] {
  const items = body && typeof body === "object" ? (body as { items?: unknown }).items : null;
  return Array.isArray(items) ? (items as ArtifactListItem[]) : [];
}

export async function listArtifactIds(http: Http): Promise<Set<string>> {
  const { status, body } = await http.get("/api/v1/artifacts");
  if (!isOk(status)) {
    throw new Error(`could not list artifacts: ${errorText(body, status)}`);
  }
  return new Set(artifactItems(body).flatMap((item) => (typeof item.id === "string" ? [item.id] : [])));
}

/**
 * Artifacts that appeared since `known`, in `mode`, whose recorded question is `question`. The
 * Documents and Presentation routes answer with the draft only, so this is how a case finds the
 * artifact the route saved. Matching the question keeps a neighbour's artifact out of the cleanup.
 */
export function pickNewArtifacts(body: unknown, known: ReadonlySet<string>, mode: string, question: string): string[] {
  return artifactItems(body).flatMap((item) =>
    typeof item.id === "string" && !known.has(item.id) && item.mode === mode && item.meta?.question === question
      ? [item.id]
      : [],
  );
}

export async function findNewArtifacts(
  http: Http,
  known: ReadonlySet<string>,
  mode: string,
  question: string,
): Promise<string[]> {
  const { status, body } = await http.get(`/api/v1/artifacts?mode=${encodeURIComponent(mode)}`);
  return isOk(status) ? pickNewArtifacts(body, known, mode, question) : [];
}

async function removeAll(
  http: Http,
  label: string,
  pathOf: (id: string) => string,
  ids: readonly string[],
  failed: string[],
): Promise<string[]> {
  const removed: string[] = [];
  for (const id of ids) {
    try {
      const { status, body } = await http.del(pathOf(id));
      if (isOk(status) || status === 404) {
        removed.push(id);
      } else {
        failed.push(`${label} ${id}: ${errorText(body, status)}`);
      }
    } catch (error) {
      failed.push(`${label} ${id}: ${describeError(error)}`);
    }
  }
  return removed;
}

async function stillThere(http: Http, path: string): Promise<boolean> {
  try {
    return (await http.get(path)).status !== 404;
  } catch {
    return true;
  }
}

/** Delete everything the run made, then ask for each id again; a 404 is the proof it is gone. */
export async function cleanUp(http: Http, created: Created): Promise<CleanupRecord> {
  const failed: string[] = [];
  const threads = await removeAll(http, "thread", (id) => `/api/v1/threads/${id}`, created.threads, failed);
  const datasets = await removeAll(http, "dataset", (id) => `/api/v1/datasets/${id}`, created.datasets, failed);
  const artifacts = await removeAll(http, "artifact", (id) => `/api/v1/artifacts/${id}`, created.artifacts, failed);
  const checks = [
    ...threads.map((id) => `/api/v1/threads/${id}`),
    ...datasets.map((id) => `/api/v1/datasets/${id}`),
    ...artifacts.map((id) => `/api/v1/artifacts/${id}`),
  ];
  const remaining = await Promise.all(checks.map((path) => stillThere(http, path)));
  return {
    threads,
    datasets,
    artifacts,
    failed,
    verifiedGone: failed.length === 0 && remaining.every((there) => !there),
  };
}

/**
 * Artifacts a case did not see but its run made anyway: a request that timed out on this side can
 * still finish on the host and save its artifact afterwards. Anything new whose recorded question is
 * one this run asked belongs to the run.
 */
export async function findStrayArtifacts(
  http: Http,
  known: ReadonlySet<string>,
  questions: ReadonlySet<string>,
): Promise<string[]> {
  const { status, body } = await http.get("/api/v1/artifacts");
  if (!isOk(status)) {
    return [];
  }
  return artifactItems(body).flatMap((item) =>
    typeof item.id === "string" &&
    !known.has(item.id) &&
    typeof item.meta?.question === "string" &&
    questions.has(item.meta.question)
      ? [item.id]
      : [],
  );
}
