#!/usr/bin/env sh
# Encrypted backup of the data volume, without stopping the app.
#
#   sh webapp-deploy/scripts/backup.sh [output-dir]
#
# Security spec S6: the tarball is encrypted BEFORE it leaves this host, so a COS
# bucket leak is not a data leak. The passphrase is BACKUP_KEY, which lives in Secrets
# Manager; export it first (deploy.sh does, or see the cron line in README.md).
#
# Steps:
#   1. A consistent SQLite snapshot into /data/.backup-staging/. The image has no
#      sqlite3 CLI, so the snapshot is `VACUUM INTO` through better-sqlite3, which is
#      WAL-safe: it reads a single committed transaction and writes a compacted copy
#      with no -wal/-shm of its own. If a future image adds the sqlite3 binary this
#      script uses `.backup` instead, which does the same thing.
#   2. tar of /data EXCLUDING components/ (re-downloadable, and baked into the image)
#      and logs/ (diagnostics, and spec L1 keeps them out of backups).
#   3. Authenticated AES-256-GCM encryption via aead-crypt.mjs with BACKUP_KEY from the environment.
#   4. The portal's Postgres (accounts, sessions): pg_dump -Fc, encrypted the same way, as a second
#      object beside the archive. Skipped when there is no portal-db container.
#   5. Upload each to the COS backup bucket with coscli, or tccli cos, or - if neither is
#      installed - leave it in the local dir and say so loudly.
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
OUT="$OUT_DIR/nultron-data-$STAMP.tar.gz.enc"

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

CID="$(app_container)"
if [ -z "$CID" ]; then
	echo "error: the app container is not running; start it or restore from an older backup" >&2
	exit 1
fi

# --- 1. consistent SQLite snapshot -----------------------------------------

echo "==> consistent SQLite snapshot"
dc exec -T app sh -s <<'INNER'
set -eu
root="${AGENTFORGE_DATA_DIR:-/data}"
src="$root/agentforge.sqlite"
stage="$root/.backup-staging"
rm -rf "$stage"
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
db.prepare("VACUUM INTO ?").run(path.join(root, ".backup-staging", "agentforge.sqlite"));
db.close();
console.log("snapshot ok (VACUUM INTO)");
'
fi
INNER

# --- 2 + 3. archive and encrypt --------------------------------------------

echo "==> archiving /data (minus components/ and logs/) and encrypting -> $OUT"
umask 077
dc exec -T app tar -czf - -C /data \
	--exclude=./components --exclude=./logs \
	--exclude=./.master-key . |
	node "$AEAD_CRYPT" encrypt --out "$OUT"

[ -s "$OUT" ] || {
	echo "error: the encrypted archive is empty" >&2
	rm -f "$OUT"
	exit 1
}

echo "==> clearing the staging copy inside the container"
dc exec -T app sh -c 'rm -rf "${AGENTFORGE_DATA_DIR:-/data}/.backup-staging"'

# --- verify -----------------------------------------------------------------
# A backup nobody can open is not a backup. Decrypt and list, into /dev/null. An archive with no entries
# fails too: if `tar` died inside the container the stream is empty, an empty stream encrypts, decrypts and
# lists without an error, and the size check above passes on the ~48 bytes of an empty ciphertext.

if [ "$(setting BACKUP_VERIFY 1)" = "1" ]; then
	echo "==> verifying (decrypt + list)"
	node "$AEAD_CRYPT" decrypt --in "$OUT" |
		tar -tzf - | grep -q . || {
		echo "error: the encrypted archive did not decrypt and untar cleanly" >&2
		exit 1
	}
fi

# --- 4. the portal's database ------------------------------------------------
# Accounts, sessions, devices and the audit log live in the portal's Postgres, a different volume from
# /data. Losing it signs every tester out and loses the seeded tenant, so it goes in the same hourly run.
# pg_dump in custom format (compressed, restorable table by table), encrypted with the same cipher and
# passphrase as the archive above, before it leaves this host. The dump is taken as the schema owner over
# the container's local socket, so no password is typed or exported here. Only when portal-db is running
# (a deployment on a managed Postgres backs that up where it lives); BACKUP_PORTAL=0 skips it.

PORTAL_OUT=""
if [ "$(setting BACKUP_PORTAL 1)" = "1" ] && [ -n "$(dc ps -q portal-db)" ]; then
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
fi

# --- 5. upload ---------------------------------------------------------------

cos_upload "$OUT"
[ -z "$PORTAL_OUT" ] || cos_upload "$PORTAL_OUT"

# --- local retention ---------------------------------------------------------

RETAIN="$(setting BACKUP_RETAIN_DAYS 7)"
if [ "$RETAIN" -gt 0 ] 2>/dev/null; then
	find "$OUT_DIR" -maxdepth 1 \( -name 'nultron-data-*.tar.gz.enc' -o -name 'nultron-portal-*.dump.enc' \) -mtime "+$RETAIN" -delete 2>/dev/null || true
fi

echo
ls -lh "$OUT"
[ -z "$PORTAL_OUT" ] || ls -lh "$PORTAL_OUT"
echo "sha: $(current_sha)"
echo "restore with: sh webapp-deploy/scripts/restore.sh $OUT"
[ -z "$PORTAL_OUT" ] || echo "portal database: sh webapp-deploy/scripts/restore-portal.sh $PORTAL_OUT"
