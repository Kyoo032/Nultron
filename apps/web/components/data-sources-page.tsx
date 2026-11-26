"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { t } from "@/lib/i18n";
import {
  createDataSource,
  deleteDataSourceCredentials,
  disableDataSource,
  listDataSources,
  syncDataSource,
  testDataSource,
  type DataSource,
} from "@/lib/data-sources-client";

type Kind = "s3" | "postgres";

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly sources: readonly DataSource[] };

const EMPTY_FORM = {
  name: "",
  kind: "s3" as Kind,
  endpoint: "",
  region: "",
  bucket: "",
  prefix: "",
  s3AccessKeyId: "",
  s3SecretAccessKey: "",
  host: "",
  port: "5432",
  database: "",
  user: "",
  secret: "",
  tableAllowlist: "",
};

function inputFor(kind: Kind, f: typeof EMPTY_FORM): Record<string, unknown> {
  const base = { name: f.name, kind };
  if (kind === "s3") {
    return {
      ...base,
      endpoint: f.endpoint,
      region: f.region,
      bucket: f.bucket,
      ...(f.prefix ? { prefix: f.prefix } : {}),
      s3AccessKeyId: f.s3AccessKeyId,
      s3SecretAccessKey: f.s3SecretAccessKey,
    };
  }
  return {
    ...base,
    host: f.host,
    port: Number(f.port),
    database: f.database,
    user: f.user,
    secret: f.secret,
    tableAllowlist: f.tableAllowlist
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export function DataSourcesPage() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setState({ status: "ready", sources: await listDataSources() });
    } catch (e) {
      setState({ status: "failed", message: e instanceof Error ? e.message : "Failed to load" });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const set = (key: keyof typeof EMPTY_FORM) => (event: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: event.target.value }));

  async function run<T>(id: string, action: () => Promise<T>, done: (r: T) => string): Promise<void> {
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      setNotice(done(await action()));
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    await run(
      "create",
      () => createDataSource(inputFor(form.kind, form)),
      () => {
        setForm(EMPTY_FORM);
        return t("settings.dataSources.created");
      },
    );
  }

  const field = (
    key: keyof typeof EMPTY_FORM,
    labelKey: string,
    opts: { type?: string; placeholder?: string } = {},
  ) => (
    <label className="flex flex-col gap-1 text-xs text-[var(--muted)]" key={key}>
      {t(labelKey)}
      <input
        className="rounded border border-[var(--line)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)]"
        type={opts.type ?? "text"}
        value={form[key]}
        placeholder={opts.placeholder}
        onChange={set(key)}
      />
    </label>
  );

  return (
    <div
      className="mx-auto flex w-full max-w-[var(--content-wide)] flex-col gap-6 px-6 py-6"
      data-testid="data-sources-page"
    >
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-[var(--text)]">{t("settings.dataSources.title")}</h2>
        <p className="text-xs text-[var(--muted)]">{t("settings.dataSources.hint")}</p>
        {state.status === "loading" && (
          <p className="text-xs text-[var(--muted)]">{t("settings.dataSources.loading")}</p>
        )}
        {state.status === "failed" && <p className="text-xs text-[var(--danger)]">{state.message}</p>}
        {state.status === "ready" && state.sources.length === 0 && (
          <p className="text-xs text-[var(--muted)]">{t("settings.dataSources.empty")}</p>
        )}
        {state.status === "ready" &&
          state.sources.map((source) => (
            <div
              key={source.id}
              className="flex items-center justify-between gap-3 rounded border border-[var(--line)] p-3"
            >
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-[var(--text)]">
                  {source.name} <span className="text-xs text-[var(--muted)]">({source.kind})</span>
                </span>
                <span className="text-xs text-[var(--muted)]">
                  {source.status}
                  {source.secretLast4 ? ` · ····${source.secretLast4}` : ""}
                  {source.lastSyncResult ? ` · ${source.lastSyncResult}` : ""}
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded border border-[var(--line)] px-2 py-1 text-xs"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(
                      source.id,
                      () => testDataSource(source.id),
                      () => t("settings.dataSources.testOk"),
                    )
                  }
                >
                  {t("settings.dataSources.test")}
                </button>
                {source.kind === "s3" && source.status === "active" && (
                  <button
                    type="button"
                    className="rounded border border-[var(--line)] px-2 py-1 text-xs"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(
                        source.id,
                        () => syncDataSource(source.id),
                        (r) =>
                          t("settings.dataSources.synced", { ok: String(r.filesOk), failed: String(r.filesFailed) }),
                      )
                    }
                  >
                    {t("settings.dataSources.sync")}
                  </button>
                )}
                {source.status === "active" && (
                  <button
                    type="button"
                    className="rounded border border-[var(--line)] px-2 py-1 text-xs"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(
                        source.id,
                        () => disableDataSource(source.id),
                        () => t("settings.dataSources.disabled"),
                      )
                    }
                  >
                    {t("settings.dataSources.disable")}
                  </button>
                )}
                {source.hasCredentials && (
                  <button
                    type="button"
                    className="rounded border border-[var(--line)] px-2 py-1 text-xs text-[var(--danger)]"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(
                        source.id,
                        () => deleteDataSourceCredentials(source.id),
                        () => t("settings.dataSources.credsRemoved"),
                      )
                    }
                  >
                    {t("settings.dataSources.removeCreds")}
                  </button>
                )}
              </div>
            </div>
          ))}
        {notice && <p className="text-xs text-[var(--success)]">{notice}</p>}
        {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
      </section>

      <form className="flex flex-col gap-3 rounded border border-[var(--line)] p-4" onSubmit={onCreate}>
        <h3 className="text-sm font-semibold text-[var(--text)]">{t("settings.dataSources.add")}</h3>
        <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
          {t("settings.dataSources.kind")}
          <select
            className="rounded border border-[var(--line)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)]"
            value={form.kind}
            onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as Kind }))}
          >
            <option value="s3">S3</option>
            <option value="postgres">PostgreSQL</option>
            <option value="mysql" disabled>
              MySQL — {t("settings.dataSources.pendingDriver")}
            </option>
            <option value="azure_blob" disabled>
              Azure Blob — {t("settings.dataSources.pendingW3")}
            </option>
          </select>
        </label>
        {field("name", "settings.dataSources.name")}
        {form.kind === "s3" && (
          <>
            {field("endpoint", "settings.dataSources.endpoint", { placeholder: "https://s3.example.com" })}
            {field("region", "settings.dataSources.region", { placeholder: "us-east-1" })}
            {field("bucket", "settings.dataSources.bucket")}
            {field("prefix", "settings.dataSources.prefix")}
            {field("s3AccessKeyId", "settings.dataSources.accessKeyId")}
            {field("s3SecretAccessKey", "settings.dataSources.secretAccessKey", { type: "password" })}
          </>
        )}
        {form.kind === "postgres" && (
          <>
            {field("host", "settings.dataSources.host")}
            {field("port", "settings.dataSources.port")}
            {field("database", "settings.dataSources.database")}
            {field("user", "settings.dataSources.user")}
            {field("secret", "settings.dataSources.password", { type: "password" })}
            {field("tableAllowlist", "settings.dataSources.tableAllowlist", { placeholder: "orders, customers" })}
          </>
        )}
        <button
          type="submit"
          className="self-start rounded bg-[var(--accent)] px-3 py-1.5 text-sm text-[var(--accent-contrast)]"
          disabled={busy !== null}
        >
          {t("settings.dataSources.save")}
        </button>
      </form>
    </div>
  );
}
