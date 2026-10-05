#!/usr/bin/env sh
# Build the app and portal images from the repo root. Does not touch the running deployment.
#
#   sh webapp-deploy/scripts/build.sh [extra docker-compose build args]
set -eu
. "$(dirname "$0")/_common.sh"

echo "==> building nultron-web and nultron-portal from $REPO_ROOT (sha $(current_sha))"
dc build "$@" app portal

echo "==> images"
docker image inspect nultron-web:local nultron-portal:local --format '{{.RepoTags}}  {{.Size}} bytes  created {{.Created}}'
