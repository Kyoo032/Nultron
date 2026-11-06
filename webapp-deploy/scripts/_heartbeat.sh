#!/usr/bin/env sh

heartbeat_ping() {
	_hb_base="${1:-}"
	_hb_rc="${2:-0}"
	[ -n "$_hb_base" ] || return 0
	command -v curl >/dev/null 2>&1 || return 0
	case "$_hb_base" in
		http://* | https://*) ;;
		*) return 0 ;;
	esac
	case "$_hb_base" in
		*[[:space:]\"\\]*) return 0 ;;
	esac
	_hb_base="${_hb_base%/}"
	if [ "$_hb_rc" = "0" ]; then
		_hb_url="$_hb_base"
	else
		_hb_url="$_hb_base/fail"
	fi
	printf 'url = "%s"\n' "$_hb_url" |
		curl -q -s --globoff -o /dev/null --max-time 10 --retry 2 --retry-max-time 20 -K - >/dev/null 2>&1 || true
	return 0
}
