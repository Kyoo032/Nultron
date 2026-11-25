#!/usr/bin/env sh
# Restore the portal's database from an encrypted dump written by backup.sh.
#
#   sh webapp-deploy/scripts/restore-portal.sh <dump.enc> --scratch     # the DRILL: into a throwaway database
#   sh webapp-deploy/scripts/restore-portal.sh <dump.enc> [--yes]       # DESTRUCTIVE: replaces the live database
#
# <dump.enc> is nultron-portal-<stamp>.dump.enc (pg_dump -Fc, then encrypted). Since SR-171 that is
# chunked AES-256-GCM from aead-crypt.mjs (magic NAEAD001); before it, openssl enc -aes-256-cbc
# -pbkdf2 (magic Salted__). The cipher is told by the file's first 8 bytes, never by its name.
# BACKUP_KEY must be exported, or set in .env: the same passphrase backup.sh used.
#
# The dump is decrypted and authenticated INTO A TEMPORARY FILE first, and only a fully verified
# plaintext is ever fed to pg_restore: a tampered or truncated dump fails before the live database
# is dropped, never halfway through replacing it.
#
# --scratch is the monthly restore drill's portal half. It creates `restore_drill` beside the live database,
# restores into it, prints the row counts of both, and drops it again. Nothing the portal serves is touched.
# It does not prove the live database could be replaced; the destructive form does, on a scratch CVM.
#
# The destructive form stops the portal, drops and recreates tokotoken_portal, restores as the schema owner
# (so owners and the grants that row-level security depends on come back as they were; SR-56), and starts the
# portal again through its prepare step, which re-applies the migrations and sets portal_app_login's password.
# Roles live in the cluster, not the database, and are not touched. If the Postgres VOLUME was lost, start
# the stack first so initdb and portal-prepare create the roles, then restore.
set -eu
SCRIPT_DIR="$(dirname "$0")"
. "$SCRIPT_DIR/_common.sh"

DUMP="${1:-}"
MODE="${2:-}"
if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
	echo "usage: sh restore-portal.sh <nultron-portal-*.dump.enc> [--scratch | --yes]" >&2
	exit 2
fi

FORMAT="$(backup_format "$DUMP")"
if [ "$FORMAT" = "plain" ]; then
	echo "error: $DUMP has no encryption header backup.sh writes (NAEAD001 or Salted__)." >&2
	echo "       backup.sh never writes an unencrypted portal dump, so this file is not one." >&2
	exit 1
fi

BACKUP_KEY="$(setting BACKUP_KEY)"
if [ -z "$BACKUP_KEY" ]; then
	echo "error: BACKUP_KEY is empty. Fetch it from Secrets Manager and export it, then run again." >&2
	exit 1
fi
export BACKUP_KEY

case "$FORMAT" in
gcm)
	command -v node >/dev/null 2>&1 || {
		echo "error: node is not installed on this host" >&2
		exit 1
	}
	[ -f "$SCRIPT_DIR/aead-crypt.mjs" ] || {
		echo "error: missing $SCRIPT_DIR/aead-crypt.mjs" >&2
		exit 1
	}
	;;
cbc)
	command -v openssl >/dev/null 2>&1 || {
		echo "error: openssl is not installed on this host" >&2
		exit 1
	}
	;;
esac

[ -n "$(dc ps -q portal-db)" ] || {
	echo "error: the portal-db container is not running. Start it: docker compose up -d portal-db" >&2
	exit 1
}

echo "==> decrypting ($FORMAT) into a temporary file; the live database is untouched until it verifies"
TMP_PLAIN="$(mktemp "${TMPDIR:-/tmp}/nultron-portal-restore.XXXXXX")"
trap 'rm -f "$TMP_PLAIN"' EXIT
if ! backup_decrypt "$DUMP" "$TMP_PLAIN" "$FORMAT" "$SCRIPT_DIR/aead-crypt.mjs"; then
	echo "error: could not decrypt $DUMP - wrong BACKUP_KEY, or a truncated or tampered file" >&2
	exit 1
fi

psql_owner() {
	dc exec -T portal-db psql -U portal -v ON_ERROR_STOP=1 "$@"
}

# One line per table: name and exact row count, for the public schema of the database named in $1.
counts() {
	psql_owner -d "$1" -At -F ' ' -c "
SELECT table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1"
}

echo "==> checking the dump opens before anything is touched"
dc exec -T portal-db pg_restore --list <"$TMP_PLAIN" >/dev/null || {
	echo "error: could not read the decrypted $DUMP as a pg_dump archive - wrong BACKUP_KEY, or a truncated file" >&2
	exit 1
}

if [ "$MODE" = "--scratch" ]; then
	echo "==> restoring into a scratch database (restore_drill); the live database is not touched"
	psql_owner -d postgres -c "DROP DATABASE IF EXISTS restore_drill WITH (FORCE)" >/dev/null
	psql_owner -d postgres -c "CREATE DATABASE restore_drill TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'" >/dev/null
	dc exec -T portal-db pg_restore -U portal -d restore_drill --exit-on-error <"$TMP_PLAIN"
	RESTORED="$(counts restore_drill)"
	LIVE="$(counts tokotoken_portal)"
	psql_owner -d postgres -c "DROP DATABASE restore_drill WITH (FORCE)" >/dev/null
	echo "==> rows per table, restored copy | live database now (the live one may have moved on since the dump)"
	printf '%s\n' "$RESTORED" | while read -r table rows; do
		now="$(printf '%s\n' "$LIVE" | awk -v t="$table" '$1 == t { print $2 }')"
		printf '    %-28s %8s | %s\n' "$table" "$rows" "${now:-missing}"
	done
	TENANTS="$(printf '%s\n' "$RESTORED" | awk '$1 == "tenants" { print $2 }')"
	if [ "${TENANTS:-0}" -lt 1 ] 2>/dev/null; then
		echo "error: the restored copy has no tenant row - this dump is not a usable pilot backup" >&2
		exit 1
	fi
	echo "drill ok: the dump decrypts, restores cleanly and carries $TENANTS tenant row(s). Record it in webapp-deploy/DEPLOY-LOG.md."
	exit 0
fi

if [ "$MODE" != "--yes" ]; then
	echo "This REPLACES the live portal database (tokotoken_portal) with $DUMP."
	printf 'Type the word restore to continue: '
	read -r answer
	[ "$answer" = "restore" ] || {
		echo "aborted"
		exit 1
	}
fi

echo "==> stopping the portal"
dc stop portal
echo "==> dropping and recreating tokotoken_portal"
psql_owner -d postgres -c "DROP DATABASE IF EXISTS tokotoken_portal WITH (FORCE)" >/dev/null
psql_owner -d postgres -c "CREATE DATABASE tokotoken_portal TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'" >/dev/null
echo "==> restoring"
dc exec -T portal-db pg_restore -U portal -d tokotoken_portal --exit-on-error <"$TMP_PLAIN"
echo "==> starting the portal (its prepare step re-applies the migrations and the login role's password)"
dc up -d portal
echo "restored from $DUMP - check: sh webapp-deploy/scripts/logs.sh portal"
echo "record the drill in webapp-deploy/DEPLOY-LOG.md."
