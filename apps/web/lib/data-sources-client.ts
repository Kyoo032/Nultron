import { apiFetch } from "./api-client";

/** One data source as the API returns it — never a secret, at most `secretLast4`. */
export type DataSource = {
  readonly id: string;
  readonly kind: "s3" | "azure_blob" | "postgres" | "mysql";
  readonly name: string;
  readonly status: "active" | "disabled";
  readonly hasCredentials: boolean;
  readonly secretLast4: string | null;
  readonly lastSyncAt: number | null;
  readonly lastSyncResult: "ok" | "failed" | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

async function json<T>(res: Response): Promise<T> {
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      data && typeof data === "object" && typeof (data as { error?: { message?: unknown } }).error?.message === "string"
        ? (data as { error: { message: string } }).error.message
        : `Request failed (${res.status})`;
    throw new Error(message);
  }
  return data as T;
}

export async function listDataSources(): Promise<DataSource[]> {
  return (await json<{ dataSources: DataSource[] }>(await apiFetch("/api/v1/data-sources"))).dataSources;
}

export type CreateDataSourceInput = {
  name: string;
} & Record<string, unknown>;

export async function createDataSource(input: CreateDataSourceInput): Promise<DataSource> {
  return (
    await json<{ dataSource: DataSource }>(
      await apiFetch("/api/v1/data-sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    )
  ).dataSource;
}

async function post<T>(id: string, action: string): Promise<T> {
  return json<T>(await apiFetch(`/api/v1/data-sources/${id}/${action}`, { method: "POST" }));
}

export const testDataSource = (id: string) => post<{ ok: boolean }>(id, "test");
export const syncDataSource = (id: string) => post<{ runId: string; filesOk: number; filesFailed: number }>(id, "sync");
export const disableDataSource = async (id: string) =>
  (await post<{ dataSource: DataSource }>(id, "disable")).dataSource;
export const deleteDataSourceCredentials = async (id: string) =>
  (
    await json<{ dataSource: DataSource }>(
      await apiFetch(`/api/v1/data-sources/${id}/credentials`, { method: "DELETE" }),
    )
  ).dataSource;
