#!/usr/bin/env sh
# Encrypted backup of every desk's data volume, without stopping the apps.
#
#   sh webapp-deploy/scripts/backup.sh [output-dir]
#
# A "desk" is a running compose service labelled com.docker.compose.service=app; its desk id is
# the compose project it belongs to (nultron-web, a tester desk, pusat01...). Each desk gets one
# archive, named nultron-data-<desk>-<stamp>.tar.gz.enc, and each desk's data volume gets a
# backup-status.json heartbeat the app surfaces as "last backup" (spec R12.9). Desks are found
# by docker label, not by this folder's compose file, because desks live in other compose
# projects on the same host. BACKUP_DESK_GLOB narrows which projects count (default '*').
#
# Security spec S6: the tarball is encrypted BEFORE it leaves this host, so a COS
# bucket leak is not a data leak. The passphrase is BACKUP_KEY, which lives in Secrets
# Manager; export it first (deploy.sh does, or see the cron line in README.md).
# The desk wrap key (AGENTFORGE_SECRETS_KEY) is never in the archive: it is an env var,
# not a file, and .master-key is excluded from the tar either way.
#
# Steps, per desk:
#   1. A consistent SQLite snapshot into /data/.backup-staging/. The image has no
#      sqlite3 CLI, so the snapshot is `VACUUM INTO` through better-sqlite3, which is
#      WAL-safe: it reads a single committed transaction and writes a compacted copy
#      with no -wal/-shm of its own. If a future image adds the sqlite3 binary this
#      script uses `.backup` instead, which does the same thing.
#   2. tar of /data EXCLUDING components/ (re-downloadable, and baked into the image)
#      and logs/ (diagnostics, and spec L1 keeps them out of backups).
#   3. Authenticated AES-256-GCM encryption via aead-crypt.mjs with BACKUP_KEY from the environment.
#   4. The portal's Postgres (accounts, sessions): pg_dump -Fc, encrypted the same way, as a second
#      object beside the archives. Skipped when there is no portal-db container.
#   5. Upload each to the COS backup bucket with coscli, or tccli cos. A skipped upload is a
#      failed backup: the desk's heartbeat records failure and the script exits non-zero
#      (BACKUP_REQUIRE_OFFSITE=1, the default; 0 is for local tests only).
#
# The job runs on the host, outside the 768 MiB desk containers (spec S8), so a desk's RAM
# ceiling is untouched while its backup runs.
set -eu
SCRIPT_DIR="$(dirname "$0")"
. "$SCRIPT_DIR/_common.sh"
. "$SCRIPT_DIR/_heartbeat.sh"
AEAD_CRYPT="$SCRIPT_DIR/aead-crypt.mjs"

HEARTBEAT_URL="${BACKUP_HEARTBEAT_URL:-}"
trap '_rc=$?; trap - EXIT; heartbeat_ping "$HEARTBEAT_URL" "$_rc"; exit "$_rc"' EXIT

OUT_DIR="${1:-$DEPLOY_DIR/backups}"
mkdir -p "$OUT_DIR"
STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
# The staging dir is unique to this run: a second backup overlapping this one must never
# delete the snapshot the first is about to archive, and restore promotes whichever
# .backup-staging* member it finds.
SNAP_DIR=".backup-staging-$STAMP-$$"

BACKUP_KEY="$(setting BACKUP_KEY)"
if [ -z "$BACKUP_KEY" ]; then
	echo "error: BACKUP_KEY is empty. An unencrypted backup is a spec S6 violation." >&2
	echo "       export it from Secrets Manager, or set it in .env for a local run." >&2
	exit 1
fi
export BACKUP_KEY

command -v node >/dev/null 2>&1 || {
	echo "error: node is not installed on this host" >&2
	exit 1
}
[ -f "$AEAD_CRYPT" ] || {
	echo "error: missing $AEAD_CRYPT" >&2
	exit 1
}

DESK_GLOB="$(setting BACKUP_DESK_GLOB '*')"
REQUIRE_OFFSITE="$(setting BACKUP_REQUIRE_OFFSITE 1)"

# When the run is pinned to one compose project — COMPOSE_PROJECT_NAME, or `-p <name>` in
# DC_ARGS the way the local rehearsal (pilot-local.mjs) sets it — that project is the only
# desk. Without this the label scan below would archive every production desk a rehearsal
# shares a docker daemon with.
PINNED_PROJECT="${COMPOSE_PROJECT_NAME:-}"
_prev=""
# shellcheck disable=SC2086
for _arg in ${DC_ARGS:-}; do
	case "$_prev" in -p | --project-name) PINNED_PROJECT="$_arg" ;; esac
	case "$_arg" in --project-name=*) PINNED_PROJECT="${_arg#--project-name=}" ;; esac
	_prev="$_arg"
done

# The compose projects that own a running `app` service, filtered by BACKUP_DESK_GLOB.
# One line per desk id (= project name).
desk_projects() {
	if [ -n "$PINNED_PROJECT" ]; then
		# shellcheck disable=SC2254
		case "$PINNED_PROJECT" in $DESK_GLOB) printf '%s\n' "$PINNED_PROJECT" ;; esac
		return
	fi
	docker ps --filter label=com.docker.compose.service=app \
		--format '{{.Label "com.docker.compose.project"}}' 2>/dev/null | sort -u |
		while IFS= read -r _p; do
			[ -n "$_p" ] || continue
			# shellcheck disable=SC2254
			case "$_p" in $DESK_GLOB) printf '%s\n' "$_p" ;; esac
		done
}

# Which desk an archive belongs to travels INSIDE it, never only in its name: a COS writer
# could otherwise rename one desk's valid archive over another's and have it restored into
# the wrong desk. restore.sh refuses a meta/desk mismatch.
write_desk_meta() {
	_cid="$1"
	_desk="$2"
	docker exec "$_cid" sh -c '
		printf "{\"desk\":\"%s\",\"createdAt\":\"%s\"}\n" "$1" "$2" \
			> "${AGENTFORGE_DATA_DIR:-/data}/backup-meta.json"
	' sh "$_desk" "$STAMP"
}

desk_container() {
	docker ps -q --filter "label=com.docker.compose.project=$1" \
		--filter "label=com.docker.compose.service=app" | head -n 1
}

# The heartbeat the app reads back as "last backup: ok / pending". Timestamp and result
# only: no paths, no sizes, nothing the desk's own owner could not already see.
write_desk_status() {
	_cid="$1"
	_result="$2"
	_ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
	docker exec "$_cid" sh -c '
		printf "{\"result\":\"%s\",\"finishedAt\":\"%s\"}\n" "$1" "$2" \
			> "${AGENTFORGE_DATA_DIR:-/data}/backup-status.json"
	' sh "$_result" "$_ts"
}

fail_desk() {
	_desk="$1"
	_cid="$2"
	_reason="$3"
	echo "error[$_desk]: $_reason" >&2
	[ -z "$_cid" ] || write_desk_status "$_cid" "failed" 2>/dev/null || true
	return 1
}

# --- one desk ---------------------------------------------------------------

# A failed backup must never leave its staged agentforge.sqlite copy on the live volume:
# it would ride into the next run's archive as a stray member and leak database copies.
# _clean_stage drops only THIS run's dir; an overlapping run's stage belongs to its archive.
_clean_stage() {
	docker exec "$1" sh -c 'rm -rf "${AGENTFORGE_DATA_DIR:-/data}/'"$SNAP_DIR"'"' 2>/dev/null || true
}

backup_desk() {
	_desk="$1"
	_cid="$(desk_container "$_desk")"
	_out="$OUT_DIR/nultron-data-$_desk-$STAMP.tar.gz.enc"

	if [ -z "$_cid" ]; then
		echo "error[$_desk]: the app container is not running; restore it or pick a different BACKUP_DESK_GLOB" >&2
		return 1
	fi
	write_desk_status "$_cid" "pending" 2>/dev/null || true

	echo "==> [$_desk] consistent SQLite snapshot"
	if ! docker exec -i -e SNAP_DIR="$SNAP_DIR" "$_cid" sh -s <<'INNER'
set -eu
root="${AGENTFORGE_DATA_DIR:-/data}"
src="$root/agentforge.sqlite"
stage="$root/$SNAP_DIR"
mkdir -p "$stage"
if [ ! -f "$src" ]; then
	echo "no agentforge.sqlite yet - archiving the data dir only"
	exit 0
fi
if command -v sqlite3 >/dev/null 2>&1; then
	sqlite3 "$src" ".backup '$stage/agentforge.sqlite'"
	echo "snapshot ok (sqlite3 .backup)"
else
	node -e '
const path = require("node:path");
const Database = require("better-sqlite3");
const root = process.env.AGENTFORGE_DATA_DIR || "/data";
// Not { readonly: true }: some SQLite builds refuse VACUUM INTO on a read-only
// connection. WAL mode lets this second connection read while the app writes.
const db = new Database(path.join(root, "agentforge.sqlite"));
db.pragma("busy_timeout = 30000");
db.prepare("VACUUM INTO ?").run(path.join(root, process.env.SNAP_DIR, "agentforge.sqlite"));
db.close();
console.log("snapshot ok (VACUUM INTO)");
'
fi
INNER
	then
		fail_desk "$_desk" "$_cid" "the SQLite snapshot step failed"; _clean_stage "$_cid"; return 1
	fi

	# Whether this desk staged a snapshot decides what the archive must contain below.
	if docker exec "$_cid" sh -c 'test -f "${AGENTFORGE_DATA_DIR:-/data}/'"$SNAP_DIR"'/agentforge.sqlite"'; then
		_has_snap=1
	else
		_has_snap=""
	fi

	# Embed the desk's identity in the archive before tarring it up.
	write_desk_meta "$_cid" "$_desk" 2>/dev/null || true

	echo "==> [$_desk] archiving /data (minus components/ and logs/) and encrypting -> $_out"
	umask 077
	# sh has no pipefail, so a `tar` that dies mid-stream would still feed a truncated archive
	# into the encryptor and report success. tar's real exit code is written to stderr (which
	# docker exec forwards untouched) as a marker this side greps for.
	_tarlog="$(mktemp "${TMPDIR:-/tmp}/nultron-backup-tar.XXXXXX")"
	# The live agentforge.sqlite and its -wal/-shm are excluded, the same way the k8s
	# archiver does it: the consistent copy in .backup-staging/ replaces them on restore,
	# and a half-read WAL beside a snapshot is exactly what restore discards anyway.
	# With them excluded, every remaining tar exit 1 means a non-database file changed
	# mid-read (a truncated deck, a rewritten settings file) - damaged input, not WAL
	# churn - so the strict check below accepts only exit 0.
	if ! docker exec "$_cid" sh -c '
		tar -czf - -C "${AGENTFORGE_DATA_DIR:-/data}" \
			--exclude=./components --exclude=./logs \
			--exclude=./.master-key \
			--exclude=./agentforge.sqlite --exclude=./agentforge.sqlite-wal \
			--exclude=./agentforge.sqlite-shm .
		echo "tar_exit=$?" >&2
	' 2>"$_tarlog" | node "$AEAD_CRYPT" encrypt --out "$_out" ||
		! grep -q 'tar_exit=0' "$_tarlog"; then
		rm -f "$_out" "$_tarlog"
		fail_desk "$_desk" "$_cid" "the archive or encryption step failed"; _clean_stage "$_cid"; return 1
	fi
	rm -f "$_tarlog"

	if [ ! -s "$_out" ]; then
		rm -f "$_out"
		fail_desk "$_desk" "$_cid" "the encrypted archive is empty"; _clean_stage "$_cid"; return 1
	fi

	# Remove only this run's staging dir; an overlapping run's stage belongs to its archive.
	_clean_stage "$_cid"

	# A backup nobody can open is not a backup, and one without the embedded desk meta is not
	# restorable under its name either: an archive truncated at the front would still decrypt
	# and list a few entries. When the desk staged a snapshot the archive must carry it too -
	# a restored desk without it would replay a stale WAL over nothing.
	if [ "$(setting BACKUP_VERIFY 1)" = "1" ]; then
		echo "==> [$_desk] verifying (decrypt + list)"
		_listing="$(node "$AEAD_CRYPT" decrypt --in "$_out" | tar -tzf - || true)"
		_ok=1
		case "$_listing" in *backup-meta.json*) : ;; *) _ok="" ;; esac
		if [ -n "$_has_snap" ]; then
			case "$_listing" in *backup-staging*/agentforge.sqlite*) : ;; *) _ok="" ;; esac
		fi
		if [ -z "$_ok" ]; then
			fail_desk "$_desk" "$_cid" "the encrypted archive did not decrypt and untar cleanly with its meta and snapshot"; return
		fi
	fi

	if ! cos_upload "$_out"; then
		if [ "$REQUIRE_OFFSITE" = "1" ]; then
			fail_desk "$_desk" "$_cid" "the offsite upload was skipped; BACKUP_REQUIRE_OFFSITE=1 counts that as a failed backup"; return
		fi
		echo "warning[$_desk]: offsite upload skipped but BACKUP_REQUIRE_OFFSITE=0 (local test mode)" >&2
	fi

	write_desk_status "$_cid" "ok" 2>/dev/null || true
	echo "==> [$_desk] ok: $_out"
	return 0
}

# --- the desk loop ------------------------------------------------------------

DESKS="$(desk_projects)"
if [ -z "$DESKS" ]; then
	# No labelled containers: fall back to the one compose project this folder owns, so a
	# first deploy before any desk is up still exercises the pipeline loudly rather than
	# reporting a green run over nothing.
	if [ -n "$(app_container)" ]; then
		_project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$(app_container)" 2>/dev/null || true)"
		case "${_project:-nultron-web}" in
		# shellcheck disable=SC2254
		$DESK_GLOB) DESKS="${_project:-nultron-web}" ;;
		esac
	fi
fi

if [ -z "$DESKS" ]; then
	echo "error: no desks found (no running container labelled com.docker.compose.service=app matching BACKUP_DESK_GLOB='$DESK_GLOB')" >&2
	exit 1
fi

FAILED=""
for _desk in $DESKS; do
	backup_desk "$_desk" || FAILED="$FAILED $_desk"
done

# --- the portal's database (one shared service, archived once) -------------------
# Accounts, sessions, devices and the audit log live in the portal's Postgres, a different volume from
# /data. Losing it signs every tester out and loses the seeded tenant, so it goes in the same hourly run.
# pg_dump in custom format (compressed, restorable table by table), encrypted with the same cipher and
# passphrase as the archives above, before it leaves this host. The dump is taken as the schema owner over
# the container's local socket, so no password is typed or exported here. Only when portal-db is running
# (a deployment on a managed Postgres backs that up where it lives); BACKUP_PORTAL=0 skips it.

PORTAL_OUT=""
if [ "$(setting BACKUP_PORTAL 1)" = "1" ] && [ -n "$(dc ps -q portal-db 2>/dev/null || true)" ]; then
	PORTAL_OUT="$OUT_DIR/nultron-portal-$STAMP.dump.enc"
	echo "==> portal database (pg_dump -Fc) and encrypting -> $PORTAL_OUT"
	dc exec -T portal-db pg_dump -U portal -d tokotoken_portal -Fc |
		node "$AEAD_CRYPT" encrypt --out "$PORTAL_OUT"
	[ -s "$PORTAL_OUT" ] || {
		echo "error: the encrypted portal dump is empty" >&2
		rm -f "$PORTAL_OUT"
		exit 1
	}
	if [ "$(setting BACKUP_VERIFY 1)" = "1" ]; then
		echo "==> verifying the portal dump (decrypt + pg_restore --list)"
		node "$AEAD_CRYPT" decrypt --in "$PORTAL_OUT" |
			dc exec -T portal-db pg_restore --list >/dev/null || {
			echo "error: the encrypted portal dump did not decrypt and list cleanly" >&2
			exit 1
		}
	fi
	cos_upload "$PORTAL_OUT" || {
		[ "$REQUIRE_OFFSITE" = "1" ] && FAILED="$FAILED portal" || true
	}
fi

# --- local retention ---------------------------------------------------------

RETAIN="$(setting BACKUP_RETAIN_DAYS 7)"
if [ "$RETAIN" -gt 0 ] 2>/dev/null; then
	find "$OUT_DIR" -maxdepth 1 \( -name 'nultron-data-*.tar.gz.enc' -o -name 'nultron-portal-*.dump.enc' \) -mtime "+$RETAIN" -delete 2>/dev/null || true
fi

echo
ls -lh "$OUT_DIR"/nultron-data-*-"$STAMP".tar.gz.enc 2>/dev/null || true
[ -z "$PORTAL_OUT" ] || ls -lh "$PORTAL_OUT"
echo "sha: $(current_sha)"
echo "restore one desk with: sh webapp-deploy/scripts/restore.sh $OUT_DIR/nultron-data-<desk>-$STAMP.tar.gz.enc --desk <desk>"
[ -z "$PORTAL_OUT" ] || echo "portal database: sh webapp-deploy/scripts/restore-portal.sh $PORTAL_OUT"

if [ -n "$FAILED" ]; then
	echo "error: backup FAILED for:$FAILED" >&2
	exit 1
fi
