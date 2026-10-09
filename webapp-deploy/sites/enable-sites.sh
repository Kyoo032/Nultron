#!/bin/sh
# The proxy's entrypoint: decide which EXTRA sites this server hosts, then run the command it was given
# (compose.yml: `caddy run --config /etc/caddy/Caddyfile --adapter caddyfile`).
#
# Nultron's two names ({$NULTRON_DOMAIN} and {$PORTAL_DOMAIN}) are in the Caddyfile and are always served. The
# extra sites are not: each is one file in this folder (dpscloud.caddy, tokotoken.caddy), and it is switched on
# only when its domain variable is set to a hostname. Caddy has no "if", and a site block whose address is an
# empty variable is a hard error ("subject does not qualify for certificate"), so the choice is made here, before
# Caddy starts: an enabled site's file is copied into OUT_DIR, which the Caddyfile imports as a glob. With both
# variables unset OUT_DIR holds one comment-only file and the proxy's configuration is the Caddyfile's, byte for
# byte what it was before the extra sites existed.
#
# It also refuses, before anything starts:
#   - a hostname that is not a plain lower-case DNS name (no wildcard, no port, no space, no brace: the value is
#     substituted into the Caddyfile, so a stray `}` would be configuration, not a name);
#   - the same name in two variables (two site blocks for one address is a Caddy error, and a confusing one);
#   - a RESERVED host in any of the four variables, or a name under one. api.tokotokenai.com is the live model
#     gateway, hosted elsewhere. This server must never answer for it, and a typo in a DNS record or an env file
#     must not be able to turn into a certificate request or a served page for it. The Caddyfile has no wildcard
#     and no catch-all site either; this check is the second guard.
# NULTRON_DOMAIN and PORTAL_DOMAIN get the reserved-host rule ONLY: their syntax is not this script's business,
# and a deploy that starts today must still start.
#
# POSIX sh (the caddy image is Alpine / busybox). Tested by scripts/multisite-edge.test.mjs.
set -eu

SITES_DIR="${SITES_DIR:-/etc/caddy/sites}"
OUT_DIR="${SITES_OUT_DIR:-/tmp/sites-enabled}"
RESERVED_HOSTS="${RESERVED_HOSTS:-api.tokotokenai.com}"

refuse() {
  echo "enable-sites: $*" >&2
  exit 1
}

# Is $1, in any letter case, a reserved host, a name under one, or a name whose www. form is one?
reserved() {
  candidate=$(printf '%s' "$1" | tr 'A-Z' 'a-z')
  for host in $RESERVED_HOSTS; do
    case "$candidate" in
      "$host" | *".$host") return 0 ;;
    esac
    [ "www.$candidate" = "$host" ] && return 0
  done
  return 1
}

# A plain DNS name: lower-case letters, digits and hyphens in dot-separated labels, at least two labels.
valid_host() {
  [ "${#1}" -le 253 ] || return 1
  printf '%s\n' "$1" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
}

# Nultron's own two names: only the reserved-host rule applies.
check_nultron_name() {
  if [ -n "$2" ] && reserved "$2"; then
    refuse "$1=$2 is reserved: that host is served elsewhere and must never be served from this proxy"
  fi
}
check_nultron_name NULTRON_DOMAIN "${NULTRON_DOMAIN:-}"
check_nultron_name PORTAL_DOMAIN "${PORTAL_DOMAIN:-}"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

seen=" ${NULTRON_DOMAIN:-} ${PORTAL_DOMAIN:-} "
enabled=""

# enable_site <file stem> <variable name> <its value>
enable_site() {
  stem="$1"
  var="$2"
  value="$3"
  if [ -z "$value" ]; then
    echo "enable-sites: $stem is off ($var is not set)" >&2
    return 0
  fi
  valid_host "$value" || refuse "$var=$value is not a plain lower-case hostname (no wildcard, port, scheme or space; at least two labels)"
  reserved "$value" && refuse "$var=$value is reserved: that host is served elsewhere and must never be served from this proxy"
  case "$seen" in
    *" $value "* | *" www.$value "*) refuse "$var=$value is already used by another site on this proxy" ;;
  esac
  [ -f "$SITES_DIR/$stem.caddy" ] || refuse "$SITES_DIR/$stem.caddy is missing, so $var cannot be served"
  cp "$SITES_DIR/$stem.caddy" "$OUT_DIR/$stem.caddy"
  seen="$seen$value www.$value "
  enabled="$enabled $stem"
  echo "enable-sites: $stem is on ($value, www.$value)" >&2
}

enable_site dpscloud DPS_DOMAIN "${DPS_DOMAIN:-}"
enable_site tokotoken TOKOTOKEN_DOMAIN "${TOKOTOKEN_DOMAIN:-}"

# Always one file, so the Caddyfile's glob always matches (an empty glob is a warning on every start).
printf '# Generated at start by enable-sites.sh. Extra sites enabled:%s\n' "${enabled:- none}" >"$OUT_DIR/00-enabled.caddy"

[ "$#" -gt 0 ] || refuse "no command to run"
exec "$@"
