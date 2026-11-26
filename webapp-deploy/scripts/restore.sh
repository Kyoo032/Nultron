#!/usr/bin/env sh
# Restore an encrypted backup into one desk's data volume. DESTRUCTIVE: it replaces /data.
#
#   sh webapp-deploy/scripts/restore.sh <archive> [--yes] [--desk <project>]
#
# <archive> is a .tar.gz.enc written by backup.sh, named nultron-data-<desk>-<stamp>.tar.gz.enc.
# --desk names the compose project to restore into (nultron-web, pusat01, a tester desk); without
# it the desk is read from the archive name, and when the name carries none the compose project
# this folder owns is used, as before.
#
# Since SR-171 that is chunked AES-256-GCM from
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

TARBALL=""
CONFIRM=""
DESK=""
while [ $# -gt 0 ]; do
	case "$1" in
	--yes) CONFIRM="--yes" ;;
	--desk)
		shift
		DESK="${1:-}"
		;;
	--desk=*) DESK="${1#--desk=}" ;;
	-*) ;; # ignore unknown flags
	*) [ -z "$TARBALL" ] && TARBALL="$1" ;;
	esac
	shift
done

if [ -z "$TARBALL" ] || [ ! -f "$TARBALL" ]; then
	echo "usage: sh restore.sh <archive.tar.gz.enc> [--yes] [--desk <project>]" >&2
	exit 2
fi

# The desk id travels in the archive name (nultron-data-<desk>-<stamp>.tar.gz.enc); an explicit
# --desk wins. A name with no desk id falls back to this folder's compose project, the old
# single-desk behaviour.
# The desk the run is pinned to - COMPOSE_PROJECT_NAME, or `-p <name>`/`--project-name` in
# DC_ARGS the way the local rehearsal (pilot-local.mjs) sets it. When set, a restore may only
# target that desk: an archive's embedded desk id or its name never widens the scope.
PINNED_PROJECT="${COMPOSE_PROJECT_NAME:-}"
_prev=""
# shellcheck disable=SC2086
for _arg in ${DC_ARGS:-}; do
	case "$_prev" in -p | --project-name) PINNED_PROJECT="$_arg" ;; esac
	case "$_arg" in --project-name=*) PINNED_PROJECT="${_arg#--project-name=}" ;; esac
	_prev="$_arg"
done

if [ -z "$DESK" ]; then
	case "${TARBALL##*/}" in
	nultron-data-*-*.tar.gz.enc)
		_base="${TARBALL##*/}"
		_base="${_base#nultron-data-}"
		# strip the trailing -<yyyymmdd>T<hhmmss>Z stamp
		_desk_guess="$(printf '%s' "$_base" | sed -n 's/^\(.*\)-[0-9]\{8\}T[0-9]\{6\}Z\.tar\.gz\.enc$/\1/p')"
		[ -n "$_desk_guess" ] && DESK="$_desk_guess"
		;;
	esac
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

# The desk id inside the archive beats the one in its name: backup.sh writes backup-meta.json
# into /data before tarring, so a bucket-level rename (a valid archive of desk A re-offered as
# desk B's) is caught here instead of overwriting the wrong desk. Old archives carry no meta
# and keep the name-based behaviour.
META_MEMBER="$(tar -tzf "$PLAIN" 2>/dev/null | grep -m1 'backup-meta.json' || true)"
META_DESK=""
if [ -n "$META_MEMBER" ]; then
	META_DESK="$(tar -xzf "$PLAIN" -O "$META_MEMBER" 2>/dev/null |
		sed -n 's/.*"desk"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
fi
if [ -n "$META_DESK" ]; then
	if [ -z "$DESK" ]; then
		DESK="$META_DESK"
	elif [ "$META_DESK" != "$DESK" ]; then
		echo "error: this archive belongs to desk '$META_DESK', not '$DESK' - refusing to restore" >&2
		echo "       the wrong desk's data over it. If that is really what you mean, unpack by hand." >&2
		exit 1
	fi
fi

if [ -n "$PINNED_PROJECT" ] && [ -n "$DESK" ] && [ "$DESK" != "$PINNED_PROJECT" ]; then
	echo "error: this run is pinned to desk '$PINNED_PROJECT' (COMPOSE_PROJECT_NAME/-p)," >&2
	echo "       and the archive resolves to '$DESK' - refusing to restore outside the pin." >&2
	exit 1
fi

if [ "$CONFIRM" != "--yes" ]; then
	if [ -n "$DESK" ]; then
		echo "This REPLACES everything in the $DESK desk's data volume with $TARBALL."
	else
		echo "This REPLACES everything in the nultron-data volume with $TARBALL."
	fi
	printf 'Type the word restore to continue: '
	read -r answer
	if [ "$answer" != "restore" ]; then
		echo "aborted"
		exit 1
	fi
fi

if [ -n "$DESK" ]; then
	# A named desk can live in any compose project, so drive it by docker label rather than
	# this folder's compose file. Stop every container in the project (the proxy shares the
	# app's network namespace and dies with it anyway), unpack over the app's /data mount in
	# a throwaway container on the desk's own image, and bring the project back.
	# ps -aq, not -q: a desk that is down is exactly the desk whose restore is being run
	# (scratch-recovery drills stop it first), and --volumes-from mounts a stopped container's
	# volumes the same as a running one's.
	APP_CID="$(docker ps -aq --filter "label=com.docker.compose.project=$DESK" \
		--filter "label=com.docker.compose.service=app" | head -n 1)"
	[ -n "$APP_CID" ] || {
		echo "error: no app container in compose project '$DESK' (running or stopped)" >&2
		exit 1
	}
	APP_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$APP_CID")"
	PROJECT_CIDS="$(docker ps -aq --filter "label=com.docker.compose.project=$DESK")"

	echo "==> stopping the '$DESK' desk"
	# shellcheck disable=SC2086
	docker stop $PROJECT_CIDS >/dev/null 2>&1 || true
	# Refuse to wipe a live volume: if the stop failed (or half-failed), the app keeps
	# writing to its SQLite file while restore replaces it underneath.
	if [ -n "$(docker ps -q --filter "label=com.docker.compose.project=$DESK")" ]; then
		echo "error: the '$DESK' desk is still running after docker stop - refusing" >&2
		echo "       to overwrite a live volume. Stop it by hand and run again." >&2
		exit 1
	fi

	echo "==> emptying and unpacking $DESK's /data"
	# cap_drop: ALL takes CHOWN away even from root, and both tar -x and the chown below
	# need it. Hand back exactly those three for this one-shot container.
	cat "$PLAIN" | docker run --rm --volumes-from "$APP_CID" -i \
		--user root --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE \
		--entrypoint sh "$APP_IMAGE" -c '
set -e
rm -rf /data/..?* /data/.[!.]* /data/* 2>/dev/null || true
tar -xzf - -C /data
# backup.sh stages under a per-run name (.backup-staging-<stamp>-<pid>) so overlapping
# runs cannot delete the snapshot another run staged; promote whichever member this archive carries.
for _snap in /data/.backup-staging*/agentforge.sqlite; do
  if [ -f "$_snap" ]; then
    rm -f /data/agentforge.sqlite-wal /data/agentforge.sqlite-shm
    mv -f "$_snap" /data/agentforge.sqlite
    echo "promoted the consistent snapshot"
  fi
done
rm -rf /data/.backup-staging*
chown -R node:node /data
'

	echo "==> starting the '$DESK' desk"
	# The app first: a proxy with network_mode "service:app" cannot start before it.
	docker start "$APP_CID" >/dev/null
	for _cid in $PROJECT_CIDS; do
		[ "$_cid" = "$APP_CID" ] || docker start "$_cid" >/dev/null
	done

	echo "restored desk '$DESK' from $TARBALL - check the health with: sh webapp-deploy/scripts/logs.sh"
	echo "record the drill in webapp-deploy/DEPLOY-LOG.md (placement doc section 5)."
	exit 0
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
# backup.sh stages under a per-run name (.backup-staging-<stamp>-<pid>) so overlapping
# runs cannot delete the snapshot another run staged; promote whichever member this archive carries.
for _snap in /data/.backup-staging*/agentforge.sqlite; do
  if [ -f "$_snap" ]; then
    rm -f /data/agentforge.sqlite-wal /data/agentforge.sqlite-shm
    mv -f "$_snap" /data/agentforge.sqlite
    echo "promoted the consistent snapshot"
  fi
done
rm -rf /data/.backup-staging*
chown -R node:node /data
'

echo "==> starting"
dc up -d

echo "restored from $TARBALL - check the health with: sh webapp-deploy/scripts/logs.sh"
echo "record the drill in webapp-deploy/DEPLOY-LOG.md (placement doc section 5)."
