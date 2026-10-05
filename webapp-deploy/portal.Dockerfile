# syntax=docker/dockerfile:1.7
#
# The portal stand-in (apps/portal) as its own image: ghcr.io/kyoo032/nultron-portal:<tag>, private,
# built by scripts/release-web.mjs from the same `git archive <sha>` as the app image, and run by the
# pilot compose stack (webapp-deploy/compose.yml) and the Kubernetes rehearsal (webapp-deploy/k8s).
#
# Build context is the REPO ROOT, like the app image's:
#   docker build -f webapp-deploy/portal.Dockerfile -t nultron-portal:local .
#
# WHY A SECOND IMAGE. The app image (webapp-deploy/Dockerfile) installs
# `pnpm install --filter "@agentforge/web..."`, and the portal is not a dependency of the web app by
# design (apps/portal/README.md: nothing in the product imports it). So the app image carries
# apps/portal's TypeScript source (SR-49) but not its node_modules: `pg` and `nodemailer` are absent
# and `tsx src/main.ts` cannot start. Running the portal from the app image does not work
# (ERR_MODULE_NOT_FOUND: nodemailer, proven by the Kubernetes rehearsal, 2026-10-01).
#
# WHAT ENTERS THE IMAGE is decided by portal.Dockerfile.dockerignore, an ALLOWLIST next to this file
# (BuildKit reads `<dockerfile>.dockerignore` before any other ignore file): the workspace manifests,
# apps/portal, docs/internal/portal/migrations (the portal runs those SQL files by path at boot) and
# the two small scripts the stack runs inside it (portal-entry.sh, k8s/base/scripts/prepare-db.mjs),
# and nothing else. No desktop shell, no host source, no docs/internal notes, no local state. The
# release path never builds from a checkout anyway (release-web.mjs archives <sha> first), and the
# allowlist is the second guard (SR-49) for anyone who runs the line above by hand.

ARG NODE_VERSION=22-bookworm-slim
ARG PNPM_VERSION=9.15.9

FROM node:${NODE_VERSION} AS base
ARG PNPM_VERSION
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_HOME=/opt/corepack \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate \
 && chmod -R a+rX /opt/corepack

FROM base AS build
WORKDIR /app
COPY . .
# The portal and the workspace packages it names. tsx is a devDependency of apps/portal and is the
# entrypoint, so this image still ships its dev dependencies. The app image no longer does (SR-113: its
# `prod` stage installs --prod); this image is not part of that gate or of scripts/audit-deployed.mjs.
RUN pnpm install --frozen-lockfile --filter "@agentforge/portal..."

FROM base AS runtime
ENV NODE_ENV=production \
    PORTAL_HOST=0.0.0.0 \
    PORTAL_PORT=4000 \
    PORTAL_DATA_DIR=/portal-data \
    TMPDIR=/tmp
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /portal-data && chown node:node /portal-data
USER node
WORKDIR /app/apps/portal
EXPOSE 4000
# `GET /healthz` is the portal's own liveness route (apps/portal/src/server.ts HEALTH_PATH).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORTAL_PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["./node_modules/.bin/tsx", "src/main.ts"]
