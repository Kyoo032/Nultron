#!/usr/bin/env sh
# Pull, check, rebuild, restart, wait for health, record the sha. A failed check puts the previous images back.
#
#   sh webapp-deploy/scripts/deploy.sh [--no-pull]
#
# The deploy gate (webapp-deploy/README.md, "Deploy gate"):
#   1. Preflight, offline, before anything is switched: scripts/deploy-preflight.mjs, then `docker compose config`.
#   2. The running app and portal images are kept as <repo>:previous, before the build overwrites :local.
#   3. After `up -d`: the app's healthcheck (GET /healthz, the HEALTHCHECK in webapp-deploy/Dockerfile), the
#      portal's healthcheck, then GET https://$NULTRON_DOMAIN/healthz through Caddy.
#   4. A failure in 3 rolls back: :previous goes back to :local and the stack is recreated from it, with no build.
#      Images only. A schema migration that already ran is not undone.
#
# Secrets (security spec S2/S6): with USE_SSM=1 the wrap key and the backup passphrase
# come from Tencent Cloud Secrets Manager, fetched with the CVM's instance role. They
# are exported for THIS process only and handed to compose through the interpolation
# in compose.yml. They are never written to .env, into the image, or into git.
set -eu
. "$(dirname "$0")/_common.sh"

require_env_file
require_portal_env_file

PULL=1
for arg in "$@"; do
	case "$arg" in
	--no-pull) PULL=0 ;;
	*)
		echo "unknown argument: $arg" >&2
		exit 2
		;;
	esac
done

# --- secrets ---------------------------------------------------------------

USE_SSM="$(setting USE_SSM 0)"
SSM_REGION="$(setting TENCENT_REGION ap-jakarta)"
SSM_STAGE="$(setting SSM_VERSION_STAGE SSMCurrent)"
# Most tccli builds spell the action in CamelCase (GetSecretValue); the dashed form
# below works on current ones. Override with SSM_ACTION= if yours disagrees.
SSM_ACTION="${SSM_ACTION:-get-secret-value}"

# Print the plaintext of one secret. Nothing is echoed to the log on the way.
ssm_read() {
	_secret_name="$1"
	tccli ssm "$SSM_ACTION" \
		--region "$SSM_REGION" \
		--SecretName "$_secret_name" \
		--VersionStage "$SSM_STAGE" |
		python3 -c 'import json,sys; print(json.load(sys.stdin).get("SecretString",""), end="")'
}

if [ "$USE_SSM" = "1" ]; then
	command -v tccli >/dev/null 2>&1 || {
		echo "error: USE_SSM=1 but tccli is not installed on this host" >&2
		exit 1
	}
	command -v python3 >/dev/null 2>&1 || {
		echo "error: USE_SSM=1 needs python3 to read the tccli JSON" >&2
		exit 1
	}

	WRAP_SECRET="$(setting SSM_SECRET_AGENTFORGE_SECRETS_KEY)"
	BACKUP_SECRET="$(setting SSM_SECRET_BACKUP_KEY)"
	[ -n "$WRAP_SECRET" ] || {
		echo "error: SSM_SECRET_AGENTFORGE_SECRETS_KEY is not set" >&2
		exit 1
	}

	echo "==> fetching secrets from Secrets Manager ($SSM_REGION, instance role)"
	AGENTFORGE_SECRETS_KEY="$(ssm_read "$WRAP_SECRET")"
	[ -n "$AGENTFORGE_SECRETS_KEY" ] || {
		echo "error: $WRAP_SECRET came back empty" >&2
		exit 1
	}
	export AGENTFORGE_SECRETS_KEY

	if [ -n "$BACKUP_SECRET" ]; then
		BACKUP_KEY="$(ssm_read "$BACKUP_SECRET")"
		export BACKUP_KEY
	fi
	echo "==> secrets loaded into this process only (not written to disk)"

	if grep -Eq '^[[:space:]]*AGENTFORGE_SECRETS_KEY[[:space:]]*=[[:space:]]*[^[:space:]]' "$ENV_FILE"; then
		echo "warning: AGENTFORGE_SECRETS_KEY still has a value in .env; spec S2 wants it empty on the server" >&2
	fi
fi

# --- gate helpers ----------------------------------------------------------

# The node image the preflight runs in when this host has no node. Same major line as the NODE_VERSION default in
# webapp-deploy/Dockerfile.
PREFLIGHT_IMAGE="${PREFLIGHT_IMAGE:-node:22-bookworm-slim}"

# The offline preflight (scripts/deploy-preflight.mjs), with the host's node when there is one, or a throwaway node
# container with no network when there is not. The same script reads the same files either way. Only the one secret
# the deploy takes from the shell is only checked for presence: the container gets the word "set" or nothing, never
# the key itself.
run_preflight() {
	_env="${ENV_FILE#"$REPO_ROOT"/}"
	_portal_env="${PORTAL_ENV_FILE#"$REPO_ROOT"/}"
	_compose="${COMPOSE_FILE#"$REPO_ROOT"/}"
	if command -v node >/dev/null 2>&1; then
		(cd "$REPO_ROOT" && node scripts/deploy-preflight.mjs --env "$_env" --portal-env "$_portal_env" --compose "$_compose")
	else
		echo "note: node is not on this host, so the preflight runs in $PREFLIGHT_IMAGE with no network" >&2
		_key_present=""
		[ -n "${AGENTFORGE_SECRETS_KEY:-}" ] && _key_present="set"
		docker run --rm --network none -v "$REPO_ROOT:/repo:ro" -w /repo -e "AGENTFORGE_SECRETS_KEY=$_key_present" \
			"$PREFLIGHT_IMAGE" node scripts/deploy-preflight.mjs --env "$_env" --portal-env "$_portal_env" --compose "$_compose"
	fi
}

# Keeps the image a running container was made from under <repo>:previous, and prints that tag. Prints nothing when
# there is no such container, which is a first deploy. The build overwrites :local, so this tag is the only way back.
keep_previous_image() {
	_cid="$1"
	[ -n "$_cid" ] || return 0
	_image_id="$(docker inspect --format '{{.Image}}' "$_cid")"
	_ref="$(docker inspect --format '{{.Config.Image}}' "$_cid")"
	_previous="${_ref%:*}:previous"
	docker image tag "$_image_id" "$_previous"
	printf '%s' "$_previous"
}

# Points :local back at the images the running containers were made from. A build that fails part way may already
# have moved :local, and then :local would name a build that nothing runs.
restore_local_tags() {
	if [ -n "$PREV_APP" ]; then
		docker image tag "$PREV_APP" "${PREV_APP%:previous}:local" ||
			echo "warning: could not point ${PREV_APP%:previous}:local back at the previous app image" >&2
	fi
	if [ -n "$PREV_PORTAL" ]; then
		docker image tag "$PREV_PORTAL" "${PREV_PORTAL%:previous}:local" ||
			echo "warning: could not point ${PREV_PORTAL%:previous}:local back at the previous portal image" >&2
	fi
}

# Polls one container until Docker reports it healthy. Returns 1 at once when it reports unhealthy, has exited, or is
# restarting or restarting more often than it did at the first poll. A boot refusal (SR-04, packages/host/src/hosted-env.ts)
# lands in that last case under `restart: unless-stopped`, and it never reaches healthy. Prints the service logs on failure.
#   wait_healthy <container id> <tries> <label> <service>...
wait_healthy() {
	_cid="$1"
	_tries="$2"
	_label="$3"
	shift 3
	_services="$*"
	_base=""
	_last="unknown"
	_i=0
	while [ "$_i" -lt "$_tries" ]; do
		_line="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.State.Status}} {{.RestartCount}}' "$_cid" 2>/dev/null || true)"
		[ -n "$_line" ] || break
		_health="${_line%% *}"
		_rest="${_line#* }"
		_state="${_rest%% *}"
		_restarts="${_rest#* }"
		[ -n "$_base" ] || _base="$_restarts"
		_last="$_health, $_state, $_restarts restarts"
		if [ "$_restarts" -gt "$_base" ] || [ "$_state" = restarting ] || [ "$_state" = exited ] || [ "$_state" = dead ]; then
			break
		fi
		case "$_health" in
		healthy) return 0 ;;
		unhealthy) break ;;
		esac
		_i=$((_i + 1))
		sleep 5
	done
	echo "error: $_label did not go healthy (last: $_last)" >&2
	# shellcheck disable=SC2086
	dc logs --tail 80 $_services >&2 || true
	return 1
}

# GET /healthz on the app's own name, through the proxy, the way a person's browser reaches it. The name is pointed at
# loopback, so the probe needs no DNS and no hairpin, and the certificate is still checked against the name. curl is
# optional on the host: without it this step is skipped with a warning, and the container's own /healthz is the check.
probe_public() {
	_domain="$1"
	_tries="${DEPLOY_PUBLIC_PROBE_TRIES:-12}"
	if ! command -v curl >/dev/null 2>&1; then
		echo "warning: curl is not installed, so https://$_domain/healthz was not probed through the proxy." >&2
		echo "         The app's own /healthz passed, and that is all that was checked." >&2
		return 0
	fi
	_i=1
	while :; do
		_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$_domain:443:127.0.0.1" "https://$_domain/healthz" || true)"
		[ "$_code" = "200" ] && return 0
		[ "$_i" -ge "$_tries" ] && break
		_i=$((_i + 1))
		sleep 5
	done
	echo "error: https://$_domain/healthz did not answer 200 through the proxy (last: ${_code:-no answer})" >&2
	return 1
}

# Puts the images from before this deploy back under :local and recreates the stack from them, with no build. Never
# returns: the deploy did not land, so the exit status is 1 whatever the rollback does. Images only. No database is
# restored, and a migration that already ran stays applied (webapp-deploy/README.md, "Back up first when the deploy
# carries a migration").
rollback() {
	echo "error: $1" >&2
	if [ -z "$PREV_APP" ]; then
		echo "error: there is no previous app image to go back to (a first deploy has none). Nothing was rolled back." >&2
		echo "       The stack is as the failed step left it. Fix the error above and run again." >&2
		exit 1
	fi
	echo "==> rolling back to the images from before this deploy" >&2
	if [ -z "$PREV_PORTAL" ]; then
		echo "warning: the portal had no previous image, so it stays on the new one" >&2
	fi
	restore_local_tags
	# The proxy shares the app's network namespace (compose.yml), so it is recreated with the app, never on its own.
	if ! dc up -d --no-build --force-recreate app proxy portal; then
		echo "error: the rollback itself did not start. Run: docker compose -f $COMPOSE_FILE ps" >&2
		exit 1
	fi
	RB_CID="$(app_container)"
	if [ -n "$RB_CID" ] && wait_healthy "$RB_CID" 60 "the rolled-back app" app; then
		echo "==> rolled back: the previous app is healthy again. This deploy did NOT land." >&2
	else
		echo "error: the rolled-back app is not healthy either. The site may be down. Run: dc logs app" >&2
	fi
	exit 1
}

# --- deploy ----------------------------------------------------------------

if [ "$PULL" -eq 1 ]; then
	echo "==> git pull --ff-only"
	git -C "$REPO_ROOT" pull --ff-only
fi

SHA="$(current_sha)"
echo "==> deploying $SHA"

PREV_APP=""
PREV_PORTAL=""

# Gate 1: nothing is switched until the preflight and the compose parse both pass.
echo "==> preflight (offline; nothing is switched yet)"
if ! run_preflight; then
	echo "error: the preflight refused this deploy. Nothing was switched. Fix the lines above and run again." >&2
	exit 1
fi
echo "==> docker compose config"
if ! dc config -q >/dev/null; then
	echo "error: docker compose cannot read $COMPOSE_FILE. Nothing was switched." >&2
	exit 1
fi

# Gate 2: keep what is running, because the build below replaces :local.
PREV_APP="$(keep_previous_image "$(app_container)")"
PREV_PORTAL="$(keep_previous_image "$(dc ps -q portal)")"
if [ -n "$PREV_APP" ]; then
	echo "==> kept the running images as $PREV_APP and ${PREV_PORTAL:-(no portal image yet)}"
fi

echo "==> build"
if ! dc build app portal; then
	restore_local_tags
	echo "error: the build failed. The running stack was not touched." >&2
	exit 1
fi

echo "==> up -d"
if ! dc up -d; then
	rollback "docker compose up -d failed"
fi

# Gate 3: the app's healthcheck, then the portal's, then the public /healthz through the proxy.
echo "==> waiting for the app healthcheck (GET /healthz, up to 5 minutes)"
CID="$(app_container)"
[ -n "$CID" ] || rollback "the app container did not start"
wait_healthy "$CID" 60 "the app" app || rollback "the app did not go healthy"
echo "==> app healthy"

# The portal is the other half of sign-in: an app that is healthy while the portal is not can serve
# the page and nobody can get past it. Its health check covers /healthz, which needs the database.
echo "==> waiting for the portal healthcheck (up to 3 minutes)"
PCID="$(dc ps -q portal)"
[ -n "$PCID" ] || rollback "the portal container did not start"
wait_healthy "$PCID" 36 "the portal" portal portal-prepare || rollback "the portal did not go healthy"
echo "==> portal healthy"

NULTRON_DOMAIN="$(setting NULTRON_DOMAIN)"
echo "==> probing https://$NULTRON_DOMAIN/healthz through the proxy"
probe_public "$NULTRON_DOMAIN" || rollback "the public /healthz did not answer through the proxy"
echo "==> public /healthz answered 200"

# --- record ----------------------------------------------------------------
# Spec H4: the running sha is recorded per deploy.

WHO="$(setting DEPLOY_WHO "$(id -un 2>/dev/null || echo unknown)")"
NOTES="${DEPLOY_NOTES:-}"
ROW="| $(date -u '+%Y-%m-%d %H:%M') | $SHA | prod | $WHO | $NOTES |"
printf '%s\n' "$ROW" >>"$DEPLOY_DIR/DEPLOY-LOG.md"

echo
echo "deployed sha: $SHA"
echo "appended to webapp-deploy/DEPLOY-LOG.md:"
echo "$ROW"
echo
echo "the images from before this deploy stay under :previous until the next deploy (README, Restore / roll back)"
echo "copy the same row into the deploy log in docs/internal/web-pivot-2026-09-18.md"
echo "(the decision record is the one of record)."
