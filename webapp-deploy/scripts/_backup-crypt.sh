#!/usr/bin/env sh
# Backup cipher helpers. Sourced by _common.sh, so every deploy script has them; nothing here
# touches docker, so the backup tests source this file directly on any host.
#
# Two ciphers reach the restore path:
#   gcm    NAEAD001...  chunked AES-256-GCM written by aead-crypt.mjs (SR-171, security spec S6):
#          every backup since. Authentication is proven over the whole ciphertext before any
#          plaintext is trusted.
#   cbc    Salted__...  legacy `openssl enc -aes-256-cbc -pbkdf2`, backups from before SR-171.
#          Unauthenticated; kept so those backups still restore.
# Anything else is a plain archive: restore.sh takes it as it always has, restore-portal.sh
# refuses it because backup.sh never writes one.

# Which cipher a backup uses, told by its first 8 bytes and never by its name: a fresh backup is
# GCM whatever it is called, and a .enc older than SR-171 is CBC. Both magics are printable ASCII,
# so command substitution carries them whole.
backup_format() {
	_magic="$(head -c 8 "$1" 2>/dev/null || true)"
	case "$_magic" in
	NAEAD001) printf 'gcm' ;;
	Salted__) printf 'cbc' ;;
	*) printf 'plain' ;;
	esac
}

# Decrypt $1 into $2, where $3 is the format backup_format read and $4 the aead-crypt.mjs path.
# Exits non-zero on any failure and no trustworthy plaintext is left behind: a GCM verification
# failure deletes the half-written output inside aead-crypt.mjs itself, and a CBC file that does
# not decode to the end exits non-zero. The caller checks the status BEFORE going near live data,
# and decides about plain input itself; it never reaches this function.
backup_decrypt() {
	_in="$1"
	_out="$2"
	_format="$3"
	_aead="$4"
	case "$_format" in
	gcm)
		node "$_aead" decrypt --in "$_in" --out "$_out"
		;;
	cbc)
		openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_KEY -in "$_in" -out "$_out"
		;;
	*)
		echo "error: backup_decrypt does not handle format '$_format'" >&2
		return 2
		;;
	esac
}
