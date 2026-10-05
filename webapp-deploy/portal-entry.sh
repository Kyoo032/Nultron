#!/bin/sh
# The portal image's entrypoint wrapper: build the portal's two Postgres DSNs from the two passwords
# in the environment, then run whatever command it was given.
#
#   sh /app/webapp-deploy/portal-entry.sh ./node_modules/.bin/tsx src/main.ts
#
# Why it exists. The portal wants two DSNs (SR-56): the schema owner's, for migrations only, and
# `portal_app_login`'s, which the server runs as. They differ only in the role and the password, and
# the passwords already live in portal.env. Writing the DSNs there as well would give each password
# two homes, and a DSN that disagrees with its password is a boot failure at best. So the DSNs are
# built here, once, and the compose file, the one-shot portal-prepare step and the operator's
# `scripts/portal.sh seed ...` all go through the same lines.
#
# Env in:  PORTAL_POSTGRES_PASSWORD   the schema owner's password
#          PORTAL_APP_DB_PASSWORD     portal_app_login's password (portal-prepare sets it on the server)
#          PORTAL_DB_HOST, PORTAL_DB_PORT, PORTAL_DB_OWNER, PORTAL_DB_NAME   optional, for a managed
#                                     Postgres; they default to the compose service
set -eu

: "${PORTAL_POSTGRES_PASSWORD:?PORTAL_POSTGRES_PASSWORD is not set (portal.env)}"
: "${PORTAL_APP_DB_PASSWORD:?PORTAL_APP_DB_PASSWORD is not set (portal.env)}"

# A password goes into a URL, so it has to be URL-safe: letters, digits and -._~ only. `openssl rand
# -hex 24` is. Refuse anything else by NAME, never by value, rather than build a DSN that parses
# differently from the password it was made from.
for name in PORTAL_POSTGRES_PASSWORD PORTAL_APP_DB_PASSWORD; do
	eval "value=\${$name}"
	case "$value" in
	*[!A-Za-z0-9._~-]*)
		echo "portal-entry: $name may contain only letters, digits and . _ ~ - (it is placed in a URL). Generate one with: openssl rand -hex 24" >&2
		exit 1
		;;
	esac
done

host="${PORTAL_DB_HOST:-portal-db}"
port="${PORTAL_DB_PORT:-5432}"
owner="${PORTAL_DB_OWNER:-portal}"
name="${PORTAL_DB_NAME:-tokotoken_portal}"

PORTAL_MIGRATE_DATABASE_URL="postgres://${owner}:${PORTAL_POSTGRES_PASSWORD}@${host}:${port}/${name}"
PORTAL_DATABASE_URL="postgres://portal_app_login:${PORTAL_APP_DB_PASSWORD}@${host}:${port}/${name}"
export PORTAL_MIGRATE_DATABASE_URL PORTAL_DATABASE_URL

exec "$@"
