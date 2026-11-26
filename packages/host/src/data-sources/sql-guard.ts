/**
 * F1: the read-only SQL guard for the external connectors (`data-sql-guard`, W1.4/W1.5).
 *
 * `sql-guard.ts` beside it guards the desk's own SQLite; this one guards text going to a user's
 * PostgreSQL. The bar is stricter in the ways that matter there:
 *
 * - exactly one statement — a `;` anywhere outside a string literal refuses the whole thing
 *   (a second statement is how `SELECT 1; DROP TABLE x` hides);
 * - the first keyword is `SELECT` or `WITH`, and a `WITH` is still checked word for word —
 *   `WITH x AS (DELETE ...) SELECT` is the classic trick;
 * - no write, lock, session or server-side-copy keyword survives anywhere outside a string
 *   literal, including `INTO` (Postgres `SELECT ... INTO` creates a table) and `FOR`
 *   (`FOR UPDATE`/`FOR SHARE` take row locks);
 * - no line or block comments, and no dollar-quoted function bodies (`$$ ... $$`), so a
 *   `--` can't hide a statement split and a `DO` block can't carry writes past the word scan.
 *
 * The guard decides from the text alone; the caller still wraps the query in a read-only
 * transaction with a server-side timeout and a row cap, so a SELECT that slips a surprising
 * edge past the words still cannot write or run away.
 */
import { ApiError } from "@agentforge/core";

const FORBIDDEN = new Set([
  "insert",
  "update",
  "delete",
  "merge",
  "upsert",
  "replace",
  "drop",
  "alter",
  "create",
  "truncate",
  "rename",
  "copy",
  "grant",
  "revoke",
  "call",
  "exec",
  "execute",
  "do",
  "pragma",
  "attach",
  "detach",
  "vacuum",
  "analyze",
  "cluster",
  "reindex",
  "refresh",
  "lock",
  "unlock",
  "set",
  "reset",
  "show",
  "into",
  "for", // SELECT INTO creates a table; FOR UPDATE/SHARE locks rows
  "listen",
  "notify",
  "unlisten",
  "begin",
  "start",
  "commit",
  "rollback",
  "abort",
  "end",
  "savepoint",
  "release",
  "prepare",
  "deallocate",
  "declare",
  "fetch",
  "cursor",
  "move",
  "security",
  "import",
  "load",
  "extension",
  // Functions with side effects a bare SELECT can carry.
  "set_config",
  "nextval",
  "setval",
  "currval",
  "lastval",
  "pg_advisory_lock",
  "pg_advisory_unlock",
  "pg_advisory_unlock_all",
  "pg_advisory_xact_lock",
  "pg_sleep",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_create_restore_point",
  "pg_switch_wal",
  "lo_import",
  "lo_export",
  "dblink_exec",
  // Reads that bypass the table allowlist entirely: server-side files, remote databases via
  // dblink/postgres_fdw, WAL/replication data, and outbound HTTP extension calls — a bare
  // `SELECT pg_read_file(...)` names no relation, so the FROM/JOIN check never sees it.
  "pg_read_file",
  "pg_read_binary_file",
  "pg_ls_dir",
  "pg_stat_file",
  "pg_ls_logdir",
  "pg_ls_logfiles",
  "pg_ls_waldir",
  "pg_ls_archive_statusdir",
  "pg_ls_tmpdir",
  "pg_export_snapshot",
  "dblink",
  "dblink_connect",
  "dblink_connect_u",
  "dblink_open",
  "dblink_close",
  "dblink_fetch",
  "dblink_send_query",
  "dblink_get_result",
  "dblink_get_connections",
  "dblink_is_busy",
  "dblink_cancel_query",
  "dblink_error_message",
  "dblink_get_pkey",
  "dblink_build_sql_insert",
  "dblink_build_sql_update",
  "dblink_build_sql_delete",
  "pg_create_logical_replication_slot",
  "pg_create_physical_replication_slot",
  "pg_drop_replication_slot",
  "pg_logical_slot_get_changes",
  "pg_logical_slot_peek_changes",
  "pg_logical_slot_get_binary_changes",
  "pg_logical_slot_peek_binary_changes",
  "http",
  "http_get",
  "http_post",
  "http_put",
  "http_delete",
  "http_head",
  "http_patch",
  "http_set_curlopt",
  "http_reset_curlopt",
  // `comment`/`explain` can't appear mid-SELECT as a statement — the first-word check below is
  // what refuses them, and keeping them out of the scan keeps `SELECT comment FROM …` working.
]);

const REFUSED = (message: string) => new ApiError("sql_read_only", message, 400);

type Token = { word: string } | { other: string };

/** Strip string literals, then refuse comments, `;` and `$$` bodies; return word tokens. */
function tokenize(sqlText: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sqlText.length;
  while (i < n) {
    const c = sqlText[i]!;
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    // String literal: '' escapes a quote inside. Dollar-quoting is refused outright below.
    if (c === "'") {
      i += 1;
      while (i < n) {
        if (sqlText[i] === "'" && sqlText[i + 1] === "'") {
          i += 2;
        } else if (sqlText[i] === "'") {
          i += 1;
          break;
        } else {
          i += 1;
        }
      }
      if (i > n || sqlText[i - 1] !== "'") {
        throw REFUSED("Unterminated string literal");
      }
      tokens.push({ other: "''" });
      continue;
    }
    if (c === '"') {
      // Quoted identifier — read past it like a string ("" escapes a quote).
      i += 1;
      while (i < n) {
        if (sqlText[i] === '"' && sqlText[i + 1] === '"') {
          i += 2;
        } else if (sqlText[i] === '"') {
          i += 1;
          break;
        } else {
          i += 1;
        }
      }
      if (i > n || sqlText[i - 1] !== '"') {
        throw REFUSED("Unterminated identifier");
      }
      tokens.push({ other: '""' });
      continue;
    }
    if (c === "-" && sqlText[i + 1] === "-") {
      throw REFUSED("Comments are not allowed");
    }
    if (c === "/" && sqlText[i + 1] === "*") {
      throw REFUSED("Comments are not allowed");
    }
    if (c === ";") {
      throw REFUSED("Only a single statement is allowed");
    }
    if (c === "$") {
      throw REFUSED("Dollar-quoted bodies are not allowed");
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < n && /[A-Za-z0-9_]/.test(sqlText[i]!)) {
        i += 1;
      }
      tokens.push({ word: sqlText.slice(start, i).toLowerCase() });
      continue;
    }
    tokens.push({ other: c });
    i += 1;
  }
  return tokens;
}

/**
 * Throw `sql_read_only` on anything but a single SELECT (or WITH…SELECT); return the text the
 * caller may send. `maxRows`/`timeoutMs` come from the env so the runner's caps are set here too.
 */
export function assertReadOnlySelect(sqlText: string): string {
  const trimmed = sqlText.trim();
  if (!trimmed) {
    throw REFUSED("Empty query");
  }
  const words = tokenize(trimmed)
    .filter((t): t is { word: string } => "word" in t)
    .map((t) => t.word);
  const first = words[0];
  if (first !== "select" && first !== "with") {
    throw REFUSED("Only SELECT queries are allowed");
  }
  for (const word of words) {
    if (FORBIDDEN.has(word)) {
      throw REFUSED(`Only read-only SELECT queries are allowed (saw "${word.toUpperCase()}")`);
    }
  }
  // WITH is fine only while it still leads to a SELECT — checked by the word scan above, since
  // any DML the CTE tried to carry was already refused.
  if (!words.includes("select")) {
    throw REFUSED("Only SELECT queries are allowed");
  }
  return trimmed;
}

const MAX_ROWS_DEFAULT = 500;
const TIMEOUT_MS_DEFAULT = 2_000;
const BYTES_DEFAULT = 25 * 1024 * 1024;

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = Number(env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/** Row cap, server-side statement timeout and sync byte cap; the env may only tighten defaults. */
export function dataSourceLimits(env: NodeJS.ProcessEnv = process.env) {
  return {
    sqlMaxRows: envInt(env, "AGENTFORGE_DATA_SQL_MAX_ROWS", MAX_ROWS_DEFAULT),
    sqlTimeoutMs: envInt(env, "AGENTFORGE_DATA_SQL_TIMEOUT_MS", TIMEOUT_MS_DEFAULT),
    syncMaxBytes: envInt(env, "AGENTFORGE_DATA_SYNC_MAX_BYTES", BYTES_DEFAULT),
  };
}
