#!/bin/sh
# Step 2 of the backup CronJob: archive /data (plus the snapshot from step 1) and encrypt it BEFORE it
# is written anywhere, exactly as webapp-deploy/scripts/backup.sh does (security spec S6), so
# webapp-deploy/scripts/restore.sh can open what this writes:
#   tar -czf - | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_KEY
#
# Runs in an image that has tar and openssl (the app image has no openssl CLI). The data volume is
# mounted read-only here; the snapshot comes from the emptyDir /stage.
set -eu

OUT_DIR="${BACKUP_OUT_DIR:-/backups}"
STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
OUT="$OUT_DIR/nultron-data-$STAMP.tar.gz.enc"

if [ -z "${BACKUP_KEY:-}" ]; then
	echo "error: BACKUP_KEY is empty. An unencrypted backup is a spec S6 violation." >&2
	exit 1
fi

umask 077
echo "==> archiving /data (minus components/, logs/, the live sqlite files) and encrypting -> $OUT"
# The live agentforge.sqlite and its -wal/-shm are left out: the consistent copy in
# .backup-staging replaces them, and a half-written WAL beside a snapshot is what restore.sh avoids.
# Only the .backup-staging folder is taken from /stage, so the archive carries one `./` entry, not two:
# restore.sh extracts as root, and a second `./` would stamp the staging directory's mode onto /data.
tar -czf - \
	--exclude=./components --exclude=./logs --exclude=./.master-key \
	--exclude=./agentforge.sqlite --exclude=./agentforge.sqlite-wal --exclude=./agentforge.sqlite-shm \
	-C /data . \
	-C /stage .backup-staging |
	openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_KEY -out "$OUT"

[ -s "$OUT" ] || {
	echo "error: the encrypted archive is empty" >&2
	rm -f "$OUT"
	exit 1
}

# A backup nobody can open is not a backup: decrypt and list, into /dev/null.
echo "==> verifying (decrypt + list)"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_KEY -in "$OUT" | tar -tzf - >/dev/null || {
	echo "error: the encrypted archive did not decrypt and untar cleanly" >&2
	exit 1
}

RETAIN="${BACKUP_RETAIN_DAYS:-7}"
find "$OUT_DIR" -maxdepth 1 -name 'nultron-data-*.tar.gz.enc' -mtime "+$RETAIN" -delete 2>/dev/null || true

ls -l "$OUT"
echo "note: this archive stays on the backups volume. Shipping it to object storage (COS) is not done here:"
echo "      neither image carries coscli. A backup on the same cluster is not a backup against losing it."
