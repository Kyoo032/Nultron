#!/usr/bin/env sh
# Restore an encrypted backup into the data volume. DESTRUCTIVE: it replaces /data.
#
#   sh webapp-deploy/scripts/restore.sh <archive> [--yes]
#
# <archive> is a .tar.gz.enc written by backup.sh. Since SR-171 that is chunked AES-256-GCM from
# aead-crypt.mjs (magic NAEAD001); before it, openssl enc -aes-256-cbc -pbkdf2 (magic Salted__).
# A plain .tar.gz from before encryption landed restores too. The cipher is told by the file's
# first 8 bytes, never by its name. BACKUP_KEY must be exported, or set in .env, for either
# encrypted form; it is the same passphrase backup.sh used.
#
# An encrypted archive is decrypted and authenticated INTO A TEMPORARY FILE first, and only a
# fully verified plaintext is ever unpacked: a tampered or truncated backup fails before the
# volume is touched, never halfway through overwriting it. Then the app is stopped, the volume
# is emptied, the archive is unpacked, and the consistent snapshot from .backup-staging/ is
# promoted over agentforge.sqlite so the stale -wal/-shm from the live copy can never be replayed
# on top of it.
set -eu
SCRIPT_DIR="$(dirname "$0")"
. "$SCRIPT_DIR/_common.sh"

TARBALL="${1:-}"
CONFIRM="${2:-}"

if [ -z "$TARBALL" ] || [ ! -f "$TARBALL" ]; then
	echo "usage: sh restore.sh <archive.tar.gz.enc> [--yes]" >&2
	exit 2
fi

FORMAT="$(backup_format "$TARBALL")"
PLAIN="$TARBALL"

TARBALL_LOWER="$(printf '%s' "${TARBALL##*/}" | tr '[:upper:]' '[:lower:]')"
case "$TARBALL_LOWER" in
*.enc|*.enc.*)
	if [ "$FORMAT" = "plain" ]; then
		echo "error: $TARBALL is expected to be an encrypted backup (.enc) but has no encryption header." >&2
		exit 1
	fi
	;;
esac

if [ "$FORMAT" != "plain" ]; then
	BACKUP_KEY="$(setting BACKUP_KEY)"
	if [ -z "$BACKUP_KEY" ]; then
		echo "error: $TARBALL is encrypted but BACKUP_KEY is empty." >&2
		echo "       Fetch it from Secrets Manager and export it, then run again." >&2
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

	echo "==> decrypting ($FORMAT) into a temporary file; live data is untouched until it verifies"
	TMP_PLAIN="$(mktemp "${TMPDIR:-/tmp}/nultron-restore.XXXXXX")"
	trap 'rm -f "$TMP_PLAIN"' EXIT
	if ! backup_decrypt "$TARBALL" "$TMP_PLAIN" "$FORMAT" "$SCRIPT_DIR/aead-crypt.mjs"; then
		echo "error: could not decrypt $TARBALL - wrong BACKUP_KEY, or a truncated or tampered file" >&2
		exit 1
	fi
	PLAIN="$TMP_PLAIN"
fi

echo "==> checking the archive opens before anything is deleted"
tar -tzf "$PLAIN" >/dev/null || {
	echo "error: could not read $TARBALL as a tar archive - wrong BACKUP_KEY, or a truncated file" >&2
	exit 1
}

if [ "$CONFIRM" != "--yes" ]; then
	echo "This REPLACES everything in the nultron-data volume with $TARBALL."
	printf 'Type the word restore to continue: '
	read -r answer
	if [ "$answer" != "restore" ]; then
		echo "aborted"
		exit 1
	fi
fi

echo "==> stopping app and proxy"
dc stop proxy app

echo "==> emptying and unpacking /data"
# cap_drop: ALL in compose.yml takes CHOWN away even from root, and both tar -x and
# the chown below need it. Hand back exactly those three for this one-shot container.
cat "$PLAIN" | dc run --rm --no-deps -T --user root \
	--cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE \
	--entrypoint sh app -c '
set -e
rm -rf /data/..?* /data/.[!.]* /data/* 2>/dev/null || true
tar -xzf - -C /data
if [ -f /data/.backup-staging/agentforge.sqlite ]; then
  rm -f /data/agentforge.sqlite-wal /data/agentforge.sqlite-shm
  mv -f /data/.backup-staging/agentforge.sqlite /data/agentforge.sqlite
  echo "promoted the consistent snapshot"
fi
rm -rf /data/.backup-staging
chown -R node:node /data
'

echo "==> starting"
dc up -d

echo "restored from $TARBALL - check the health with: sh webapp-deploy/scripts/logs.sh"
echo "record the drill in webapp-deploy/DEPLOY-LOG.md (placement doc section 5)."
