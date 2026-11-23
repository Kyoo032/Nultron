#!/usr/bin/env sh
# Run one of the portal's operator scripts (apps/portal/scripts/<name>.ts) inside the running portal
# container, with the same database settings the portal itself runs with.
#
#   sh webapp-deploy/scripts/portal.sh seed --email you@example.com --redirect https://app.example.com/auth/callback
#   sh webapp-deploy/scripts/portal.sh invite ...        # whatever scripts apps/portal ships
#   sh webapp-deploy/scripts/portal.sh account create --username <name> --email <address>
#                                        # PORTAL_SIGNIN_MODE=password only: create | reset-password | disable | enable | set-role | list
#   sh webapp-deploy/scripts/portal.sh migrate
#
# <name> is the file name without .ts. The two Postgres DSNs are built by portal-entry.sh from the
# passwords in portal.env, exactly as for the portal's own start, which is why this goes through the
# container and not through `psql` or a host Node: no password is ever typed or exported on the host.
#
# Not offered: `otp`. It mints a sign-in code for an operator to read out, needs
# PORTAL_ALLOW_MANUAL_OTP=1, and the production portal refuses to boot with that set (SR-10).
set -eu
. "$(dirname "$0")/_common.sh"

NAME="${1:-}"
if [ -z "$NAME" ]; then
	echo "usage: sh portal.sh <script> [args...]    (a file in apps/portal/scripts, without .ts)" >&2
	exit 2
fi
shift

case "$NAME" in
*[!a-z0-9-]*)
	echo "error: '$NAME' is not a script name (lowercase letters, digits and - only)" >&2
	exit 2
	;;
otp)
	echo "error: otp is not available on a production portal (SR-10). Invite testers instead." >&2
	exit 2
	;;
esac

if [ -z "$(dc ps -q portal)" ]; then
	echo "error: the portal container is not running. Start it with: docker compose up -d portal" >&2
	exit 1
fi

# -T: no TTY, so output can be redirected and this works from a script.
dc exec -T portal sh /app/webapp-deploy/portal-entry.sh node "dist/scripts/$NAME.mjs" "$@"
